use crate::daemon::paths;
use crate::types::{DaemonRequest, DaemonResponse};
use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[cfg(unix)]
use tokio::net::UnixStream;

pub async fn send_daemon_request(request: &DaemonRequest) -> Result<DaemonResponse> {
    #[cfg(unix)]
    {
        let mut stream = UnixStream::connect(paths::socket_path()?).await?;
        let line = serde_json::to_string(request)?;
        stream.write_all(line.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        let mut reader = BufReader::new(stream);
        let mut buffer = String::new();
        reader.read_line(&mut buffer).await?;
        return Ok(serde_json::from_str(buffer.trim())?);
    }
    #[cfg(windows)]
    {
        anyhow::bail!("Rust daemon 暂未实现 Windows named pipe 客户端");
    }
}

pub async fn is_daemon_running() -> bool {
    send_daemon_request(&DaemonRequest {
        action: crate::types::DaemonAction::Status,
        db: None,
        command: None,
        metadata: None,
        config_path: None,
    })
    .await
    .map(|response| response.ok)
    .unwrap_or(false)
}
