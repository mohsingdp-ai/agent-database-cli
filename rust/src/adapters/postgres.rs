use super::DatabaseAdapter;
use crate::types::{MetadataRequest, MetadataType, QueryResult};
use anyhow::Result;
use async_trait::async_trait;
use rust_decimal::Decimal;
use serde_json::{Map, Value};
use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
use tokio_postgres::types::{FromSql, Type};
use tokio_postgres::{Client, NoTls, Row};
use uuid::Uuid;

/// Last-resort fallback that reads a column's raw wire bytes as UTF-8 text.
/// Postgres sends enum labels (and other text-output types) as their literal
/// string in the binary protocol, so this recovers them without a dedicated
/// `FromSql` impl. Genuinely binary types fail the UTF-8 decode and fall back
/// to `<unsupported>`.
struct PgText(String);

impl<'a> FromSql<'a> for PgText {
    fn from_sql(
        _ty: &Type,
        raw: &'a [u8],
    ) -> std::result::Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(PgText(std::str::from_utf8(raw)?.to_string()))
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }
}

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
    if let Ok(value) = row.try_get::<_, Option<i16>>(index) {
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
    if let Ok(value) = row.try_get::<_, Option<f32>>(index) {
        return value
            .and_then(|v| serde_json::Number::from_f64(v as f64))
            .map(Value::Number)
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<_, Option<bool>>(index) {
        return value.map(Value::Bool).unwrap_or(Value::Null);
    }
    // NUMERIC / DECIMAL: emit as a string to preserve exact precision (money-safe).
    if let Ok(value) = row.try_get::<_, Option<Decimal>>(index) {
        return value
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null);
    }
    // UUID
    if let Ok(value) = row.try_get::<_, Option<Uuid>>(index) {
        return value
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null);
    }
    // JSON / JSONB: return the parsed value directly.
    if let Ok(value) = row.try_get::<_, Option<Value>>(index) {
        return value.unwrap_or(Value::Null);
    }
    // Date / time types, formatted as ISO 8601.
    if let Ok(value) = row.try_get::<_, Option<OffsetDateTime>>(index) {
        return value
            .and_then(|v| v.format(&Rfc3339).ok())
            .map(Value::String)
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<_, Option<PrimitiveDateTime>>(index) {
        return value
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<_, Option<Date>>(index) {
        return value
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null);
    }
    if let Ok(value) = row.try_get::<_, Option<Time>>(index) {
        return value
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null);
    }
    // Enums and other text-encoded types: recover the label from raw bytes.
    if let Ok(value) = row.try_get::<_, Option<PgText>>(index) {
        return value.map(|v| Value::String(v.0)).unwrap_or(Value::Null);
    }
    Value::String("<unsupported>".to_string())
}
