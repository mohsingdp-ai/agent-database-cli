use super::DatabaseAdapter;
use crate::types::{MetadataRequest, MetadataType, QueryResult};
use anyhow::Result;
use async_trait::async_trait;
use mysql_async::{prelude::Queryable, Conn, Opts, Row, Value as MyValue};
use serde_json::{Map, Value};
use url::Url;

pub struct MySqlAdapter {
    url: String,
    conn: Option<Conn>,
}

impl MySqlAdapter {
    pub fn new(url: String) -> Self {
        Self { url, conn: None }
    }

    async fn query(&mut self, command: &str) -> Result<QueryResult> {
        self.connect().await?;
        let rows: Vec<Row> = self.conn.as_mut().unwrap().query(command).await?;
        let fields = rows
            .first()
            .map(|row| {
                row.columns_ref()
                    .iter()
                    .map(|c| c.name_str().to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let values = rows.into_iter().map(row_to_json).collect::<Vec<_>>();
        Ok(QueryResult {
            row_count: Some(values.len() as u64),
            rows: values,
            fields: Some(fields),
        })
    }
}

#[async_trait]
impl DatabaseAdapter for MySqlAdapter {
    async fn connect(&mut self) -> Result<()> {
        if self.conn.is_none() {
            let opts = Opts::from_url(&normalize_mysql_url(&self.url)?)?;
            self.conn = Some(Conn::new(opts).await?);
        }
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<()> {
        if let Some(conn) = self.conn.take() {
            conn.disconnect().await?;
        }
        Ok(())
    }
    async fn test(&mut self) -> Result<()> {
        self.execute("select 1").await.map(|_| ())
    }
    async fn execute(&mut self, command: &str) -> Result<QueryResult> {
        self.query(command).await
    }
    async fn metadata(&mut self, request: MetadataRequest) -> Result<QueryResult> {
        match request.request_type {
            MetadataType::Tables => self.query("show tables").await,
            MetadataType::Columns => {
                let table = request
                    .table
                    .ok_or_else(|| anyhow::anyhow!("columns metadata query must provide --table"))?
                    .replace('`', "``");
                self.query(&format!("show columns from `{}`", table)).await
            }
            _ => anyhow::bail!(
                "the current database does not support metadata type: {:?}",
                request.request_type
            ),
        }
    }
}

fn row_to_json(row: Row) -> Value {
    let columns = row.columns_ref().to_vec();
    let values = row.unwrap();
    let mut object = Map::new();
    for (index, column) in columns.iter().enumerate() {
        object.insert(
            column.name_str().to_string(),
            mysql_value_to_json(values.get(index).cloned().unwrap_or(MyValue::NULL)),
        );
    }
    Value::Object(object)
}

fn mysql_value_to_json(value: MyValue) -> Value {
    match value {
        MyValue::NULL => Value::Null,
        MyValue::Bytes(bytes) => Value::String(String::from_utf8_lossy(&bytes).to_string()),
        MyValue::Int(value) => Value::Number(value.into()),
        MyValue::UInt(value) => Value::Number(value.into()),
        MyValue::Float(value) => serde_json::Number::from_f64(value as f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        MyValue::Double(value) => serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        other => Value::String(format!("{:?}", other)),
    }
}

fn normalize_mysql_url(value: &str) -> Result<String> {
    let mut parsed = Url::parse(value)?;
    let supported = [
        "pool_min",
        "pool_max",
        "inactive_connection_ttl",
        "ttl_check_interval",
        "conn_ttl",
        "tcp_keepalive_time_ms",
        "tcp_connect_timeout_ms",
        "stmt_cache_size",
        "prefer_socket",
        "socket",
        "compression",
        "ssl-mode",
    ];
    let pairs = parsed
        .query_pairs()
        .filter(|(key, _)| supported.contains(&key.as_ref()))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    parsed.set_query(None);
    if !pairs.is_empty() {
        let query = pairs
            .into_iter()
            .map(|(key, value)| format!("{}={}", key, value))
            .collect::<Vec<_>>()
            .join("&");
        parsed.set_query(Some(&query));
    }
    Ok(parsed.to_string())
}
