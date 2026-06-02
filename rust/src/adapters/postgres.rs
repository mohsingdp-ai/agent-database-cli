use super::DatabaseAdapter;
use crate::types::{MetadataRequest, MetadataType, QueryResult};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Map, Value};
use tokio_postgres::{Client, NoTls, Row};

pub struct PostgresAdapter {
    url: String,
    client: Option<Client>,
}

impl PostgresAdapter {
    pub fn new(url: String) -> Self {
        Self { url, client: None }
    }

    async fn query(&mut self, command: &str) -> Result<QueryResult> {
        self.connect().await?;
        let rows = self.client.as_ref().unwrap().query(command, &[]).await?;
        let fields = rows
            .first()
            .map(|row| {
                row.columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let values = rows.iter().map(row_to_json).collect::<Vec<_>>();
        Ok(QueryResult {
            row_count: Some(values.len() as u64),
            rows: values,
            fields: Some(fields),
        })
    }
}

#[async_trait]
impl DatabaseAdapter for PostgresAdapter {
    async fn connect(&mut self) -> Result<()> {
        if self.client.is_none() {
            let (client, connection) = tokio_postgres::connect(&self.url, NoTls).await?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            self.client = Some(client);
        }
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<()> {
        self.client = None;
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
            MetadataType::Tables => self.query("select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') order by table_schema, table_name").await,
            MetadataType::Columns => {
                let table = request.table.ok_or_else(|| anyhow::anyhow!("columns metadata query must provide --table"))?.replace('\'', "''");
                self.query(&format!("select table_schema, table_name, column_name, data_type from information_schema.columns where table_name = '{}' order by ordinal_position", table)).await
            }
            _ => anyhow::bail!("the current database does not support metadata type: {:?}", request.request_type),
        }
    }
}

fn row_to_json(row: &Row) -> Value {
    let mut object = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let value = cell_to_json(row, index);
        object.insert(column.name().to_string(), value);
    }
    Value::Object(object)
}

fn cell_to_json(row: &Row, index: usize) -> Value {
    if let Ok(value) = row.try_get::<_, Option<String>>(index) {
        return value.map(Value::String).unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<_, Option<i64>>(index) {
        return value
            .map(|v| Value::Number(v.into()))
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<_, Option<i32>>(index) {
        return value
            .map(|v| Value::Number(v.into()))
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<_, Option<f64>>(index) {
        return value
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<_, Option<bool>>(index) {
        return value.map(Value::Bool).unwrap_or(Value::Null);
    }
    Value::String("<unsupported>".to_string())
}
