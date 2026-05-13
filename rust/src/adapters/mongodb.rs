use super::DatabaseAdapter;
use crate::types::{MetadataRequest, MetadataType, QueryResult};
use anyhow::Result;
use async_trait::async_trait;
use futures::TryStreamExt;
use mongodb::{
    bson::{doc, Document},
    Client, Database,
};
use serde_json::{json, Value};

const DEFAULT_QUERY_LIMIT: i64 = 100;
const MAX_QUERY_LIMIT: i64 = 1000;

pub struct MongoDbAdapter {
    url: String,
    database_name: Option<String>,
    client: Option<Client>,
    db: Option<Database>,
}

impl MongoDbAdapter {
    pub fn new(url: String, database_name: Option<String>) -> Self {
        Self {
            url,
            database_name,
            client: None,
            db: None,
        }
    }

    async fn run_operation(&mut self, operation: &str, payload: &Value) -> Result<Vec<Value>> {
        let request = normalize_payload(payload)?;
        let collection = self
            .db
            .as_ref()
            .unwrap()
            .collection::<Document>(&request.collection);
        match operation {
            "find" => {
                let mut action = collection
                    .find(request.filter)
                    .limit(request.limit.unwrap_or(DEFAULT_QUERY_LIMIT));
                if let Some(projection) = request.projection {
                    action = action.projection(projection);
                }
                let cursor = action.await?;
                Ok(cursor
                    .try_collect::<Vec<_>>()
                    .await?
                    .into_iter()
                    .map(bson_to_json)
                    .collect())
            }
            "findOne" => {
                let mut action = collection.find_one(request.filter);
                if let Some(projection) = request.projection {
                    action = action.projection(projection);
                }
                Ok(action.await?.map(bson_to_json).into_iter().collect())
            }
            "aggregate" => {
                let cursor = collection
                    .aggregate(request.pipeline.unwrap_or_default())
                    .await?;
                Ok(cursor
                    .try_collect::<Vec<_>>()
                    .await?
                    .into_iter()
                    .map(bson_to_json)
                    .collect())
            }
            "count" | "countDocuments" => Ok(vec![
                json!({ "count": collection.count_documents(request.filter).await? }),
            ]),
            "estimatedDocumentCount" => Ok(vec![
                json!({ "count": collection.estimated_document_count().await? }),
            ]),
            "distinct" => {
                let field = request
                    .field
                    .ok_or_else(|| anyhow::anyhow!("distinct 命令必须提供 field"))?;
                let values = collection.distinct(field, request.filter).await?;
                Ok(values
                    .into_iter()
                    .map(|value| json!({ "value": bson_to_json(value) }))
                    .collect())
            }
            _ => anyhow::bail!("不支持的 MongoDB 命令: {operation}"),
        }
    }
}

#[async_trait]
impl DatabaseAdapter for MongoDbAdapter {
    async fn connect(&mut self) -> Result<()> {
        if self.client.is_none() {
            let client = Client::with_uri_str(&self.url).await?;
            let db = match &self.database_name {
                Some(name) => client.database(name),
                None => client.default_database().ok_or_else(|| {
                    anyhow::anyhow!("MongoDB URL 未包含默认数据库，请配置 database")
                })?,
            };
            self.client = Some(client);
            self.db = Some(db);
        }
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<()> {
        self.client = None;
        self.db = None;
        Ok(())
    }
    async fn test(&mut self) -> Result<()> {
        self.connect().await?;
        self.db
            .as_ref()
            .unwrap()
            .run_command(doc! { "ping": 1 })
            .await?;
        Ok(())
    }
    async fn execute(&mut self, command: &str) -> Result<QueryResult> {
        self.connect().await?;
        let parsed: Value = serde_json::from_str(command)?;
        let object = parsed
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("MongoDB 命令必须是对象"))?;
        let (operation, payload) = object
            .iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("MongoDB 命令 JSON 不能为空"))?;
        let rows = self.run_operation(operation, payload).await?;
        Ok(QueryResult {
            row_count: Some(rows.len() as u64),
            rows,
            fields: None,
        })
    }
    async fn metadata(&mut self, request: MetadataRequest) -> Result<QueryResult> {
        if request.request_type != MetadataType::Collections {
            anyhow::bail!("MongoDB 不支持元信息类型: {:?}", request.request_type);
        }
        self.connect().await?;
        let names = self.db.as_ref().unwrap().list_collection_names().await?;
        Ok(QueryResult {
            row_count: Some(names.len() as u64),
            fields: Some(vec!["name".to_string()]),
            rows: names
                .into_iter()
                .map(|name| json!({ "name": name }))
                .collect(),
        })
    }
}

struct MongoPayload {
    collection: String,
    filter: Document,
    projection: Option<Document>,
    pipeline: Option<Vec<Document>>,
    limit: Option<i64>,
    field: Option<String>,
}

fn normalize_payload(value: &Value) -> Result<MongoPayload> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("MongoDB 命令必须是对象"))?;
    let collection = object
        .get("collection")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("MongoDB 命令必须提供 collection"))?
        .to_string();
    let filter = json_to_document(
        object
            .get("filter")
            .unwrap_or(&Value::Object(Default::default())),
    )?;
    let projection = object.get("projection").map(json_to_document).transpose()?;
    let pipeline = object.get("pipeline").map(json_to_pipeline).transpose()?;
    let limit = object
        .get("limit")
        .map(|v| {
            v.as_i64().ok_or_else(|| {
                anyhow::anyhow!("MongoDB 命令 limit 必须是 1-{MAX_QUERY_LIMIT} 的整数")
            })
        })
        .transpose()?;
    if let Some(limit) = limit {
        if !(1..=MAX_QUERY_LIMIT).contains(&limit) {
            anyhow::bail!("MongoDB 命令 limit 必须是 1-{MAX_QUERY_LIMIT} 的整数");
        }
    }
    let field = object
        .get("field")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    Ok(MongoPayload {
        collection,
        filter,
        projection,
        pipeline,
        limit,
        field,
    })
}

fn json_to_document(value: &Value) -> Result<Document> {
    Ok(mongodb::bson::to_document(value)?)
}
fn json_to_pipeline(value: &Value) -> Result<Vec<Document>> {
    serde_json::from_value::<Vec<Value>>(value.clone())?
        .into_iter()
        .map(|v| json_to_document(&v))
        .collect::<Result<Vec<_>>>()
}
fn bson_to_json<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}
