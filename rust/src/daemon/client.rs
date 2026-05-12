use crate::types::{DaemonRequest, DaemonResponse};
use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[cfg(windows)]
use tokio::net::windows::named_pipe::ClientOptions;
#[cfg(unix)]
use tokio::net::UnixStream;

pub async fn send_daemon_request(request: &DaemonRequest) -> Result<DaemonResponse> {
    let line = serde_json::to_string(request)?;
    #[cfg(unix)]
    {
        let mut stream = UnixStream::connect(crate::daemon::paths::socket_path()?).await?;
        stream.write_all(line.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        let mut reader = BufReader::new(stream);
        let mut buffer = String::new();
        reader.read_line(&mut buffer).await?;
        return Ok(serde_json::from_str(buffer.trim())?);
    }
    #[cfg(windows)]
    {
        let mut pipe = ClientOptions::new().open(crate::daemon::paths::socket_path_string()?)?;
        pipe.write_all(line.as_bytes()).await?;
        pipe.write_all(b"\n").await?;
        let mut reader = BufReader::new(pipe);
        let mut buffer = String::new();
        reader.read_line(&mut buffer).await?;
        return Ok(serde_json::from_str(buffer.trim())?);
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
