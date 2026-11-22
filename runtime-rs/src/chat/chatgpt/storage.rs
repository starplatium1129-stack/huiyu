use crate::chat::{Error, Result};
use aws_lc_rs::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

pub(super) const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Store {
    pub version: u32,
    pub host_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sealed_host_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_client_id: Option<String>,
    pub welcome_confirmed: bool,
    pub accounts: Vec<StoredAccount>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct StoredAccount {
    pub client_id: String,
    pub issuer: String,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub email_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub label: String,
    pub selected_model: String,
    pub selected_model_name: String,
    pub usage_paused: bool,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub earliest_refresh_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sealed_access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sealed_refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sealed_id_token: Option<String>,
}

impl StoredAccount {
    pub(super) fn has_session(&self) -> bool {
        self.sealed_access_token
            .as_deref()
            .is_some_and(|value| !value.is_empty())
    }

    pub(super) fn plan_enabled(&self) -> bool {
        self.has_session() && self.scopes.iter().any(|scope| scope == PLAN_SCOPE)
    }

    pub(super) fn access_token(&self) -> Result<Option<String>> {
        self.sealed_access_token.as_deref().map(open).transpose()
    }

    pub(super) fn refresh_token(&self) -> Result<Option<String>> {
        self.sealed_refresh_token.as_deref().map(open).transpose()
    }

    pub(super) fn id_token(&self) -> Result<Option<String>> {
        self.sealed_id_token.as_deref().map(open).transpose()
    }

    pub(super) fn set_tokens(
        &mut self,
        access_token: &str,
        refresh_token: Option<&str>,
        id_token: Option<&str>,
        expires_at: i64,
        earliest_refresh_at: Option<i64>,
        scopes: Vec<String>,
    ) -> Result<()> {
        self.sealed_access_token = Some(seal(access_token)?);
        if let Some(refresh) = refresh_token.filter(|value| !value.is_empty()) {
            self.sealed_refresh_token = Some(seal(refresh)?);
        }
        if let Some(id) = id_token.filter(|value| !value.is_empty()) {
            self.sealed_id_token = Some(seal(id)?);
        }
        self.expires_at = Some(expires_at);
        self.earliest_refresh_at = earliest_refresh_at;
        self.scopes = scopes;
        self.saved_at = Some(chrono::Utc::now().to_rfc3339());
        Ok(())
    }

    pub(super) fn clear_session(&mut self) {
        self.sealed_access_token = None;
        self.sealed_refresh_token = None;
        self.sealed_id_token = None;
        self.expires_at = None;
        self.earliest_refresh_at = None;
        self.scopes.clear();
        self.saved_at = None;
    }
}

impl Store {
    pub(super) fn ensure_host_id(&mut self) -> Result<(String, bool)> {
        if !self.host_id.trim().is_empty() {
            return Ok((self.host_id.clone(), false));
        }
        // Prefer RFC 9278 JWK thumbprint URI from a host Ed25519 key pair.
        let rng = SystemRandom::new();
        if let Ok(pkcs8) = Ed25519KeyPair::generate_pkcs8(&rng)
            && let Ok(pair) = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
        {
            let x = URL_SAFE_NO_PAD.encode(pair.public_key().as_ref());
            let canonical = format!(r#"{{"crv":"Ed25519","kty":"OKP","x":"{x}"}}"#);
            let digest = Sha256::digest(canonical.as_bytes());
            let thumbprint = URL_SAFE_NO_PAD.encode(digest);
            self.host_id = format!("urn:ietf:params:oauth:jwk-thumbprint:sha-256:{thumbprint}");
            if let Ok(sealed) = seal(&STANDARD.encode(pkcs8.as_ref())) {
                self.sealed_host_key = Some(sealed);
            }
        } else {
            self.host_id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
        }
        self.version = 1;
        Ok((self.host_id.clone(), true))
    }

    pub(super) fn active_account(&self) -> Option<&StoredAccount> {
        let active = self.active_client_id.as_deref()?;
        self.accounts
            .iter()
            .find(|account| account.client_id == active)
    }

    pub(super) fn account(&self, client_id: &str) -> Option<&StoredAccount> {
        self.accounts
            .iter()
            .find(|account| account.client_id == client_id)
    }

    pub(super) fn account_mut(&mut self, client_id: &str) -> Option<&mut StoredAccount> {
        self.accounts
            .iter_mut()
            .find(|account| account.client_id == client_id)
    }

    pub(super) fn distinct_label(
        &self,
        client_id: &str,
        email: Option<&str>,
        name: Option<&str>,
    ) -> String {
        let base = email
            .filter(|value| !value.trim().is_empty())
            .or_else(|| name.filter(|value| !value.trim().is_empty()))
            .map(str::trim)
            .unwrap_or("ChatGPT 账号");
        let conflict = |candidate: &str| {
            self.accounts
                .iter()
                .any(|item| item.client_id != client_id && item.label == candidate)
        };
        if !conflict(base) {
            return base.to_owned();
        }
        for index in 2..=99 {
            let candidate = format!("{base} ({index})");
            if !conflict(&candidate) {
                return candidate;
            }
        }
        let suffix: String = client_id.chars().rev().take(6).collect();
        format!("{base} ({suffix})")
    }

    pub(super) fn public_status(&self, auth_flow: Value) -> Value {
        let active = self.active_account();
        let active_client_id = active.map(|account| account.client_id.as_str());
        let signed_in = active.is_some_and(StoredAccount::has_session);
        let plan_enabled = active.is_some_and(StoredAccount::plan_enabled);
        let selected_model = active
            .map(|account| account.selected_model.as_str())
            .unwrap_or("");
        let selected_model_name = active
            .map(|account| {
                if account.selected_model_name.is_empty() {
                    account.selected_model.as_str()
                } else {
                    account.selected_model_name.as_str()
                }
            })
            .unwrap_or("");
        let accounts: Vec<Value> = self
            .accounts
            .iter()
            .map(|account| {
                json!({
                    "clientId": account.client_id,
                    "label": account.label,
                    "email": account.email,
                    "name": account.name,
                    "hasSession": account.has_session(),
                    "planEnabled": account.plan_enabled(),
                    "selectedModel": account.selected_model,
                    "selectedModelName": if account.selected_model_name.is_empty() {
                        account.selected_model.as_str()
                    } else {
                        account.selected_model_name.as_str()
                    },
                    "active": active_client_id == Some(account.client_id.as_str()),
                })
            })
            .collect();
        json!({
            "supported": true,
            "signedIn": signed_in,
            "planEnabled": plan_enabled,
            "usagePaused": plan_enabled && active.is_some_and(|account| account.usage_paused),
            "activeClientId": active_client_id,
            "selectedModel": selected_model,
            "selectedModelName": selected_model_name,
            "welcomeConfirmed": self.welcome_confirmed,
            "accounts": accounts,
            "authFlow": auth_flow,
        })
    }
}

fn path(runtime: &Path) -> PathBuf {
    runtime.join("state/chatgpt_siwc.json")
}

pub(super) async fn load(runtime: &Path) -> Result<Store> {
    let file = path(runtime);
    match tokio::fs::read(&file).await {
        Ok(bytes) => {
            if bytes.is_empty() {
                return Ok(Store {
                    version: 1,
                    ..Store::default()
                });
            }
            let mut store: Store = serde_json::from_slice(&bytes).map_err(|_| {
                Error::new(
                    503,
                    "CHATGPT_STORAGE_CORRUPT",
                    "本机 ChatGPT 凭据记录无法解析，已保留原文件；请检查后重试",
                )
            })?;
            if store.version == 0 {
                store.version = 1;
            }
            Ok(store)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Store {
            version: 1,
            ..Store::default()
        }),
        Err(_) => Err(io_error()),
    }
}

pub(super) async fn save(runtime: &Path, store: &Store) -> Result<()> {
    let file = path(runtime);
    let parent = file.parent().ok_or_else(io_error)?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|_| io_error())?;
    let (output, pending) = tempfile::Builder::new()
        .prefix("chatgpt_siwc.")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|_| io_error())?
        .into_parts();
    let mut output = tokio::fs::File::from_std(output);
    let bytes = serde_json::to_vec_pretty(store).map_err(|_| io_error())?;
    output.write_all(&bytes).await.map_err(|_| io_error())?;
    output.flush().await.map_err(|_| io_error())?;
    output.sync_all().await.map_err(|_| io_error())?;
    drop(output);
    pending.persist(&file).map_err(|_| io_error())?;
    Ok(())
}

fn io_error() -> Error {
    Error::new(
        503,
        "CHATGPT_STORAGE_ERROR",
        "无法读写本机 ChatGPT 凭据存储",
    )
}

fn seal(value: &str) -> Result<String> {
    transform(value.as_bytes(), true).map(|bytes| STANDARD.encode(bytes))
}

fn open(value: &str) -> Result<String> {
    let encrypted = STANDARD.decode(value).map_err(|_| credential_error())?;
    String::from_utf8(transform(&encrypted, false)?).map_err(|_| credential_error())
}

fn credential_error() -> Error {
    Error::new(
        503,
        "CHATGPT_CREDENTIAL_ERROR",
        "本机安全凭据无法解密，请重新登录 ChatGPT",
    )
}

#[cfg(windows)]
fn transform(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| credential_error())?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // DPAPI binds encryption to the current Windows user account; clear tokens never touch disk.
    unsafe {
        let ok = if encrypt {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 || output.pbData.is_null() {
            return Err(credential_error());
        }
        let memory = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = memory.to_vec();
        memory.fill(0);
        LocalFree(output.pbData.cast());
        Ok(result)
    }
}

#[cfg(not(windows))]
fn transform(bytes: &[u8], _encrypt: bool) -> Result<Vec<u8>> {
    // Non-Windows relies on tempfile owner-only 0600 file permissions.
    Ok(bytes.to_vec())
}
