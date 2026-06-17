use super::DatabaseAdapter;
use crate::types::{MetadataRequest, MetadataType, QueryResult};
use anyhow::Result;
use async_trait::async_trait;
use rust_decimal::Decimal;
use serde_json::{Map, Value};
use std::sync::Arc;
use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
use tokio_postgres::config::SslMode;
use tokio_postgres::types::{FromSql, Type};
use tokio_postgres::{Client, Config as PgConfig, NoTls, Row};
use uuid::Uuid;

/// How a Postgres connection should negotiate TLS, derived from the URL's
/// `sslmode` query parameter.
enum SslPlan {
    /// Plaintext only (`sslmode=disable`).
    Disable,
    /// Negotiate TLS. `mode` is `Prefer` (try TLS, fall back to plaintext) or
    /// `Require` (must encrypt). `verify` controls server-certificate checking.
    Encrypt { mode: SslMode, verify: bool },
}

/// Parse the `sslmode` query parameter out of a Postgres URL, returning the TLS
/// plan and the URL with `sslmode` stripped (so tokio-postgres, which only
/// understands disable/prefer/require, never sees `verify-ca`/`verify-full`).
///
/// Default (no `sslmode`) and `prefer`/`allow` map to "try TLS, no verification,
/// fall back to plaintext" so SSL-required servers (e.g. AWS RDS) connect while
/// local non-TLS Postgres still works. `require` forces encryption (no verify);
/// `verify-ca`/`verify-full` force encryption and verify against public CA roots.
fn plan_tls(url: &str) -> Result<(SslPlan, String)> {
    let mut parsed = url::Url::parse(url)?;
    let mut sslmode: Option<String> = None;
    let remaining: Vec<(String, String)> = parsed
        .query_pairs()
        .filter_map(|(key, value)| {
            if key.eq_ignore_ascii_case("sslmode") {
                sslmode = Some(value.to_string());
                None
            } else {
                Some((key.to_string(), value.to_string()))
            }
        })
        .collect();
    {
        let mut pairs = parsed.query_pairs_mut();
        pairs.clear();
        for (key, value) in &remaining {
            pairs.append_pair(key, value);
        }
    }
    if parsed.query() == Some("") {
        parsed.set_query(None);
    }
    let plan = match sslmode.as_deref().map(str::to_ascii_lowercase).as_deref() {
        Some("disable") => SslPlan::Disable,
        Some("require") => SslPlan::Encrypt {
            mode: SslMode::Require,
            verify: false,
        },
        Some("verify-ca") | Some("verify-full") => SslPlan::Encrypt {
            mode: SslMode::Require,
            verify: true,
        },
        _ => SslPlan::Encrypt {
            mode: SslMode::Prefer,
            verify: false,
        },
    };
    Ok((plan, parsed.to_string()))
}

/// Build a rustls-backed TLS connector. When `verify` is false the server
/// certificate is accepted unconditionally (libpq `sslmode=require` semantics:
/// encrypted but not authenticated); when true it is verified against the
/// bundled Mozilla/webpki root store.
fn make_rustls(verify: bool) -> Result<tokio_postgres_rustls::MakeRustlsConnect> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = if verify {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|error| anyhow::anyhow!("failed to build TLS config: {error}"))?
            .with_root_certificates(roots)
            .with_no_client_auth()
    } else {
        rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(|error| anyhow::anyhow!("failed to build TLS config: {error}"))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoCertVerification(provider)))
            .with_no_client_auth()
    };
    Ok(tokio_postgres_rustls::MakeRustlsConnect::new(config))
}

/// A rustls verifier that accepts any server certificate. Used for the
/// encrypt-but-do-not-verify modes; it provides confidentiality without
/// authenticating the server.
#[derive(Debug)]
struct NoCertVerification(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoCertVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

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
        if self.client.is_some() {
            return Ok(());
        }
        let (plan, url) = plan_tls(&self.url)?;
        let client = match plan {
            SslPlan::Disable => {
                let (client, connection) = tokio_postgres::connect(&url, NoTls).await?;
                tokio::spawn(async move {
                    let _ = connection.await;
                });
                client
            }
            SslPlan::Encrypt { mode, verify } => {
                let mut config: PgConfig = url.parse()?;
                config.ssl_mode(mode);
                let (client, connection) = config.connect(make_rustls(verify)?).await?;
                tokio::spawn(async move {
                    let _ = connection.await;
                });
                client
            }
        };
        self.client = Some(client);
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

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "postgres://postgres@db.example.com:5432/app";

    #[test]
    fn default_sslmode_prefers_tls_without_verification() {
        let (plan, url) = plan_tls(BASE).expect("plan");
        match plan {
            SslPlan::Encrypt { mode, verify } => {
                assert_eq!(mode, SslMode::Prefer);
                assert!(!verify);
            }
            _ => panic!("expected Encrypt"),
        }
        // No sslmode to strip, so the URL is unchanged (no stray `?`).
        assert_eq!(url, BASE);
    }

    #[test]
    fn disable_maps_to_plaintext() {
        let (plan, _) = plan_tls(&format!("{BASE}?sslmode=disable")).expect("plan");
        assert!(matches!(plan, SslPlan::Disable));
    }

    #[test]
    fn require_forces_encryption_without_verification() {
        let (plan, url) = plan_tls(&format!("{BASE}?sslmode=require")).expect("plan");
        match plan {
            SslPlan::Encrypt { mode, verify } => {
                assert_eq!(mode, SslMode::Require);
                assert!(!verify);
            }
            _ => panic!("expected Encrypt"),
        }
        // sslmode must be stripped before tokio-postgres parses the URL.
        assert!(!url.contains("sslmode"));
    }

    #[test]
    fn verify_full_enables_certificate_verification() {
        let (plan, _) = plan_tls(&format!("{BASE}?sslmode=verify-full")).expect("plan");
        match plan {
            SslPlan::Encrypt { mode, verify } => {
                assert_eq!(mode, SslMode::Require);
                assert!(verify);
            }
            _ => panic!("expected Encrypt"),
        }
    }

    #[test]
    fn sslmode_is_case_insensitive() {
        let (plan, _) = plan_tls(&format!("{BASE}?sslmode=DISABLE")).expect("plan");
        assert!(matches!(plan, SslPlan::Disable));
    }

    #[test]
    fn other_query_params_are_preserved_when_sslmode_is_stripped() {
        let (plan, url) =
            plan_tls(&format!("{BASE}?application_name=cli&sslmode=require")).expect("plan");
        assert!(matches!(plan, SslPlan::Encrypt { .. }));
        assert!(url.contains("application_name=cli"));
        assert!(!url.contains("sslmode"));
    }
}
