use crate::adapters::{create_adapter, DatabaseAdapter};
use crate::config::{
    get_database_config, list_supported_databases, load_config, resolve_config_path,
};
use crate::security::assert_command_allowed;
use crate::ssh_tunnel::{start_ssh_tunnel, StartedSshTunnel};
use crate::types::{DatabaseConfig, MetadataRequest, QueryResult};
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
    let db_config = load_database_config(db)?;
    let (mut adapter, _tunnel) = connect_adapter(&db_config).await?;
    let result = adapter.test().await;
    let _ = adapter.disconnect().await;
    result?;
    Ok(json!({ "ok": true }))
}

pub async fn run_execute(db: &str, command: &str) -> Result<QueryResult> {
    let db_config = load_database_config(db)?;
    // Enforce the read-only / blocklist guard before opening a connection.
    assert_command_allowed(&db_config, command)?;
    let (mut adapter, _tunnel) = connect_adapter(&db_config).await?;
    let result = adapter.execute(command).await;
    let _ = adapter.disconnect().await;
    result
}

pub async fn run_metadata(db: &str, request: MetadataRequest) -> Result<QueryResult> {
    let db_config = load_database_config(db)?;
    let (mut adapter, _tunnel) = connect_adapter(&db_config).await?;
    let result = adapter.metadata(request).await;
    let _ = adapter.disconnect().await;
    result
}

/// Batch mode: read one statement per stdin line and execute each over a single
/// connection that is opened once and reused for the whole stream, emitting one
/// JSON result per line. Reusing one connection keeps per-statement latency at
/// query speed instead of paying a fresh connect (and TLS/SSH handshake) per
/// line.
pub async fn run_repl(db: &str) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let db_config = load_database_config(db)?;
    let (mut adapter, _tunnel) = connect_adapter(&db_config).await?;

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let command = line.trim();
        if command.is_empty() {
            continue;
        }
        let value = match execute_checked(&db_config, adapter.as_mut(), command).await {
            Ok(result) => serde_json::to_value(result)?,
            Err(error) => json!({ "error": crate::utils::masking::to_error_message(&error) }),
        };
        let mut encoded = serde_json::to_string(&value)?;
        encoded.push('\n');
        stdout.write_all(encoded.as_bytes()).await?;
        stdout.flush().await?;
    }

    let _ = adapter.disconnect().await;
    Ok(())
}

/// Load the resolved config and pull out a single database's settings (with
/// secrets already decrypted and validated).
fn load_database_config(db: &str) -> Result<DatabaseConfig> {
    let config = load_config(None)?;
    Ok(get_database_config(&config, db)?.clone())
}

/// Run the read-only / blocklist guard, then execute the command on an already
/// connected adapter.
async fn execute_checked(
    db_config: &DatabaseConfig,
    adapter: &mut dyn DatabaseAdapter,
    command: &str,
) -> Result<QueryResult> {
    assert_command_allowed(db_config, command)?;
    adapter.execute(command).await
}

/// Open a direct connection to the database, bringing up an SSH tunnel first if
/// the connection is configured to use one. The returned tunnel must be kept
/// alive for as long as the adapter is used; dropping it tears the tunnel down.
async fn connect_adapter(
    db_config: &DatabaseConfig,
) -> Result<(Box<dyn DatabaseAdapter>, Option<StartedSshTunnel>)> {
    let tunnel = start_ssh_tunnel(db_config).await?;
    let mut adapter_config = db_config.clone();
    if let Some(tunnel) = &tunnel {
        adapter_config.url = tunnel.url.clone();
        if tunnel.redis_cluster.is_some() {
            adapter_config.redis_cluster = tunnel.redis_cluster.clone();
        }
    }
    let mut adapter = create_adapter(&adapter_config)?;
    adapter.connect().await?;
    Ok((adapter, tunnel))
}
