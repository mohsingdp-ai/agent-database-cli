use crate::types::{AppConfig, DatabaseConfig, DatabaseType, OracleDriver};
use anyhow::{Context, Result};
use std::{env, fs, path::PathBuf};

pub const CONFIG_ENV: &str = "AGENT_DATABASE_CLI_CONFIG";

pub fn resolve_config_path() -> Result<PathBuf> {
    if let Ok(path) = env::var(CONFIG_ENV) {
        return Ok(PathBuf::from(path));
    }
    let home = dirs::home_dir().context("无法解析用户主目录")?;
    Ok(home.join(".agent-database-cli").join("config.json"))
}

pub fn load_config(path: Option<PathBuf>) -> Result<AppConfig> {
    let path = match path {
        Some(path) => path,
        None => resolve_config_path()?,
    };
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("读取配置文件失败: {}", path.display()))?;
    let config: AppConfig = serde_json::from_str(&raw).context("配置文件不是合法 JSON")?;
    validate_config(&config)?;
    Ok(config)
}

pub fn validate_config(config: &AppConfig) -> Result<()> {
    for (name, db) in &config.databases {
        validate_database_config(name, db)?;
    }
    Ok(())
}

fn validate_database_config(name: &str, db: &DatabaseConfig) -> Result<()> {
    if db.url.trim().is_empty() {
        anyhow::bail!("数据库配置 {name} 必须提供 url");
    }
    if db.redis_cluster.is_some() && db.db_type != DatabaseType::Redis {
        anyhow::bail!("数据库配置 {name} 只有 redis 类型允许配置 redisCluster");
    }
    if let Some(cluster) = &db.redis_cluster {
        if cluster.nodes.is_empty() {
            anyhow::bail!("数据库配置 {name} 的 redisCluster.nodes 必须是非空数组");
        }
        for (index, node) in cluster.nodes.iter().enumerate() {
            if node.trim().is_empty() {
                anyhow::bail!("数据库配置 {name} 的 redisCluster.nodes[{index}] 必须是非空字符串");
            }
            let parsed = url::Url::parse(node).with_context(|| {
                format!("数据库配置 {name} 的 redisCluster.nodes[{index}] 不是合法 URL")
            })?;
            if parsed.scheme() != "redis" && parsed.scheme() != "rediss" {
                anyhow::bail!(
                    "数据库配置 {name} 的 redisCluster.nodes[{index}] 只支持 redis:// 或 rediss://"
                );
            }
        }
    }
    if let Some(keep_alive) = db.keep_alive_seconds {
        if keep_alive == 0 {
            anyhow::bail!("数据库配置 {name} 的 keepAliveSeconds 必须是正整数");
        }
    }
    if let Some(driver) = &db.oracle_driver {
        if db.db_type != DatabaseType::Oracle {
            anyhow::bail!("数据库配置 {name} 只有 oracle 类型允许配置 oracleDriver");
        }
        match driver {
            OracleDriver::Oracle | OracleDriver::Sqlcl | OracleDriver::Oracledb => {}
        }
    }
    if let Some(tunnel) = &db.ssh_tunnel {
        if tunnel.host.trim().is_empty() {
            anyhow::bail!("数据库配置 {name} 的 sshTunnel.host 必须是非空字符串");
        }
        if tunnel.username.trim().is_empty() {
            anyhow::bail!("数据库配置 {name} 的 sshTunnel.username 必须是非空字符串");
        }
        if tunnel.password.as_deref() == Some("") {
            anyhow::bail!("数据库配置 {name} 的 sshTunnel.password 不能为空字符串");
        }
        if tunnel.private_key_path.as_deref() == Some("") {
            anyhow::bail!("数据库配置 {name} 的 sshTunnel.privateKeyPath 不能为空字符串");
        }
        if tunnel.private_key.as_deref() == Some("") {
            anyhow::bail!("数据库配置 {name} 的 sshTunnel.privateKey 不能为空字符串");
        }
        if tunnel.private_key_path.is_some() && tunnel.private_key.is_some() {
            anyhow::bail!(
                "数据库配置 {name} 的 sshTunnel.privateKeyPath 和 privateKey 只能配置一个"
            );
        }
        if tunnel.password.is_none()
            && tunnel.private_key_path.is_none()
            && tunnel.private_key.is_none()
        {
            anyhow::bail!(
                "数据库配置 {name} 的 sshTunnel 必须配置 password、privateKeyPath 或 privateKey"
            );
        }
        if tunnel.passphrase.is_some()
            && tunnel.private_key_path.is_none()
            && tunnel.private_key.is_none()
        {
            anyhow::bail!("数据库配置 {name} 的 sshTunnel.passphrase 只能和私钥一起使用");
        }
    }
    Ok(())
}

pub fn get_database_config<'a>(config: &'a AppConfig, name: &str) -> Result<&'a DatabaseConfig> {
    config
        .databases
        .get(name)
        .ok_or_else(|| anyhow::anyhow!("未找到数据库配置: {name}"))
}

pub fn list_supported_databases() -> Vec<&'static str> {
    vec!["mysql", "postgres", "redis", "oracle", "mongodb"]
}
