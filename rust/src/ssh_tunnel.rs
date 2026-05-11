use crate::types::{
    DatabaseConfig, DatabaseType, RedisClusterConfig, RedisNodeAddress, SshTunnelConfig,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use russh::client::{self, Handle};
use russh::keys::key;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use url::Url;

pub struct StartedSshTunnel {
    pub url: String,
    pub redis_cluster: Option<RedisClusterConfig>,
    _tasks: Vec<JoinHandle<()>>,
    _sessions: Vec<Arc<tokio::sync::Mutex<Handle<ClientHandler>>>>,
}

impl Drop for StartedSshTunnel {
    fn drop(&mut self) {
        for task in &self._tasks {
            task.abort();
        }
        // russh Handle drop 会关闭底层连接；这里不在 Drop 中 await disconnect。
    }
}

#[derive(Clone)]
struct ClientHandler;

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[derive(Clone)]
struct DatabaseEndpoint {
    host: String,
    port: u16,
}

struct ForwardListener {
    local_port: u16,
    task: JoinHandle<()>,
    session: Arc<tokio::sync::Mutex<Handle<ClientHandler>>>,
}

const MYSQL_PORT: u16 = 3306;
const POSTGRES_PORT: u16 = 5432;
const REDIS_PORT: u16 = 6379;
const ORACLE_PORT: u16 = 1521;
const MONGODB_PORT: u16 = 27017;

fn debug_enabled() -> bool {
    std::env::var("AGENT_DATABASE_CLI_DEBUG").is_ok()
}

pub async fn start_ssh_tunnel(config: &DatabaseConfig) -> Result<Option<StartedSshTunnel>> {
    let Some(tunnel) = &config.ssh_tunnel else {
        return Ok(None);
    };
    if config.db_type == DatabaseType::Redis && config.redis_cluster.is_some() {
        return Ok(Some(start_redis_cluster_tunnel(config, tunnel).await?));
    }
    let endpoint = parse_database_endpoint(&config.db_type, &config.url)?;
    let forward = spawn_forward_listener(tunnel.clone(), endpoint).await?;
    let url = rewrite_database_url(
        &config.db_type,
        &config.url,
        "127.0.0.1",
        forward.local_port,
    )?;
    Ok(Some(StartedSshTunnel {
        url,
        redis_cluster: None,
        _tasks: vec![forward.task],
        _sessions: vec![forward.session],
    }))
}

async fn start_redis_cluster_tunnel(
    config: &DatabaseConfig,
    tunnel: &SshTunnelConfig,
) -> Result<StartedSshTunnel> {
    let mut tasks = Vec::new();
    let mut sessions = Vec::new();
    let mut local_nodes = Vec::new();
    let mut node_address_map: HashMap<String, RedisNodeAddress> = HashMap::new();

    for node_url in &config
        .redis_cluster
        .as_ref()
        .expect("Redis Cluster 配置存在")
        .nodes
    {
        let endpoint = parse_redis_cluster_node(node_url)?;
        if debug_enabled() {
            eprintln!(
                "[rust-db-cli] ssh tunnel redis node {}:{}",
                endpoint.host, endpoint.port
            );
        }
        let forward = spawn_forward_listener(tunnel.clone(), endpoint.clone()).await?;
        if debug_enabled() {
            eprintln!(
                "[rust-db-cli] ssh tunnel local 127.0.0.1:{} -> {}:{}",
                forward.local_port, endpoint.host, endpoint.port
            );
        }
        node_address_map.insert(
            format!("{}:{}", endpoint.host, endpoint.port),
            RedisNodeAddress {
                host: "127.0.0.1".to_string(),
                port: forward.local_port,
            },
        );
        local_nodes.push(rewrite_database_url(
            &DatabaseType::Redis,
            node_url,
            "127.0.0.1",
            forward.local_port,
        )?);
        tasks.push(forward.task);
        sessions.push(forward.session);
    }

    let first_port = local_nodes
        .first()
        .context("Redis Cluster 节点不能为空")?
        .parse::<Url>()?
        .port()
        .unwrap_or(REDIS_PORT);
    Ok(StartedSshTunnel {
        url: rewrite_database_url(&DatabaseType::Redis, &config.url, "127.0.0.1", first_port)?,
        redis_cluster: Some(RedisClusterConfig {
            nodes: local_nodes,
            node_address_map: Some(node_address_map),
        }),
        _tasks: tasks,
        _sessions: sessions,
    })
}

async fn spawn_forward_listener(
    tunnel: SshTunnelConfig,
    endpoint: DatabaseEndpoint,
) -> Result<ForwardListener> {
    if debug_enabled() {
        eprintln!(
            "[rust-db-cli] russh login {}:{}",
            tunnel.host,
            tunnel.port.unwrap_or(22)
        );
    }
    let session = connect_session(&tunnel).await?;
    if debug_enabled() {
        eprintln!(
            "[rust-db-cli] russh login ok {}:{}",
            tunnel.host,
            tunnel.port.unwrap_or(22)
        );
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let session = Arc::new(tokio::sync::Mutex::new(session));
    let session_for_task = session.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((local_stream, _)) = listener.accept().await else {
                break;
            };
            let session = session_for_task.clone();
            let endpoint = endpoint.clone();
            tokio::spawn(async move {
                if let Err(error) = forward_once(local_stream, session, endpoint).await {
                    eprintln!("SSH 隧道转发失败: {error}");
                }
            });
        }
    });
    Ok(ForwardListener {
        local_port,
        task,
        session,
    })
}

async fn forward_once(
    mut local_stream: TcpStream,
    session: Arc<tokio::sync::Mutex<Handle<ClientHandler>>>,
    endpoint: DatabaseEndpoint,
) -> Result<()> {
    if debug_enabled() {
        eprintln!(
            "[rust-db-cli] russh direct-tcpip open {}:{}",
            endpoint.host, endpoint.port
        );
    }
    let guard = session.lock().await;
    let mut channel = guard
        .channel_open_direct_tcpip(endpoint.host.clone(), endpoint.port.into(), "127.0.0.1", 0)
        .await?;
    drop(guard);
    if debug_enabled() {
        eprintln!(
            "[rust-db-cli] russh direct-tcpip opened {}:{}",
            endpoint.host, endpoint.port
        );
    }
    let mut buffer = [0_u8; 8192];
    loop {
        tokio::select! {
            read = local_stream.read(&mut buffer) => {
                let count = read?;
                if count == 0 {
                    channel.eof().await?;
                    break;
                }
                channel.data(&buffer[..count]).await?;
            }
            message = channel.wait() => {
                let Some(message) = message else { break; };
                match message {
                    russh::ChannelMsg::Data { data } => {
                        local_stream.write_all(&data).await?;
                    }
                    russh::ChannelMsg::Eof => break,
                    russh::ChannelMsg::Close => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

async fn connect_session(tunnel: &SshTunnelConfig) -> Result<Handle<ClientHandler>> {
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });
    let mut session = timeout(
        Duration::from_secs(10),
        client::connect(
            config,
            (tunnel.host.as_str(), tunnel.port.unwrap_or(22)),
            ClientHandler,
        ),
    )
    .await??;
    let authenticated = if let Some(password) = &tunnel.password {
        session
            .authenticate_password(tunnel.username.clone(), password.clone())
            .await?
    } else if let Some(private_key_path) = &tunnel.private_key_path {
        let key = russh_keys::load_secret_key(
            resolve_home_path(private_key_path)?,
            tunnel.passphrase.as_deref(),
        )?;
        session
            .authenticate_publickey(tunnel.username.clone(), Arc::new(key))
            .await?
    } else if let Some(private_key) = &tunnel.private_key {
        let key = russh_keys::decode_secret_key(private_key, tunnel.passphrase.as_deref())?;
        session
            .authenticate_publickey(tunnel.username.clone(), Arc::new(key))
            .await?
    } else {
        false
    };
    if !authenticated {
        anyhow::bail!("SSH 认证失败");
    }
    Ok(session)
}

pub fn rewrite_database_url(
    db_type: &DatabaseType,
    value: &str,
    host: &str,
    port: u16,
) -> Result<String> {
    if *db_type == DatabaseType::Mongodb && is_mongo_multi_host_url(value) {
        anyhow::bail!("SSH 隧道暂不支持 MongoDB 多 host URL");
    }
    let mut parsed = Url::parse(value)?;
    parsed.set_host(Some(host))?;
    parsed
        .set_port(Some(port))
        .map_err(|_| anyhow::anyhow!("数据库 URL 端口改写失败"))?;
    Ok(parsed.to_string())
}

fn parse_database_endpoint(db_type: &DatabaseType, value: &str) -> Result<DatabaseEndpoint> {
    if *db_type == DatabaseType::Mongodb && is_mongo_multi_host_url(value) {
        anyhow::bail!("SSH 隧道暂不支持 MongoDB 多 host URL");
    }
    let parsed = Url::parse(value)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("数据库 URL 必须包含 host 才能建立 SSH 隧道"))?
        .to_string();
    Ok(DatabaseEndpoint {
        host,
        port: parsed.port().unwrap_or(default_port(db_type)),
    })
}

fn parse_redis_cluster_node(value: &str) -> Result<DatabaseEndpoint> {
    let parsed = Url::parse(value)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("Redis Cluster 节点 URL 必须包含 host"))?
        .to_string();
    Ok(DatabaseEndpoint {
        host,
        port: parsed.port().unwrap_or(REDIS_PORT),
    })
}

fn default_port(db_type: &DatabaseType) -> u16 {
    match db_type {
        DatabaseType::Mysql => MYSQL_PORT,
        DatabaseType::Postgres => POSTGRES_PORT,
        DatabaseType::Redis => REDIS_PORT,
        DatabaseType::Oracle => ORACLE_PORT,
        DatabaseType::Mongodb => MONGODB_PORT,
    }
}

fn is_mongo_multi_host_url(value: &str) -> bool {
    if !value.starts_with("mongodb://") {
        return false;
    }
    let authority = value
        .trim_start_matches("mongodb://")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let hosts = authority
        .rsplit_once('@')
        .map(|(_, hosts)| hosts)
        .unwrap_or(authority);
    hosts.contains(',')
}

fn resolve_home_path(path: &str) -> Result<PathBuf> {
    if path == "~" {
        return dirs::home_dir().context("无法解析用户主目录");
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return Ok(dirs::home_dir().context("无法解析用户主目录")?.join(rest));
    }
    Ok(PathBuf::from(path))
}
