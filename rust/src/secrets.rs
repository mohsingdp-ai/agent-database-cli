use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const SECRET_KEY_FILE: &str = "secret.key";
const SECRETS_FILE: &str = "secrets.json";
const SECRETS_VERSION: u8 = 1;

#[derive(Debug, Serialize, Deserialize, Default)]
struct SecretsFile {
    version: u8,
    items: HashMap<String, SecretItem>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SecretItem {
    nonce: String,
    ciphertext: String,
}

fn config_dir(config_path: &Path) -> Result<PathBuf> {
    let absolute = if config_path.is_absolute() {
        config_path.to_path_buf()
    } else {
        std::env::current_dir()?.join(config_path)
    };
    absolute
        .parent()
        .map(Path::to_path_buf)
        .context("config path is missing a parent directory")
}

fn secret_key_path(config_path: &Path) -> Result<PathBuf> {
    Ok(config_dir(config_path)?.join(SECRET_KEY_FILE))
}

fn secrets_path(config_path: &Path) -> Result<PathBuf> {
    Ok(config_dir(config_path)?.join(SECRETS_FILE))
}

fn load_or_create_secret_key(config_path: &Path) -> Result<[u8; 32]> {
    let path = secret_key_path(config_path)?;
    if path.exists() {
        return load_local_secret_key(config_path);
    }
    let mut key = [0_u8; 32];
    OsRng.fill_bytes(&mut key);
    write_private_file(&path, BASE64_STANDARD.encode(key).as_bytes())?;
    Ok(key)
}

fn load_local_secret_key(config_path: &Path) -> Result<[u8; 32]> {
    let path = secret_key_path(config_path)?;
    let encoded = fs::read_to_string(&path)
        .with_context(|| format!("failed to read local secret key: {}", path.display()))?;
    let bytes = BASE64_STANDARD
        .decode(encoded.trim())
        .context("failed to read local secret key")?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("local secret key has an invalid length"))
}

fn load_secrets(config_path: &Path) -> Result<SecretsFile> {
    let path = secrets_path(config_path)?;
    if !path.exists() {
        return Ok(SecretsFile {
            version: SECRETS_VERSION,
            items: HashMap::new(),
        });
    }
    let raw = fs::read_to_string(&path)?;
    let secrets: SecretsFile =
        serde_json::from_str(&raw).context("failed to parse secrets.json")?;
    if secrets.version != SECRETS_VERSION {
        anyhow::bail!("unsupported secrets.json version");
    }
    Ok(secrets)
}

fn save_secrets(config_path: &Path, secrets: &SecretsFile) -> Result<()> {
    let path = secrets_path(config_path)?;
    let raw = serde_json::to_vec_pretty(secrets)?;
    write_private_file(&path, &raw)
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    fs::rename(tmp, path)?;
    Ok(())
}

pub fn encrypt_secret(config_path: &Path, secret_ref: &str, plaintext: &str) -> Result<()> {
    let key = load_or_create_secret_key(config_path)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let mut nonce_bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(|_| anyhow::anyhow!("failed to encrypt secret"))?;
    let mut secrets = load_secrets(config_path)?;
    secrets.items.insert(
        secret_ref.to_string(),
        SecretItem {
            nonce: BASE64_STANDARD.encode(nonce_bytes),
            ciphertext: BASE64_STANDARD.encode(ciphertext),
        },
    );
    save_secrets(config_path, &secrets)
}

pub fn decrypt_secret(config_path: &Path, secret_ref: &str) -> Result<String> {
    let key = load_local_secret_key(config_path)?;
    let secrets = load_secrets(config_path)?;
    let item = secrets
        .items
        .get(secret_ref)
        .ok_or_else(|| anyhow::anyhow!("no local secret found for secretRef: {secret_ref}"))?;
    let nonce = BASE64_STANDARD
        .decode(&item.nonce)
        .context("local secret nonce is invalid")?;
    if nonce.len() != 12 {
        anyhow::bail!("local secret nonce has an invalid length");
    }
    let ciphertext = BASE64_STANDARD
        .decode(&item.ciphertext)
        .context("local secret ciphertext is invalid")?;
    let plaintext = ChaCha20Poly1305::new(Key::from_slice(&key))
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| anyhow::anyhow!("failed to decrypt local secret: {secret_ref}"))?;
    String::from_utf8(plaintext).context("local secret has invalid encoding")
}
