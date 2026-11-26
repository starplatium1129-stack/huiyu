mod accounts;
mod auth;
mod browser;
mod http;
mod jwks;
mod session;
mod storage;

pub(super) use http::router;

use crate::chat::{Error, Result, settings::Settings};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const RESOURCE_URI: &str = "https://api.openai.com/v1";
pub(super) const MODELS_CACHE_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone)]
struct AuthFlowState {
    status: &'static str,
    error: Option<String>,
    error_code: Option<String>,
    started_at: Option<i64>,
    active_cancel: Option<Arc<CancellationToken>>,
    retry_registration: Option<String>,
}

impl Default for AuthFlowState {
    fn default() -> Self {
        Self {
            status: "idle",
            error: None,
            error_code: None,
            started_at: None,
            active_cancel: None,
            retry_registration: None,
        }
    }
}

impl AuthFlowState {
    fn to_json(&self) -> Value {
        json!({
            "status": self.status,
            "error": self.error,
            "errorCode": self.error_code,
            "startedAt": self.started_at,
            "retryRegistration": self.retry_registration.is_some(),
        })
    }

    fn owns(&self, attempt: &Arc<CancellationToken>) -> bool {
        self.active_cancel
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, attempt))
    }
}

pub(super) struct ActiveSession {
    pub access_token: String,
    pub client_id: String,
    pub model: String,
    pub saved_at: Option<String>,
    pub cancel: CancellationToken,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Model {
    pub slug: String,
    pub display_name: String,
}

#[derive(Default)]
struct AccountRuntime {
    cancel: CancellationToken,
    models: Vec<Model>,
    models_fetched_at: Option<Instant>,
}

pub(super) struct ChatGptService {
    storage_lock: Arc<Mutex<()>>,
    jwks: Arc<jwks::JwksCache>,
    flow: Arc<StdMutex<AuthFlowState>>,
    accounts: StdMutex<HashMap<String, AccountRuntime>>,
}

impl Default for ChatGptService {
    fn default() -> Self {
        Self {
            storage_lock: Arc::new(Mutex::new(())),
            jwks: Arc::new(jwks::JwksCache::default()),
            flow: Arc::new(StdMutex::new(AuthFlowState::default())),
            accounts: StdMutex::default(),
        }
    }
}

impl ChatGptService {
    pub(super) async fn vision_selection(&self, settings: &Settings) -> Option<(String, String, String)> {
        let _guard = self.storage_lock.lock().await;
        let store = storage::load(&settings.runtime).await.ok()?;
        let account = store.active_account()?;
        if !account.has_session() || !account.plan_enabled() || account.usage_paused
            || account.selected_model.is_empty()
        {
            return None;
        }
        let label = if account.selected_model_name.is_empty() {
            &account.selected_model
        } else {
            &account.selected_model_name
        };
        Some((account.client_id.clone(), account.selected_model.clone(), label.clone()))
    }

    fn stop_account(&self, client_id: &str) {
        if let Some(account) = self
            .accounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(client_id)
        {
            account.cancel.cancel();
        }
    }

    async fn status(&self, settings: &Settings) -> Result<Value> {
        let _guard = self.storage_lock.lock().await;
        let store = storage::load(&settings.runtime).await?;
        let flow = self
            .flow
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .to_json();
        Ok(store.public_status(flow))
    }
}

fn selection_changed() -> Error {
    Error::new(
        409,
        "CHATGPT_SELECTION_CHANGED",
        "ChatGPT 账号或模型已切换，请确认后重试。",
    )
}
