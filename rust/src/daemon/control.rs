use crate::daemon::{client, paths};
use crate::types::{DaemonAction, DaemonRequest};
use anyhow::Result;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use tokio::time::{sleep, Duration};

pub async fn start_daemon() -> Result<Value> {
    if client::is_daemon_running().await {
        return Ok(json!({ "started": false, "socket": socket_display()? }));
    }
    std::fs::create_dir_all(paths::runtime_dir()?)?;
    let current_exe = std::env::current_exe()?;
    let mut command = Command::new(current_exe);
    command
        .arg("daemon")
        .arg("run")
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    if std::env::var("AGENT_DATABASE_CLI_DEBUG").is_ok() {
        command.stderr(Stdio::inherit());
    } else {
        command.stderr(Stdio::null());
    }
    detach_command(&mut command);
    command.spawn()?;

    for _ in 0..30 {
        sleep(Duration::from_millis(100)).await;
        if client::is_daemon_running().await {
            return Ok(json!({ "started": true, "socket": socket_display()? }));
        }
    }
    anyhow::bail!("daemon startup timed out")
}

pub async fn stop_daemon() -> Result<Value> {
    let response = client::send_daemon_request(&DaemonRequest {
        action: DaemonAction::Stop,
        db: None,
        command: None,
        metadata: None,
        config_path: None,
    })
    .await?;
    if !response.ok {
        anyhow::bail!(response
            .error
            .unwrap_or_else(|| "failed to stop daemon".to_string()));
    }
    Ok(json!({ "stopped": true }))
}

pub async fn daemon_status() -> Result<Value> {
    let response = match client::send_daemon_request(&DaemonRequest {
        action: DaemonAction::Status,
        db: None,
        command: None,
        metadata: None,
        config_path: None,
    })
    .await
    {
        Ok(response) => response,
        Err(_) => {
            return Ok(json!({
                "running": false,
                "connections": []
            }));
        }
    };
    if !response.ok {
        anyhow::bail!(response
            .error
            .unwrap_or_else(|| "failed to query daemon status".to_string()));
    }
    Ok(with_running_flag(
        response.data.unwrap_or_else(|| json!({})),
        true,
    ))
}

fn with_running_flag(data: Value, running: bool) -> Value {
    match data {
        Value::Object(mut object) => {
            object.insert("running".to_string(), json!(running));
            Value::Object(object)
        }
        _ => json!({
            "running": running,
            "data": data
        }),
    }
}

/// Detach the about-to-be-spawned daemon from the launcher so it cannot keep
/// the launcher's inherited stdio handles open. Without this, a caller that
/// pipes the CLI's stdout (e.g. `out=$(agent-database-cli ...)`) hangs on a
/// cold start: the daemon inherits the launcher's pipe and the reader never
/// sees EOF until the daemon idle-exits.
#[cfg(windows)]
fn detach_command(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // DETACHED_PROCESS: no inherited console. CREATE_NO_WINDOW: no console
    // window. CREATE_NEW_PROCESS_GROUP: independent signal group.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);

    // Creation flags alone do NOT stop handle inheritance: Rust spawns with
    // bInheritHandles=TRUE, so the daemon would inherit this process's stdout
    // handle. If the caller piped our stdout (e.g. `out=$(agent-database-cli
    // ...)`), it would then block on EOF until the daemon idle-exits. Clear the
    // inherit flag on our std handles so the daemon cannot keep them open.
    // stderr is left inheritable in debug mode so daemon logs can surface.
    let keep_stderr = std::env::var("AGENT_DATABASE_CLI_DEBUG").is_ok();
    unsafe {
        clear_std_handle_inheritance(keep_stderr);
    }
}

#[cfg(windows)]
unsafe fn clear_std_handle_inheritance(keep_stderr: bool) {
    type Handle = *mut core::ffi::c_void;
    const STD_INPUT_HANDLE: u32 = -10i32 as u32;
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
    const INVALID_HANDLE_VALUE: isize = -1;
    extern "system" {
        fn GetStdHandle(n_std_handle: u32) -> Handle;
        fn SetHandleInformation(h_object: Handle, dw_mask: u32, dw_flags: u32) -> i32;
    }
    let mut ids = vec![STD_INPUT_HANDLE, STD_OUTPUT_HANDLE];
    if !keep_stderr {
        ids.push(STD_ERROR_HANDLE);
    }
    for id in ids {
        let handle = GetStdHandle(id);
        if !handle.is_null() && handle as isize != INVALID_HANDLE_VALUE {
            // Best-effort: ignore failures (e.g. console handles).
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
        }
    }
}

#[cfg(unix)]
fn detach_command(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // setsid() puts the daemon in its own session with no controlling terminal,
    // so it does not retain the launcher's stdio.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

fn socket_display() -> Result<String> {
    #[cfg(unix)]
    {
        Ok(paths::socket_path()?.display().to_string())
    }
    #[cfg(windows)]
    {
        paths::socket_path_string()
    }
}

#[cfg(test)]
mod tests {
    use super::with_running_flag;
    use serde_json::json;

    #[test]
    fn status_data_keeps_connections_and_adds_running_flag() {
        let data = with_running_flag(json!({ "connections": [] }), true);

        assert_eq!(data, json!({ "running": true, "connections": [] }));
    }
}
