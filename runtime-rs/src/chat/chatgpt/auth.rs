mod callback;

use super::{
    AuthFlowState, ChatGptService, RESOURCE_URI, browser, jwks, selection_changed, storage,
};
use crate::chat::{ChatService, Duration, Error, Result, settings::Settings};
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use axum::{Router, extract::Query, routing::get};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use callback::handle_loopback_callback;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};
use tokio_util::sync::CancellationToken;
use url::Url;

const DYNAMIC_CLIENT_ID: &str = "dynamic_agent_client";
const AGENT_NAME_HINT: &str = "Huiyu";
const REQUESTED_SCOPE: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const AUTH_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Copy)]
enum AuthMode {
    New,
    RetryRegistration,
    Reauth,
    Consent,
}

struct CallbackRuntime {
    chat: Arc<ChatService>,
    runtime: PathBuf,
    discovery: jwks::Discovery,
    auth_mode: AuthMode,
    expected_client_id: Option<String>,
    expected_subject: Option<String>,
    redirect_uri: String,
    expected_state: String,
    expected_nonce: String,
    code_verifier: String,
    cancel: Arc<CancellationToken>,
    consumed: StdMutex<bool>,
}

impl ChatGptService {
    pub(super) async fn cancel_auth(&self, settings: &Settings) -> Result<Value> {
        let _guard = self.storage_lock.lock().await;
        self.cancel_pending();
        let store = storage::load(&settings.runtime).await?;
        Ok(store.public_status(self.flow.lock().unwrap().to_json()))
    }

    pub(super) fn cancel_pending(&self) {
        let mut guard = self.flow.lock().unwrap();
        if let Some(cancel) = guard.active_cancel.take() {
            cancel.cancel();
            *guard = AuthFlowState::default();
        }
    }

    pub(super) async fn start_auth(
        &self,
        chat: Arc<ChatService>,
        runtime: PathBuf,
        mode: &str,
        requested_client_id: Option<&str>,
        shutdown: CancellationToken,
    ) -> Result<Value> {
        let auth_mode = match mode {
            "" | "new" => AuthMode::New,
            "retry" => AuthMode::RetryRegistration,
            "reauth" => AuthMode::Reauth,
            "consent" => AuthMode::Consent,
            _ => return Err(Error::invalid("无效的授权模式")),
        };

        let discovery = self.jwks.discovery(&chat.transport).await?;
        let retry_registration = self.flow.lock().unwrap().retry_registration.clone();

        let (host_id, target_client_id, id_token_hint, login_hint, expected_subject) = {
            let _guard = self.storage_lock.lock().await;
            let mut store = storage::load(&runtime).await?;
            let (host_id, created) = store.ensure_host_id()?;
            if created {
                storage::save(&runtime, &store).await?;
            }
            match auth_mode {
                AuthMode::New => (host_id, None, None, None, None),
                AuthMode::RetryRegistration => {
                    let id = retry_registration
                        .clone()
                        .ok_or_else(|| Error::invalid("没有可以重试的 ChatGPT 注册"))?;
                    (host_id, Some(id), None, None, None)
                }
                AuthMode::Reauth | AuthMode::Consent => {
                    let id = requested_client_id
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .or(store.active_client_id.as_deref())
                        .ok_or_else(|| Error::invalid("未找到可重新授权的 ChatGPT 账号"))?;
                    let account = store
                        .account(id)
                        .ok_or_else(|| Error::invalid("指定的 ChatGPT 账号不存在"))?;
                    let id_hint = account.id_token().ok().flatten();
                    let email_hint = account.email.clone();
                    (
                        host_id,
                        Some(account.client_id.clone()),
                        id_hint,
                        email_hint,
                        Some(account.subject.clone()),
                    )
                }
            }
        };

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| Error::new(503, "LOOPBACK_BIND_FAILED", "无法启动本地 OAuth 回调监听"))?;
        let port = listener
            .local_addr()
            .map_err(|_| Error::new(503, "LOOPBACK_BIND_FAILED", "无法读取本地回调端口"))?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}/auth/callback");

        let state_token = random_base64url(32)?;
        let nonce = random_base64url(32)?;
        let code_verifier = random_base64url(64)?;
        let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));

        let mut authorize_url = Url::parse(&discovery.authorization_endpoint)
            .map_err(|_| Error::new(503, "CHATGPT_AUTH_CONFIG", "OpenAI 授权端点无效"))?;
        {
            let mut query = authorize_url.query_pairs_mut();
            match auth_mode {
                AuthMode::New => {
                    query.append_pair("client_id", DYNAMIC_CLIENT_ID);
                    query.append_pair("agent_name_hint", AGENT_NAME_HINT);
                }
                AuthMode::RetryRegistration | AuthMode::Reauth | AuthMode::Consent => {
                    query.append_pair("client_id", target_client_id.as_deref().unwrap_or(""));
                    if let Some(id_hint) = id_token_hint.as_deref() {
                        query.append_pair("id_token_hint", id_hint);
                    }
                    if let Some(email) = login_hint.as_deref() {
                        query.append_pair("login_hint", email);
                    }
                    if matches!(auth_mode, AuthMode::Consent) {
                        query.append_pair("prompt", "consent");
                    }
                }
            }
            query.append_pair("ext_agent_host_id", &host_id);
            query.append_pair("response_type", "code");
            query.append_pair("redirect_uri", &redirect_uri);
            query.append_pair("scope", REQUESTED_SCOPE);
            query.append_pair("resource", RESOURCE_URI);
            query.append_pair("state", &state_token);
            query.append_pair("nonce", &nonce);
            query.append_pair("code_challenge_method", "S256");
            query.append_pair("code_challenge", &code_challenge);
        }

        let _storage = self.storage_lock.lock().await;
        let store = storage::load(&runtime).await?;
        if matches!(auth_mode, AuthMode::Reauth | AuthMode::Consent)
            && target_client_id
                .as_deref()
                .and_then(|id| store.account(id))
                .is_none()
        {
            return Err(selection_changed());
        }
        let attempt_cancel = Arc::new(shutdown.child_token());
        let started_at = chrono::Utc::now().timestamp_millis();
        {
            let mut guard = self.flow.lock().unwrap();
            if guard.active_cancel.is_some() {
                return Err(Error::new(
                    409,
                    "CHATGPT_AUTH_PENDING",
                    "已有 ChatGPT 登录正在等待完成。",
                ));
            }
            if matches!(auth_mode, AuthMode::RetryRegistration)
                && guard.retry_registration != retry_registration
            {
                return Err(Error::invalid("待重试的 ChatGPT 注册已改变"));
            }
            *guard = AuthFlowState {
                status: "pending",
                started_at: Some(started_at),
                active_cancel: Some(attempt_cancel.clone()),
                ..AuthFlowState::default()
            };
        }

        let callback_state = Arc::new(CallbackRuntime {
            chat: chat.clone(),
            runtime,
            discovery,
            auth_mode,
            expected_client_id: target_client_id,
            expected_subject,
            redirect_uri,
            expected_state: state_token,
            expected_nonce: nonce,
            code_verifier,
            cancel: attempt_cancel.clone(),
            consumed: StdMutex::new(false),
        });

        let callback_app = Router::new().route(
            "/auth/callback",
            get({
                let callback_state = callback_state.clone();
                move |Query(params): Query<HashMap<String, String>>| {
                    let callback_state = callback_state.clone();
                    async move { handle_loopback_callback(callback_state, params).await }
                }
            }),
        );

        let server_cancel = attempt_cancel.clone();
        let flow_ref = self.flow.clone();
        let storage_lock = self.storage_lock.clone();
        tokio::spawn(async move {
            let serve = axum::serve(listener, callback_app).with_graceful_shutdown({
                let cancel = server_cancel.clone();
                async move {
                    cancel.cancelled().await;
                }
            });
            tokio::select! {
                _ = serve => {}
                _ = tokio::time::sleep(AUTH_TIMEOUT) => {
                    let _guard = storage_lock.lock().await;
                    let mut guard = flow_ref.lock().unwrap();
                    if guard.owns(&server_cancel) {
                        guard.status = "error";
                        guard.error_code = Some("CHATGPT_AUTH_TIMEOUT".into());
                        guard.error = Some("登录超时（10 分钟未完成），请重新点击 Continue with ChatGPT。".into());
                        guard.active_cancel = None;
                    }
                    server_cancel.cancel();
                }
            }
        });

        if let Err(error) = browser::open_system_browser(authorize_url.as_str()) {
            attempt_cancel.cancel();
            let mut guard = self.flow.lock().unwrap();
            if guard.owns(&attempt_cancel) {
                guard.status = "error";
                guard.error_code = Some(error.code.clone());
                guard.error = Some(error.message.clone());
                guard.active_cancel = None;
            }
            return Err(error);
        }

        Ok(store.public_status(self.flow.lock().unwrap().to_json()))
    }
}

fn random_base64url(len: usize) -> Result<String> {
    let mut bytes = vec![0u8; len];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::new(500, "RNG_FAILED", "无法生成安全随机数"))?;
    Ok(URL_SAFE_NO_PAD.encode(&bytes))
}
