use crate::adapters::{create_adapter, DatabaseAdapter};
use crate::config::get_database_config;
use crate::security::assert_command_allowed;
use crate::ssh_tunnel::{start_ssh_tunnel, StartedSshTunnel};
use crate::types::{AppConfig, DatabaseConfig, MetadataRequest, QueryResult};
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

struct Entry {
    adapter: Box<dyn DatabaseAdapter>,
    config: DatabaseConfig,
    tunnel: Option<StartedSshTunnel>,
    last_used: Instant,
}

pub struct ConnectionManager {
    config: AppConfig,
    entries: HashMap<String, Entry>,
}

impl ConnectionManager {
    pub fn new(config: AppConfig) -> Self {
        Self {
            config,
            entries: HashMap::new(),
        }
    }

    pub async fn test(&mut self, name: &str) -> Result<Value> {
        let entry = self.get_entry(name).await?;
        entry.adapter.test().await?;
        entry.last_used = Instant::now();
        Ok(json!({ "ok": true }))
    }

    pub async fn execute(&mut self, name: &str, command: &str) -> Result<QueryResult> {
        let config = get_database_config(&self.config, name)?;
        assert_command_allowed(config, command)?;
        let entry = self.get_entry(name).await?;
        let result = entry.adapter.execute(command).await?;
        entry.last_used = Instant::now();
        Ok(result)
    }

    pub async fn metadata(&mut self, name: &str, request: MetadataRequest) -> Result<QueryResult> {
        let entry = self.get_entry(name).await?;
        let result = entry.adapter.metadata(request).await?;
        entry.last_used = Instant::now();
        Ok(result)
    }

    pub async fn reset(&mut self, name: &str) -> Result<Value> {
        if let Some(mut entry) = self.entries.remove(name) {
            entry.adapter.disconnect().await?;
        }
        Ok(json!({ "reset": name }))
    }

    pub async fn close_all(&mut self) -> Result<()> {
        let names = self.entries.keys().cloned().collect::<Vec<_>>();
        for name in names {
            self.reset(&name).await?;
        }
        Ok(())
    }

    pub async fn cleanup_idle(&mut self) -> Result<()> {
        let now = Instant::now();
        let expired = self
            .entries
            .iter()
            .filter_map(|(name, entry)| {
                let keep_alive =
                    Duration::from_secs(entry.config.keep_alive_seconds.unwrap_or(180));
                (now.duration_since(entry.last_used) >= keep_alive).then(|| name.clone())
            })
            .collect::<Vec<_>>();
        for name in expired {
            self.reset(&name).await?;
        }
        Ok(())
    }

    pub fn status(&self) -> Value {
        json!({
            "connections": self.entries.iter().map(|(name, entry)| json!({
                "name": name,
                "type": format!("{:?}", entry.config.db_type).to_lowercase(),
                "keepAliveSeconds": entry.config.keep_alive_seconds.unwrap_or(180),
                "sshTunnel": entry.tunnel.is_some(),
            })).collect::<Vec<_>>()
        })
    }

    async fn get_entry(&mut self, name: &str) -> Result<&mut Entry> {
        if !self.entries.contains_key(name) {
            let config = get_database_config(&self.config, name)?.clone();
            let tunnel = start_ssh_tunnel(&config).await?;
            let mut adapter_config = config.clone();
            if let Some(tunnel) = &tunnel {
                adapter_config.url = tunnel.url.clone();
                if tunnel.redis_cluster.is_some() {
                    adapter_config.redis_cluster = tunnel.redis_cluster.clone();
                }
            }
            let mut adapter = create_adapter(&adapter_config)?;
            adapter.connect().await?;
            self.entries.insert(
                name.to_string(),
                Entry {
                    adapter,
                    config,
                    tunnel,
                    last_used: Instant::now(),
                },
            );
        }
        Ok(self.entries.get_mut(name).expect("连接条目已创建"))
    }
}
