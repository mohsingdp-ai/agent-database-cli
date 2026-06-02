use crate::config::{list_supported_databases, load_config, resolve_config_path};
use crate::daemon::{client::send_daemon_request, control::start_daemon};
use crate::types::{DaemonAction, DaemonRequest, MetadataRequest, QueryResult};
use anyhow::Result;
use serde_json::{json, Value};

pub async fn run_list() -> Result<Value> {
    let config_path = resolve_config_path()?;
    let configured = load_config(Some(config_path.clone()))
        .map(|config| config.databases.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    Ok(json!({
        "supported": list_supported_databases(),
        "configured": configured,
        "configPath": config_path,
    }))
}

pub async fn run_test(db: &str) -> Result<Value> {
    run_via_daemon(DaemonAction::Test, Some(db), None, None).await
}

pub async fn run_execute(db: &str, command: &str) -> Result<QueryResult> {
    let data = run_via_daemon(DaemonAction::Execute, Some(db), Some(command), None).await?;
    Ok(serde_json::from_value(data)?)
}

pub async fn run_metadata(db: &str, request: MetadataRequest) -> Result<QueryResult> {
    let data = run_via_daemon(DaemonAction::Metadata, Some(db), None, Some(request)).await?;
    Ok(serde_json::from_value(data)?)
}

pub async fn run_reset(db: &str) -> Result<Value> {
    run_via_daemon(DaemonAction::Reset, Some(db), None, None).await
}

/// Persistent batch mode: read one SQL statement per stdin line and execute each
/// over the already-running daemon, emitting one JSON result per line. Because a
/// single process serves many queries, the per-call process-spawn cost is paid
/// once instead of per query, so each statement runs at daemon round-trip speed
/// (sub-millisecond) rather than the ~20ms of a fresh `exec` invocation.
pub async fn run_repl(db: &str) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    // Start the daemon once up front so the first line isn't slowed by a cold start.
    start_daemon().await?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let command = line.trim();
        if command.is_empty() {
            continue;
        }
        let value = match run_execute(db, command).await {
            Ok(result) => serde_json::to_value(result)?,
            Err(error) => json!({ "error": crate::utils::masking::to_error_message(&error) }),
        };
        let mut encoded = serde_json::to_string(&value)?;
        encoded.push('\n');
        stdout.write_all(encoded.as_bytes()).await?;
        stdout.flush().await?;
    }
    Ok(())
}

async fn run_via_daemon(
    action: DaemonAction,
    db: Option<&str>,
    command: Option<&str>,
    metadata: Option<MetadataRequest>,
) -> Result<Value> {
    let config_path = resolve_config_path()?.display().to_string();
    let request = DaemonRequest {
        action,
        db: db.map(ToString::to_string),
        command: command.map(ToString::to_string),
        metadata,
        config_path: Some(config_path),
    };
    // Fast path: assume the daemon is already running and send the request
    // directly. Only when the transport fails (daemon not reachable) do we pay
    // the cost of starting it and retrying. This avoids a redundant
    // is_daemon_running() round-trip on every warm call.
    let response = match send_daemon_request(&request).await {
        Ok(response) => response,
        Err(_) => {
            start_daemon().await?;
            send_daemon_request(&request).await?
        }
    };
    if !response.ok {
        anyhow::bail!(response
            .error
            .unwrap_or_else(|| "daemon execution failed".to_string()));
    }
    Ok(response.data.unwrap_or_else(|| json!({})))
}
