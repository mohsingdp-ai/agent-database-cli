use super::DatabaseAdapter;
use crate::types::{MetadataRequest, MetadataType, QueryResult};
use crate::utils::masking::mask_secret;
use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;
use std::{fs, path::PathBuf, process::Command};
use url::Url;
use uuid::Uuid;

pub struct OracleSqlclAdapter {
    url: String,
    sqlcl_path: String,
    java_home: Option<String>,
}

impl OracleSqlclAdapter {
    pub fn new(url: String, sqlcl_path: String, java_home: Option<String>) -> Self {
        Self {
            url,
            sqlcl_path,
            java_home,
        }
    }

    fn run_sqlcl(&self, command: &str) -> Result<QueryResult> {
        let markers = Markers::new();
        let dir = std::env::temp_dir().join(format!("agent-database-cli-sqlcl-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir)?;
        let script_path = dir.join("command.sql");
        fs::write(&script_path, self.build_script(command, &markers))?;
        let result = self.spawn_sqlcl(&script_path);
        let _ = fs::remove_dir_all(&dir);
        result
    }

    fn spawn_sqlcl(&self, script_path: &PathBuf) -> Result<QueryResult> {
        let mut command = Command::new(&self.sqlcl_path);
        command
            .arg("-S")
            .arg("/nolog")
            .arg(format!("@{}", script_path.display()))
            .env("NO_COLOR", "1")
            .env("TERM", "dumb");
        if let Some(java_home) = &self.java_home {
            command.env("JAVA_HOME", java_home);
        }
        let output = command
            .output()
            .map_err(|error| anyhow::anyhow!("SQLcl 启动失败: {}", error))?;
        let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
        let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
        let combined = [stdout.trim(), stderr.trim()]
            .into_iter()
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if contains_sqlcl_error(&combined) || !output.status.success() {
            anyhow::bail!("{}", mask_secret(&format!("SQLcl 执行失败: {combined}")));
        }
        parse_sqlcl_output(&stdout)
    }

    fn build_script(&self, command: &str, markers: &Markers) -> String {
        format!("set heading on\nset feedback off\nset pagesize 50000\nset linesize 32767\nset sqlformat json\nwhenever sqlerror exit sql.sqlcode\nconnect {}\nprompt {}\n{};\nprompt {}\nexit", self.build_connect_string(), markers.begin, normalize_sqlcl_sql(command), markers.end)
    }

    fn build_connect_string(&self) -> String {
        let parsed = Url::parse(&self.url).expect("Oracle URL 已在配置阶段校验");
        let user = parsed.username();
        let password = quote_password(parsed.password().unwrap_or(""));
        let service = parsed.path().trim_start_matches('/');
        format!(
            "{user}/{password}@//{}:{}/{}",
            parsed.host_str().unwrap_or("localhost"),
            parsed.port().unwrap_or(1521),
            service
        )
    }
}

#[async_trait]
impl DatabaseAdapter for OracleSqlclAdapter {
    async fn connect(&mut self) -> Result<()> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<()> {
        Ok(())
    }
    async fn test(&mut self) -> Result<()> {
        self.execute("select 1 from dual").await.map(|_| ())
    }
    async fn execute(&mut self, command: &str) -> Result<QueryResult> {
        self.run_sqlcl(command)
    }
    async fn metadata(&mut self, request: MetadataRequest) -> Result<QueryResult> {
        match request.request_type {
            MetadataType::Tables => {
                self.execute("select table_name from user_tables order by table_name")
                    .await
            }
            MetadataType::Columns => {
                let table = request
                    .table
                    .ok_or_else(|| anyhow::anyhow!("columns 元信息查询必须提供 --table"))?
                    .replace('\'', "''")
                    .to_uppercase();
                self.execute(&format!("select table_name, column_name, data_type from user_tab_columns where table_name = '{}' order by column_id", table)).await
            }
            _ => anyhow::bail!("当前数据库不支持元信息类型: {:?}", request.request_type),
        }
    }
}

struct Markers {
    begin: String,
    end: String,
}
impl Markers {
    fn new() -> Self {
        let id = Uuid::new_v4();
        Self {
            begin: format!("__AGENT_DATABASE_CLI_BEGIN_{id}__"),
            end: format!("__AGENT_DATABASE_CLI_END_{id}__"),
        }
    }
}
fn normalize_sqlcl_sql(command: &str) -> String {
    command.trim().trim_end_matches(';').to_string()
}
fn quote_password(password: &str) -> String {
    format!("\"{}\"", password.replace('"', "\\\""))
}
fn strip_ansi(value: &str) -> String {
    regex::Regex::new(r"\x1b\[[0-9;]*m")
        .unwrap()
        .replace_all(value, "")
        .to_string()
}
fn contains_sqlcl_error(value: &str) -> bool {
    ["ORA-", "SP2-", "SQL Error"]
        .iter()
        .any(|item| value.contains(item))
}
fn parse_sqlcl_output(stdout: &str) -> Result<QueryResult> {
    let json_start = stdout.find('[').or_else(|| stdout.find('{'));
    if let Some(start) = json_start {
        let slice = &stdout[start..];
        if let Ok(value) = serde_json::from_str::<Value>(slice.trim()) {
            let rows = value.as_array().cloned().unwrap_or_else(|| vec![value]);
            return Ok(QueryResult {
                row_count: Some(rows.len() as u64),
                rows,
                fields: None,
            });
        }
    }
    Ok(QueryResult {
        rows: vec![serde_json::json!({ "output": stdout.trim() })],
        fields: Some(vec!["output".to_string()]),
        row_count: if stdout.trim().is_empty() {
            Some(0)
        } else {
            Some(1)
        },
    })
}
