use crate::daemon::config_manager::DaemonConfigManager;
use crate::types::{DaemonAction, DaemonRequest, DaemonResponse};
use crate::utils::masking::to_error_message;
use anyhow::Result;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration, Instant};

#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

const DAEMON_IDLE_SECONDS: u64 = 300;

pub async fn run_server() -> Result<()> {
    #[cfg(unix)]
    {
        let runtime_dir = crate::daemon::paths::runtime_dir()?;
        tokio::fs::create_dir_all(&runtime_dir).await?;
        let socket_path = crate::daemon::paths::socket_path()?;
        let _ = tokio::fs::remove_file(&socket_path).await;
        let listener = UnixListener::bind(&socket_path)?;
        let pid_path = crate::daemon::paths::pid_path()?;
        tokio::fs::write(&pid_path, std::process::id().to_string()).await?;

        let manager = Arc::new(Mutex::new(DaemonConfigManager::new()));
        let last_activity = Arc::new(Mutex::new(Instant::now()));
        spawn_idle_shutdown(
            manager.clone(),
            last_activity.clone(),
            socket_path.clone(),
            pid_path.clone(),
        );

        loop {
            let (stream, _) = listener.accept().await?;
            let manager = manager.clone();
            let last_activity = last_activity.clone();
            tokio::spawn(async move {
                let _ = handle_stream(stream, manager, last_activity).await;
            });
        }
    }
    #[cfg(windows)]
    {
        let runtime_dir = crate::daemon::paths::runtime_dir()?;
        tokio::fs::create_dir_all(&runtime_dir).await?;
        let pipe_name = crate::daemon::paths::socket_path_string()?;
        let pid_path = crate::daemon::paths::pid_path()?;
        tokio::fs::write(&pid_path, std::process::id().to_string()).await?;

        let manager = Arc::new(Mutex::new(DaemonConfigManager::new()));
        let last_activity = Arc::new(Mutex::new(Instant::now()));
        spawn_idle_shutdown(manager.clone(), last_activity.clone(), pid_path.clone());

        loop {
            let server = ServerOptions::new().create(&pipe_name)?;
            server.connect().await?;
            let manager = manager.clone();
            let last_activity = last_activity.clone();
            tokio::spawn(async move {
                let _ = handle_stream(server, manager, last_activity).await;
            });
        }
    }
}

#[cfg(unix)]
async fn handle_stream(
    stream: UnixStream,
    manager: Arc<Mutex<DaemonConfigManager>>,
    last_activity: Arc<Mutex<Instant>>,
) -> Result<()> {
    handle_duplex_stream(stream, manager, last_activity).await
}

#[cfg(windows)]
async fn handle_stream(
    stream: NamedPipeServer,
    manager: Arc<Mutex<DaemonConfigManager>>,
    last_activity: Arc<Mutex<Instant>>,
) -> Result<()> {
    handle_duplex_stream(stream, manager, last_activity).await
}

async fn handle_duplex_stream<S>(
    stream: S,
    manager: Arc<Mutex<DaemonConfigManager>>,
    last_activity: Arc<Mutex<Instant>>,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    *last_activity.lock().await = Instant::now();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let response = match serde_json::from_str::<DaemonRequest>(line.trim()) {
        Ok(request) => match handle_request(request, manager).await {
            Ok(data) => DaemonResponse {
                ok: true,
                data: Some(data),
                error: None,
            },
            Err(error) => DaemonResponse {
                ok: false,
                data: None,
                error: Some(to_error_message(&error)),
            },
        },
        Err(error) => DaemonResponse {
            ok: false,
            data: None,
            error: Some(error.to_string()),
        },
    };
    *last_activity.lock().await = Instant::now();
    let mut stream = reader.into_inner();
    stream
        .write_all(serde_json::to_string(&response)?.as_bytes())
        .await?;
    stream.write_all(b"\n").await?;
    Ok(())
}

async fn handle_request(
    request: DaemonRequest,
    manager: Arc<Mutex<DaemonConfigManager>>,
) -> Result<Value> {
    match request.action {
        DaemonAction::Status => Ok(manager.lock().await.status()),
        DaemonAction::Stop => {
            tokio::spawn(async {
                sleep(Duration::from_millis(20)).await;
                std::process::exit(0);
            });
            Ok(json!({ "stopped": true }))
        }
        DaemonAction::Test
        | DaemonAction::Execute
        | DaemonAction::Metadata
        | DaemonAction::Reset => {
            let db = request
                .db
                .ok_or_else(|| anyhow::anyhow!("daemon 请求必须提供 db"))?;
            let mut guard = manager.lock().await;
            let current = guard.get_manager(request.config_path).await?;
            match request.action {
                DaemonAction::Test => current.test(&db).await,
                DaemonAction::Execute => {
                    let command = request
                        .command
                        .ok_or_else(|| anyhow::anyhow!("execute 请求必须提供 command"))?;
                    Ok(serde_json::to_value(current.execute(&db, &command).await?)?)
                }
                DaemonAction::Metadata => {
                    let metadata = request
                        .metadata
                        .ok_or_else(|| anyhow::anyhow!("metadata 请求必须提供 metadata"))?;
                    Ok(serde_json::to_value(
                        current.metadata(&db, metadata).await?,
                    )?)
                }
                DaemonAction::Reset => current.reset(&db).await,
                _ => unreachable!(),
            }
        }
    }
}

#[cfg(unix)]
fn spawn_idle_shutdown(
    manager: Arc<Mutex<DaemonConfigManager>>,
    last_activity: Arc<Mutex<Instant>>,
    socket_path: std::path::PathBuf,
    pid_path: std::path::PathBuf,
) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(5)).await;
            let mut guard = manager.lock().await;
            let _ = guard.cleanup_idle().await;
            let idle_for = Instant::now().duration_since(*last_activity.lock().await);
            if idle_for >= Duration::from_secs(DAEMON_IDLE_SECONDS) {
                let _ = guard.close_all().await;
                let _ = tokio::fs::remove_file(&socket_path).await;
                let _ = tokio::fs::remove_file(&pid_path).await;
                std::process::exit(0);
            }
        }
    });
}

#[cfg(windows)]
fn spawn_idle_shutdown(
    manager: Arc<Mutex<DaemonConfigManager>>,
    last_activity: Arc<Mutex<Instant>>,
    pid_path: std::path::PathBuf,
) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(5)).await;
            let mut guard = manager.lock().await;
            let _ = guard.cleanup_idle().await;
            let idle_for = Instant::now().duration_since(*last_activity.lock().await);
            if idle_for >= Duration::from_secs(DAEMON_IDLE_SECONDS) {
                let _ = guard.close_all().await;
                let _ = tokio::fs::remove_file(&pid_path).await;
                std::process::exit(0);
            }
        }
    });
}
