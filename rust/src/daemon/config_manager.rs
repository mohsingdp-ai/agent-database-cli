use crate::config::{load_config, resolve_config_path};
use crate::daemon::connection_manager::ConnectionManager;
use anyhow::Result;
use serde_json::Value;
use std::{fs, path::PathBuf, time::SystemTime};

#[derive(Clone)]
struct ConfigSnapshot {
    path: PathBuf,
    modified: SystemTime,
    size: u64,
}

pub struct DaemonConfigManager {
    manager: Option<ConnectionManager>,
    snapshot: Option<ConfigSnapshot>,
}

impl DaemonConfigManager {
    pub fn new() -> Self {
        Self {
            manager: None,
            snapshot: None,
        }
    }

    pub async fn get_manager(
        &mut self,
        config_path: Option<String>,
    ) -> Result<&mut ConnectionManager> {
        let path = config_path
            .map(PathBuf::from)
            .unwrap_or(resolve_config_path()?);
        let snapshot = read_config_snapshot(path)?;
        if self.manager.is_none()
            || self
                .snapshot
                .as_ref()
                .map(|old| has_config_changed(old, &snapshot))
                .unwrap_or(true)
        {
            self.replace_manager(snapshot).await?;
        }
        Ok(self.manager.as_mut().expect("配置管理器已初始化"))
    }

    pub fn status(&self) -> Value {
        self.manager
            .as_ref()
            .map(ConnectionManager::status)
            .unwrap_or_else(|| serde_json::json!({ "connections": [] }))
    }

    pub async fn close_all(&mut self) -> Result<()> {
        if let Some(manager) = &mut self.manager {
            manager.close_all().await?;
        }
        self.manager = None;
        self.snapshot = None;
        Ok(())
    }

    pub async fn cleanup_idle(&mut self) -> Result<()> {
        if let Some(manager) = &mut self.manager {
            manager.cleanup_idle().await?;
        }
        Ok(())
    }

    async fn replace_manager(&mut self, snapshot: ConfigSnapshot) -> Result<()> {
        self.close_all().await?;
        let config = load_config(Some(snapshot.path.clone()))?;
        self.manager = Some(ConnectionManager::new(config));
        self.snapshot = Some(snapshot);
        Ok(())
    }
}

fn read_config_snapshot(path: PathBuf) -> Result<ConfigSnapshot> {
    let metadata = fs::metadata(&path)?;
    Ok(ConfigSnapshot {
        path,
        modified: metadata.modified()?,
        size: metadata.len(),
    })
}

fn has_config_changed(current: &ConfigSnapshot, next: &ConfigSnapshot) -> bool {
    current.path != next.path || current.modified != next.modified || current.size != next.size
}
