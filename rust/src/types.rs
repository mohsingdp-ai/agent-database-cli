use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseType {
    Mysql,
    Postgres,
    Redis,
    Oracle,
    Mongodb,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Json,
    Table,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OracleDriver {
    Oracle,
    Sqlcl,
    #[serde(alias = "oracledb")]
    Oracledb,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConfig {
    #[serde(rename = "type")]
    pub db_type: DatabaseType,
    pub url: String,
    pub redis_cluster: Option<RedisClusterConfig>,
    pub ssh_tunnel: Option<SshTunnelConfig>,
    pub database: Option<String>,
    pub oracle_driver: Option<OracleDriver>,
    pub sqlcl_path: Option<String>,
    pub java_home: Option<String>,
    pub readonly: Option<bool>,
    pub blacklist: Option<Vec<String>>,
    pub keep_alive_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisClusterConfig {
    pub nodes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_address_map: Option<HashMap<String, RedisNodeAddress>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RedisNodeAddress {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelConfig {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub ready_timeout: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AppConfig {
    pub databases: HashMap<String, DatabaseConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MetadataRequest {
    #[serde(rename = "type")]
    pub request_type: MetadataType,
    pub table: Option<String>,
    pub pattern: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MetadataType {
    Tables,
    Columns,
    Collections,
    Keys,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub rows: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_count: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DaemonAction {
    Test,
    Execute,
    Metadata,
    Reset,
    Status,
    Stop,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRequest {
    pub action: DaemonAction,
    pub db: Option<String>,
    pub command: Option<String>,
    pub metadata: Option<MetadataRequest>,
    pub config_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DaemonResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
