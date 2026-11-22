mod browser;
mod jwks;
mod storage;

use crate::{
    AppState,
    chat::{
        ChatService, Duration, Error, Result, local, responses, running,
        settings::Settings,
        transport::{self, Request, Transport},
    },
};
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use url::Url;

const DYNAMIC_CLIENT_ID: &str = "dynamic_agent_client";
const AGENT_NAME_HINT: &str = "Huiyu";
const RESOURCE_URI: &str = "https://api.openai.com/v1";
const MODELS_URL: &str = "https://api.openai.com/v1/models";
const REQUESTED_SCOPE: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const AUTH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const REFRESH_LEEWAY_SECONDS: i64 = 120;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    slug: String,
    display_name: String,
}

#[derive(Default)]
struct AccountRuntime {
    cancel: CancellationToken,
    models: Vec<Model>,
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

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/chat/chatgpt/status", get(status_handler))
        .route(
            "/api/chat/chatgpt/auth/start",
            post(start_auth_handler).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/chat/chatgpt/auth/cancel",
            post(cancel_auth_handler).layer(DefaultBodyLimit::max(1024)),
        )
        .route("/api/chat/chatgpt/models", get(models_handler))
        .route(
            "/api/chat/chatgpt/accounts/select",
            post(select_account_handler).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/chat/chatgpt/accounts/model",
            post(select_model_handler).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/chat/chatgpt/usage/resume",
            post(resume_usage_handler).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/chat/chatgpt/accounts/remove",
            post(remove_account_handler).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/chat/chatgpt/welcome-confirm",
            post(confirm_welcome_handler).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/chat/chatgpt/sign-out",
            post(sign_out_handler).layer(DefaultBodyLimit::max(4 * 1024)),
        )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartAuthRequest {
    #[serde(default)]
    mode: String,
    #[serde(default)]
    client_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectAccountRequest {
    client_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectModelRequest {
    client_id: String,
    model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignOutRequest {
    #[serde(default)]
    client_id: Option<String>,
}

async fn status_handler(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = local(&headers, peer).and_then(|()| running(&app)) {
        return error.into_response();
    }
    let settings = chat.settings(&app).await;
    match chat.chatgpt.status(settings).await {
        Ok(value) => no_store_json(value),
        Err(error) => error.into_response(),
    }
}

async fn start_auth_handler(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    payload: std::result::Result<Json<StartAuthRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if let Err(error) = local(&headers, peer).and_then(|()| running(&app)) {
        return error.into_response();
    }
    let Json(payload) = match payload {
        Ok(value) => value,
        Err(_) => return Error::invalid("授权请求格式无效").into_response(),
    };
    let settings = chat.settings(&app).await;
    match chat
        .chatgpt
        .start_auth(
            chat.clone(),
            settings.runtime.clone(),
            &payload.mode,
            payload.client_id.as_deref(),
            app.shutdown.clone(),
        )
        .await
    {
        Ok(value) => no_store_json(value),
        Err(error) => error.into_response(),
    }
}

async fn cancel_auth_handler(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = local(&headers, peer).and_then(|()| running(&app)) {
        return error.into_response();
    }
    let settings = chat.settings(&app).await;
    match chat.chatgpt.cancel_auth(settings).await {
        Ok(value) => no_store_json(value),
        Err(error) => error.into_response(),
    }
}

async fn models_handler(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = local(&headers, peer).and_then(|()| running(&app)) {
        return error.into_response();
    }
    let settings = chat.settings(&app).await;
    let cancel = app.shutdown.child_token();
    match chat
        .chatgpt
        .list_models(&chat.transport, settings, &cancel)
        .await
    {
        Ok(value) => no_store_json(value),
        Err(error) => error.into_response(),
    }
}

async fn select_account_handler(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    payload: std::result::Result<
        Json<SelectAccountRequest>,
        axum::extract::rejection::JsonRejection,
    >,
) -> Response {
    if let Err(error) = local(&headers, peer).and_then(|()| running(&app)) {
        return error.into_response();
    }
    let Json(payload) = match payload {
        Ok(value) => value,
        Err(_) => return Error::invalid("账号选择参数无效").into_response(),
    };
    let settings = chat.settings(&app).await;
    match chat
        .chatgpt
        .select_account(settings, &payload.client_id)
        .await
    {
        Ok(value) => no_store_json(value),
        Err(error) => error.into_response(),
    }
}

async fn select_model_handler(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    payload: std::result::Result<Json<SelectModelRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if let Err(error) = local(&headers, peer).and_then(|()| running(&app)) {
        return error.into_response();
    }
    let Json(payload) = match payload {
        Ok(value) => value,
        Err(_) => return Error::invalid("模型选择参数无效").into_response(),
    };
    let settings = chat.settings(&app).await;
    match chat
        .chatgpt
        .select_model(settings, &payload.client_id, &payload.model)
        .await
    {
        Ok(value) => no_store_json(value),
        Err(error) => error.into_response(),
    }
}

async fn resume_usage_handler(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    payload: std::result::Result<
        Json<SelectAccountRequest>,
        axum::extract::rejection::JsonRejection,
    >,
) -> Response {
    if let Err(error) = local(&headers, peer).and_then(|()| running(&app)) {
        return error.into_response();
    }
    let Json(payload) = match payload {
        Ok(value) => value,
        Err(_) => return Error::invalid("恢复发送参数无效").into_response(),
    };
    match chat
        .chatgpt
        .resume_usage(chat.settings(&app).await, &payload.client_id)
        .await
    {
        Ok(value) => no_store_json(value),
        Err(error) => error.into_response(),
    }
}

async fn remove_account_handler(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    payload: std::result::Result<
        Json<SelectAccountRequest>,
        axum::extract::rejection::JsonRejection,
    >,
) -> Response {
    if let Err(error) = local(&headers, peer).and_then(|()| running(&app)) {
        return error.into_response();
    }
    let Json(payload) = match payload {
        Ok(value) => value,
        Err(_) => return Error::invalid("账号移除参数无效").into_response(),
    };
    let settings = chat.settings(&app).await;
    match chat
        .chatgpt
        .remove_account(&chat.transport, settings, &payload.client_id)
        .await
    {
        Ok(value) => no_store_json(value),
        Err(error) => error.into_response(),
    }
}

async fn confirm_welcome_handler(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = local(&headers, peer).and_then(|()| running(&app)) {
        return error.into_response();
    }
    let settings = chat.settings(&app).await;
    match chat.chatgpt.confirm_welcome(settings).await {
        Ok(value) => no_store_json(value),
        Err(error) => error.into_response(),
    }
}

async fn sign_out_handler(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    payload: std::result::Result<Json<SignOutRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if let Err(error) = local(&headers, peer).and_then(|()| running(&app)) {
        return error.into_response();
    }
    let Json(payload) = match payload {
        Ok(value) => value,
        Err(_) => return Error::invalid("退出登录参数无效").into_response(),
    };
    let settings = chat.settings(&app).await;
    match chat
        .chatgpt
        .sign_out(&chat.transport, settings, payload.client_id.as_deref())
        .await
    {
        Ok(value) => no_store_json(value),
        Err(error) => error.into_response(),
    }
}

fn no_store_json(value: Value) -> Response {
    let mut response = Json(value).into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

impl ChatGptService {
    fn stop_account(&self, client_id: &str) {
        if let Some(account) = self.accounts.lock().unwrap().remove(client_id) {
            account.cancel.cancel();
        }
    }

    async fn status(&self, settings: &Settings) -> Result<Value> {
        let _guard = self.storage_lock.lock().await;
        let store = storage::load(&settings.runtime).await?;
        let flow = self.flow.lock().unwrap().to_json();
        Ok(store.public_status(flow))
    }

    async fn cancel_auth(&self, settings: &Settings) -> Result<Value> {
        let _guard = self.storage_lock.lock().await;
        self.cancel_pending();
        let store = storage::load(&settings.runtime).await?;
        Ok(store.public_status(self.flow.lock().unwrap().to_json()))
    }

    fn cancel_pending(&self) {
        let mut guard = self.flow.lock().unwrap();
        if let Some(cancel) = guard.active_cancel.take() {
            cancel.cancel();
            *guard = AuthFlowState::default();
        }
    }

    async fn start_auth(
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

    pub(super) async fn ensure_access_token(
        &self,
        transport: &Transport,
        settings: &Settings,
        requested_client_id: Option<&str>,
        for_inference: bool,
        cancel: &CancellationToken,
    ) -> Result<ActiveSession> {
        let guard = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "聊天已停止")),
            guard = self.storage_lock.clone().lock_owned() => guard,
        };
        let mut store = storage::load(&settings.runtime).await?;
        let active_id = store.active_client_id.clone().ok_or_else(|| {
            Error::new(
                401,
                "CHATGPT_NOT_SIGNED_IN",
                "尚未登录 ChatGPT，请在聊天设置中点击 Continue with ChatGPT。",
            )
        })?;
        if requested_client_id.is_some_and(|id| id != active_id) {
            return Err(selection_changed());
        }
        let account = store.account(&active_id).ok_or_else(|| {
            Error::new(
                401,
                "CHATGPT_NOT_SIGNED_IN",
                "尚未登录 ChatGPT，请在聊天设置中点击 Continue with ChatGPT。",
            )
        })?;
        if !account.has_session() {
            return Err(Error::new(
                401,
                "CHATGPT_REAUTH_REQUIRED",
                "当前 ChatGPT 会话已失效或已退出，请重新登录。",
            ));
        }
        if !account.plan_enabled() {
            return Err(Error::new(
                403,
                "CHATGPT_PLAN_NOT_ENABLED",
                "尚未开启 ChatGPT 订阅额度使用权限，请在聊天设置中重新授权或改用 API 服务。",
            ));
        }
        if for_inference && account.usage_paused {
            return Err(Error::new(
                429,
                "CHATGPT_USAGE_LIMIT",
                "ChatGPT 订阅额度已达上限。请查看用量，确认后恢复发送。",
            ));
        }
        let session_cancel = self
            .accounts
            .lock()
            .unwrap()
            .entry(active_id.clone())
            .or_default()
            .cancel
            .clone();

        let now = chrono::Utc::now().timestamp();
        let needs_refresh = account
            .expires_at
            .is_none_or(|exp| now + REFRESH_LEEWAY_SECONDS >= exp);
        let can_refresh_now = account
            .earliest_refresh_at
            .is_none_or(|earliest| now >= earliest)
            || account.expires_at.is_none_or(|exp| now >= exp);

        if !needs_refresh
            || !can_refresh_now
            || (account.sealed_refresh_token.is_none()
                && account.expires_at.is_some_and(|exp| exp > now))
        {
            let access_token = account.access_token()?.ok_or_else(|| {
                Error::new(
                    401,
                    "CHATGPT_REAUTH_REQUIRED",
                    "ChatGPT 访问凭据缺失，请重新登录。",
                )
            })?;
            return Ok(ActiveSession {
                access_token,
                client_id: account.client_id.clone(),
                model: account.selected_model.clone(),
                saved_at: account.saved_at.clone(),
                cancel: session_cancel,
            });
        }

        let Some(refresh_token) = account.refresh_token()? else {
            if let Some(account) = store.account_mut(&active_id) {
                account.clear_session();
            }
            self.stop_account(&active_id);
            storage::save(&settings.runtime, &store).await?;
            return Err(Error::new(
                401,
                "CHATGPT_REAUTH_REQUIRED",
                "ChatGPT 登录已过期，请重新登录。",
            ));
        };
        let discovery = tokio::select! {
            _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "聊天已停止")),
            result = self.jwks.discovery(transport) => result?,
        };
        let token_url = Url::parse(&discovery.token_endpoint)
            .map_err(|_| Error::new(503, "CHATGPT_AUTH_CONFIG", "OpenAI 令牌端点无效"))?;
        let runtime = settings.runtime.clone();
        let transport = transport.clone();
        // Finish writing a rotating refresh token even if the caller closes the chat.
        let pending = tokio::spawn(async move {
            let _guard = guard;
            Self::refresh_tokens(
                &transport,
                &runtime,
                store,
                active_id,
                refresh_token,
                token_url,
                session_cancel,
            )
            .await
        });
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Error::stream("ABORTED", "聊天已停止")),
            result = pending => result.map_err(|_| Error::stream("CHATGPT_REFRESH_UNAVAILABLE", "ChatGPT 登录刷新未能完成"))?,
        }
    }

    async fn refresh_tokens(
        transport: &Transport,
        runtime: &Path,
        mut store: storage::Store,
        client_id: String,
        refresh_token: String,
        token_url: Url,
        session_cancel: CancellationToken,
    ) -> Result<ActiveSession> {
        let form = [
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("resource", RESOURCE_URI),
        ];
        let response = transport
            .send_form(token_url, &form, Duration::from_secs(20))
            .await?;
        let status = response.status();
        let bytes = transport::bounded(response, 128 * 1024).await?;
        let body: Value = serde_json::from_slice(bytes.as_ref()).unwrap_or_default();

        if !status.is_success() {
            let code = body["error"]
                .as_str()
                .or_else(|| body["error"]["code"].as_str())
                .or_else(|| body["code"].as_str())
                .unwrap_or("");
            if matches!(
                code,
                "invalid_grant"
                    | "invalid_refresh_token"
                    | "token_expired"
                    | "refresh_token_expired"
                    | "refresh_token_invalidated"
                    | "refresh_token_reused"
            ) {
                session_cancel.cancel();
                if let Some(account) = store.account_mut(&client_id) {
                    account.clear_session();
                }
                storage::save(runtime, &store).await?;
                return Err(Error::new(
                    401,
                    "CHATGPT_REAUTH_REQUIRED",
                    "ChatGPT 会话已失效或已在设置中断开，请重新登录。",
                ));
            }
            if code == "invalid_client" {
                return Err(Error::new(
                    401,
                    "CHATGPT_INVALID_CLIENT",
                    "ChatGPT 客户端注册无效，请添加新的账号连接或重新登录。",
                ));
            }
            return Err(Error::new(
                503,
                "CHATGPT_REFRESH_UNAVAILABLE",
                "暂时无法刷新 ChatGPT 登录令牌，本地凭据已保留，请稍后重试。",
            ));
        }

        let access_token = body["access_token"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::new(
                    503,
                    "CHATGPT_REFRESH_UNAVAILABLE",
                    "OpenAI 令牌刷新响应缺少访问令牌，请稍后重试。",
                )
            })?;
        let replacement_refresh = body["refresh_token"].as_str();
        let expires_at = token_expiry(&body);
        let earliest_refresh_at = parse_earliest_refresh(&body["earliest_refresh_at"]);
        let account = store
            .account_mut(&client_id)
            .ok_or_else(|| Error::new(401, "CHATGPT_NOT_SIGNED_IN", "ChatGPT 账号不存在"))?;
        let scopes = match body.get("scope") {
            Some(scope) => parse_scopes(scope.as_str()),
            None => account.scopes.clone(),
        };
        account.set_tokens(
            access_token,
            replacement_refresh,
            None,
            expires_at,
            earliest_refresh_at,
            scopes,
        )?;
        let plan_enabled = account.plan_enabled();
        let model = account.selected_model.clone();
        let saved_at = account.saved_at.clone();
        storage::save(runtime, &store).await?;

        if !plan_enabled {
            session_cancel.cancel();
            return Err(Error::new(
                403,
                "CHATGPT_PLAN_NOT_ENABLED",
                "ChatGPT 订阅额度授权已关闭，请在聊天设置中重新授权或改用 API 服务。",
            ));
        }
        Ok(ActiveSession {
            access_token: access_token.to_owned(),
            client_id,
            model,
            saved_at,
            cancel: session_cancel,
        })
    }

    pub(super) async fn handle_upstream_failure(
        &self,
        runtime: &Path,
        client_id: &str,
        saved_at: Option<&str>,
        code: &str,
    ) -> Result<()> {
        if !matches!(
            code,
            "subscription_sharing_invalid_user" | "subscription_sharing_usage_limit_exceeded"
        ) {
            return Ok(());
        }
        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(runtime).await?;
        if let Some(account) = store
            .account_mut(client_id)
            .filter(|account| account.has_session())
        {
            match code {
                "subscription_sharing_invalid_user" if account.saved_at.as_deref() == saved_at => {
                    account.clear_session();
                    self.stop_account(client_id);
                }
                "subscription_sharing_usage_limit_exceeded" if !account.usage_paused => {
                    account.usage_paused = true;
                }
                _ => return Ok(()),
            }
            storage::save(runtime, &store).await?;
        }
        Ok(())
    }

    async fn list_models(
        &self,
        transport: &Transport,
        settings: &Settings,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let session = self
            .ensure_access_token(transport, settings, None, false, cancel)
            .await?;
        let target = Url::parse(MODELS_URL).map_err(|_| Error::invalid("模型列表地址无效"))?;
        let response = tokio::select! {
            _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "已取消获取模型")),
            result = transport.send(
                target,
                Request {
                    body: None,
                    key: &session.access_token,
                    session_id: None,
                    public_only: false,
                    idle: Duration::from_secs(20),
                    total: Duration::from_secs(25),
                    accept: "application/json",
                },
            ) => result?,
        };
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let request_id = responses::request_id(response.headers());
            let bytes = transport::bounded(response, 64 * 1024).await?;
            let body: Value = serde_json::from_slice(bytes.as_ref()).unwrap_or_default();
            self.handle_upstream_failure(
                &settings.runtime,
                &session.client_id,
                session.saved_at.as_deref(),
                responses::upstream_code(&body),
            )
            .await?;
            return Err(responses::siwc_error(status, body, request_id.as_deref()));
        }
        let bytes = transport::bounded(response, 2 * 1024 * 1024).await?;
        let data: Value = serde_json::from_slice(bytes.as_ref())
            .map_err(|_| Error::stream("INVALID_MODEL_LIST", "模型目录不是有效 JSON"))?;

        let items = data["models"].as_array().ok_or_else(|| {
            Error::stream(
                "INVALID_MODEL_LIST",
                "OpenAI 未返回当前账号的 ChatGPT 模型目录",
            )
        })?;
        let mut seen = std::collections::HashSet::new();
        let models: Vec<Model> = items
            .iter()
            .filter_map(|item| {
                let slug = item["slug"].as_str()?.trim();
                if item["visibility"] != "list"
                    || slug.is_empty()
                    || slug.len() > 200
                    || slug.chars().any(char::is_control)
                    || !seen.insert(slug)
                {
                    return None;
                }
                let display_name = item["display_name"]
                    .as_str()
                    .map(str::trim)
                    .filter(|name| {
                        !name.is_empty() && name.len() <= 200 && !name.chars().any(char::is_control)
                    })
                    .unwrap_or(slug);
                Some(Model {
                    slug: slug.into(),
                    display_name: display_name.into(),
                })
            })
            .collect();

        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(&settings.runtime).await?;
        let account = active_account_mut(&mut store, &session.client_id)?;
        if account.saved_at != session.saved_at {
            return Err(selection_changed());
        }
        let selected = models
            .iter()
            .find(|model| model.slug == account.selected_model)
            .or_else(|| models.first());
        let (slug, name) = selected.map_or(("", ""), |model| {
            (model.slug.as_str(), model.display_name.as_str())
        });
        if account.selected_model != slug || account.selected_model_name != name {
            account.selected_model = slug.to_owned();
            account.selected_model_name = name.to_owned();
            storage::save(&settings.runtime, &store).await?;
        }
        let result = json!({
            "ok": true,
            "clientId": session.client_id,
            "models": models,
            "selectedModel": slug,
            "selectedModelName": name,
        });
        self.accounts
            .lock()
            .unwrap()
            .entry(session.client_id)
            .or_default()
            .models = models;
        Ok(result)
    }

    async fn select_account(&self, settings: &Settings, client_id: &str) -> Result<Value> {
        let client_id = client_id.trim();
        if client_id.is_empty() {
            return Err(Error::invalid("账号标识不能为空"));
        }
        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(&settings.runtime).await?;
        if !store
            .account(client_id)
            .is_some_and(storage::StoredAccount::has_session)
        {
            return Err(Error::new(
                401,
                "CHATGPT_REAUTH_REQUIRED",
                "请先重新登录所选 ChatGPT 账号",
            ));
        }
        store.active_client_id = Some(client_id.to_owned());
        storage::save(&settings.runtime, &store).await?;
        let flow = self.flow.lock().unwrap().to_json();
        Ok(store.public_status(flow))
    }

    async fn select_model(
        &self,
        settings: &Settings,
        client_id: &str,
        model: &str,
    ) -> Result<Value> {
        let model = model.trim();
        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(&settings.runtime).await?;
        let account = active_account_mut(&mut store, client_id)?;
        let display_name = self
            .accounts
            .lock()
            .unwrap()
            .get(client_id)
            .and_then(|state| state.models.iter().find(|entry| entry.slug == model))
            .map(|entry| entry.display_name.clone())
            .ok_or_else(|| {
                Error::new(
                    400,
                    "CHATGPT_MODEL_UNAVAILABLE",
                    "所选模型不可用，请刷新 ChatGPT 模型列表",
                )
            })?;
        account.selected_model = model.to_owned();
        account.selected_model_name = display_name;
        storage::save(&settings.runtime, &store).await?;
        let flow = self.flow.lock().unwrap().to_json();
        Ok(store.public_status(flow))
    }

    async fn resume_usage(&self, settings: &Settings, client_id: &str) -> Result<Value> {
        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(&settings.runtime).await?;
        let account = active_account_mut(&mut store, client_id)?;
        if account.usage_paused {
            account.usage_paused = false;
            storage::save(&settings.runtime, &store).await?;
        }
        Ok(store.public_status(self.flow.lock().unwrap().to_json()))
    }

    async fn confirm_welcome(&self, settings: &Settings) -> Result<Value> {
        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(&settings.runtime).await?;
        store.welcome_confirmed = true;
        storage::save(&settings.runtime, &store).await?;
        let flow = self.flow.lock().unwrap().to_json();
        Ok(store.public_status(flow))
    }

    async fn sign_out(
        &self,
        transport: &Transport,
        settings: &Settings,
        requested_client_id: Option<&str>,
    ) -> Result<Value> {
        let _guard = self.storage_lock.lock().await;
        self.cancel_pending();
        let mut store = storage::load(&settings.runtime).await?;
        let target_id = requested_client_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| store.active_client_id.clone());
        let Some(client_id) = target_id else {
            let flow = self.flow.lock().unwrap().to_json();
            return Ok(
                json!({ "ok": true, "remoteRevoked": true, "status": store.public_status(flow) }),
            );
        };
        self.stop_account(&client_id);
        let remote_revoked = self
            .revoke_account(transport, store.account(&client_id))
            .await;
        if let Some(account) = store.account_mut(&client_id) {
            account.clear_session();
        }
        storage::save(&settings.runtime, &store).await?;
        let flow = self.flow.lock().unwrap().to_json();
        Ok(json!({
            "ok": true,
            "remoteRevoked": remote_revoked,
            "status": store.public_status(flow),
        }))
    }

    async fn remove_account(
        &self,
        transport: &Transport,
        settings: &Settings,
        client_id: &str,
    ) -> Result<Value> {
        let client_id = client_id.trim();
        if client_id.is_empty() {
            return Err(Error::invalid("账号标识不能为空"));
        }
        let _guard = self.storage_lock.lock().await;
        self.cancel_pending();
        let mut store = storage::load(&settings.runtime).await?;
        self.stop_account(client_id);
        let remote_revoked = self
            .revoke_account(transport, store.account(client_id))
            .await;
        store
            .accounts
            .retain(|account| account.client_id != client_id);
        if store.active_client_id.as_deref() == Some(client_id) {
            store.active_client_id = store
                .accounts
                .iter()
                .find(|account| account.plan_enabled())
                .or_else(|| store.accounts.iter().find(|account| account.has_session()))
                .map(|account| account.client_id.clone());
        }
        storage::save(&settings.runtime, &store).await?;
        let flow = self.flow.lock().unwrap().to_json();
        Ok(json!({
            "ok": true,
            "remoteRevoked": remote_revoked,
            "status": store.public_status(flow),
        }))
    }

    async fn revoke_account(
        &self,
        transport: &Transport,
        account: Option<&storage::StoredAccount>,
    ) -> bool {
        let Some(account) = account else { return true };
        match account.refresh_token() {
            Ok(Some(token)) => {
                self.revoke_refresh_token(transport, &account.client_id, &token)
                    .await
            }
            Ok(None) => true,
            Err(_) => false,
        }
    }

    async fn revoke_refresh_token(
        &self,
        transport: &Transport,
        client_id: &str,
        refresh_token: &str,
    ) -> bool {
        let revocation_url =
            tokio::time::timeout(Duration::from_secs(8), self.jwks.discovery(transport))
                .await
                .ok()
                .and_then(|result| result.ok())
                .and_then(|doc| doc.revocation_endpoint)
                .unwrap_or_else(|| "https://auth.openai.com/api/accounts/oauth/revoke".into());
        let Ok(target) = Url::parse(&revocation_url) else {
            return false;
        };
        let delays = [
            Duration::from_millis(0),
            Duration::from_millis(350),
            Duration::from_millis(900),
        ];
        for delay in delays {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            match transport
                .send_form(
                    target.clone(),
                    &[
                        ("token", refresh_token),
                        ("token_type_hint", "refresh_token"),
                        ("client_id", client_id),
                    ],
                    Duration::from_secs(5),
                )
                .await
            {
                Ok(response) if response.status() == StatusCode::OK => return true,
                Ok(response) if response.status().is_client_error() => return false,
                _ => continue,
            }
        }
        false
    }
}

fn active_account_mut<'a>(
    store: &'a mut storage::Store,
    client_id: &str,
) -> Result<&'a mut storage::StoredAccount> {
    if store.active_client_id.as_deref() != Some(client_id) {
        return Err(selection_changed());
    }
    store
        .account_mut(client_id)
        .filter(|account| account.plan_enabled())
        .ok_or_else(|| {
            Error::new(
                409,
                "CHATGPT_PLAN_NOT_ENABLED",
                "请先登录并授权使用 ChatGPT 订阅额度",
            )
        })
}

fn selection_changed() -> Error {
    Error::new(
        409,
        "CHATGPT_SELECTION_CHANGED",
        "ChatGPT 账号或模型已切换，请确认后重试。",
    )
}

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

async fn handle_loopback_callback(
    ctx: Arc<CallbackRuntime>,
    params: HashMap<String, String>,
) -> Response {
    if params.get("state") != Some(&ctx.expected_state) {
        return callback_html(
            StatusCode::BAD_REQUEST,
            "登录状态校验失败",
            "请继续使用绘遇打开的授权页面完成登录。",
        );
    }
    {
        let mut consumed = ctx.consumed.lock().unwrap();
        if *consumed {
            return callback_html(
                StatusCode::CONFLICT,
                "此授权回执已收到",
                "请返回绘遇查看登录结果。",
            );
        }
        *consumed = true;
    }

    let (record, retry_registration) = match callback_code(&ctx, &params) {
        Ok((code, client_id)) => {
            let exchange = tokio::select! {
                biased;
                _ = ctx.cancel.cancelled() => return cancelled_callback(),
                result = tokio::time::timeout(Duration::from_secs(45), exchange_code(&ctx, code, &client_id)) => {
                    result.unwrap_or_else(|_| Err(Error::new(504, "CHATGPT_CALLBACK_TIMEOUT", "交换授权令牌超时，请返回绘遇重试。")))
                }
            };
            let retry = (matches!(ctx.auth_mode, AuthMode::New | AuthMode::RetryRegistration)
                && exchange
                    .as_ref()
                    .is_err_and(|error| error.code == "CHATGPT_INVALID_GRANT"))
            .then_some(client_id);
            (exchange, retry)
        }
        Err(error) => (Err(error), None),
    };

    let service = &ctx.chat.chatgpt;
    let _guard = service.storage_lock.lock().await;
    if ctx.cancel.is_cancelled() || !service.flow.lock().unwrap().owns(&ctx.cancel) {
        return cancelled_callback();
    }
    let outcome = match record {
        Ok(record) => save_registration(&ctx, record).await,
        Err(error) => Err(error),
    };
    {
        let mut flow = service.flow.lock().unwrap();
        flow.active_cancel = None;
        flow.retry_registration = retry_registration;
        match &outcome {
            Ok(_) => flow.status = "completed",
            Err(error) => {
                flow.status = "error";
                flow.error_code = Some(error.code.clone());
                flow.error = Some(error.message.clone());
            }
        }
    }

    // Defer shutdown slightly so the HTTP response finishes flushing to the browser.
    let cancel = ctx.cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        cancel.cancel();
    });

    match outcome {
        Ok(true) => callback_html(
            StatusCode::OK,
            "已连接 ChatGPT 订阅",
            "授权成功，现在可以关闭此标签页并返回绘遇开始对话。",
        ),
        Ok(false) => callback_html(
            StatusCode::OK,
            "已登录 ChatGPT 账号",
            "尚未开启 ChatGPT 订阅额度权限。你可以关闭此标签页，并在绘遇聊天设置中开启权限或切换其他模型。",
        ),
        Err(error) => callback_html(error.status, "ChatGPT 登录未完成", &error.message),
    }
}

fn cancelled_callback() -> Response {
    callback_html(
        StatusCode::GONE,
        "登录已结束",
        "请返回绘遇重新发起 ChatGPT 登录。",
    )
}

fn callback_code<'a>(
    ctx: &CallbackRuntime,
    params: &'a HashMap<String, String>,
) -> Result<(&'a str, String)> {
    if let Some(err) = params.get("error").map(String::as_str) {
        if err == "access_denied" {
            return Err(Error::new(
                403,
                "CHATGPT_ACCESS_DENIED",
                "你已取消或拒绝 ChatGPT 授权。可以随时重新授权，或改用 API 服务。",
            ));
        }
        return Err(Error::new(
            400,
            "CHATGPT_AUTH_DENIED",
            "ChatGPT 授权未能完成，请重试。",
        ));
    }
    let code = params
        .get("code")
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::new(400, "CHATGPT_CODE_MISSING", "回调缺少授权码，请重试。"))?;

    let callback_client_id = params
        .get("client_id")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    let issued_client_id = match ctx.auth_mode {
        AuthMode::New => {
            let issued = callback_client_id.ok_or_else(|| {
                Error::new(
                    400,
                    "CHATGPT_CLIENT_ID_MISSING",
                    "新注册回调未返回客户端 ID，注册未完成，请重试。",
                )
            })?;
            if issued == DYNAMIC_CLIENT_ID {
                return Err(Error::new(
                    400,
                    "CHATGPT_CLIENT_ID_INVALID",
                    "回调返回的客户端 ID 无效，请重试。",
                ));
            }
            issued.to_owned()
        }
        AuthMode::RetryRegistration | AuthMode::Reauth | AuthMode::Consent => {
            let expected = ctx.expected_client_id.as_deref().ok_or_else(|| {
                Error::new(400, "CHATGPT_CLIENT_ID_MISSING", "缺少已保存的客户端 ID。")
            })?;
            if let Some(supplied) = callback_client_id
                && supplied != expected
            {
                return Err(Error::new(
                    400,
                    "CHATGPT_CLIENT_ID_MISMATCH",
                    "回调返回的客户端 ID 与所选账号不匹配，已拒绝覆盖凭据。",
                ));
            }
            expected.to_owned()
        }
    };
    Ok((code, issued_client_id))
}

async fn exchange_code(
    ctx: &CallbackRuntime,
    code: &str,
    issued_client_id: &str,
) -> Result<storage::StoredAccount> {
    let token_url = Url::parse(&ctx.discovery.token_endpoint)
        .map_err(|_| Error::new(503, "CHATGPT_AUTH_CONFIG", "OpenAI 令牌端点无效"))?;
    let response = ctx
        .chat
        .transport
        .send_form(
            token_url,
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("code_verifier", &ctx.code_verifier),
                ("redirect_uri", &ctx.redirect_uri),
                ("client_id", issued_client_id),
                ("resource", RESOURCE_URI),
            ],
            Duration::from_secs(20),
        )
        .await?;
    let status = response.status();
    let bytes = transport::bounded(response, 128 * 1024).await?;
    let tokens: Value = serde_json::from_slice(bytes.as_ref()).unwrap_or_default();
    if !status.is_success() {
        let code_name = tokens["error"].as_str().unwrap_or("");
        if code_name == "invalid_grant" {
            return Err(Error::new(
                400,
                "CHATGPT_INVALID_GRANT",
                "授权码已失效或已被使用，请重新登录。",
            ));
        }
        return Err(Error::new(
            502,
            "CHATGPT_TOKEN_EXCHANGE_FAILED",
            "无法向 OpenAI 交换访问令牌，请检查网络或代理后重试。",
        ));
    }

    let access_token = tokens["access_token"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                502,
                "CHATGPT_TOKEN_EXCHANGE_FAILED",
                "OpenAI 令牌响应缺少访问令牌。",
            )
        })?;
    let id_token = tokens["id_token"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Error::new(
                502,
                "CHATGPT_ID_TOKEN_MISSING",
                "OpenAI 令牌响应缺少 ID Token。",
            )
        })?;
    let refresh_token = tokens["refresh_token"].as_str();
    let expires_at = token_expiry(&tokens);
    let earliest_refresh_at = parse_earliest_refresh(&tokens["earliest_refresh_at"]);
    let granted_scopes = parse_scopes(tokens["scope"].as_str());

    let verified = ctx
        .chat
        .chatgpt
        .jwks
        .verify_id_token(
            &ctx.chat.transport,
            id_token,
            issued_client_id,
            &ctx.expected_nonce,
        )
        .await?;

    if let Some(expected_sub) = ctx.expected_subject.as_deref()
        && verified.subject != expected_sub
    {
        return Err(Error::new(
            403,
            "CHATGPT_ACCOUNT_MISMATCH",
            "登录返回的 ChatGPT 账号与当前所选账号不一致，已保留原账号凭据。",
        ));
    }

    let mut record = storage::StoredAccount {
        client_id: issued_client_id.to_owned(),
        issuer: verified.issuer,
        subject: verified.subject,
        email: verified.email,
        email_verified: verified.email_verified,
        name: verified.name,
        ..storage::StoredAccount::default()
    };
    record.set_tokens(
        access_token,
        refresh_token,
        Some(id_token),
        expires_at,
        earliest_refresh_at,
        granted_scopes,
    )?;
    Ok(record)
}

// Called while holding the same storage lock as cancellation and account removal.
async fn save_registration(
    ctx: &CallbackRuntime,
    mut record: storage::StoredAccount,
) -> Result<bool> {
    let mut store = storage::load(&ctx.runtime).await?;
    let id = record.client_id.clone();
    let plan_enabled = record.plan_enabled();
    if let Some(existing) = store.account_mut(&id) {
        if existing.issuer != record.issuer || existing.subject != record.subject {
            return Err(Error::new(
                403,
                "CHATGPT_ACCOUNT_MISMATCH",
                "ChatGPT 注册身份不匹配，原账号凭据已保留。",
            ));
        }
        record.label = existing.label.clone();
        record.selected_model = existing.selected_model.clone();
        record.selected_model_name = existing.selected_model_name.clone();
        record.usage_paused = existing.usage_paused;
        *existing = record;
    } else {
        if matches!(ctx.auth_mode, AuthMode::Reauth | AuthMode::Consent) {
            return Err(selection_changed());
        }
        record.label = store.distinct_label(&id, record.email.as_deref(), record.name.as_deref());
        store.accounts.push(record);
    }
    store.active_client_id = Some(id.clone());
    storage::save(&ctx.runtime, &store).await?;
    ctx.chat.chatgpt.stop_account(&id);
    Ok(plan_enabled)
}

fn random_base64url(len: usize) -> Result<String> {
    let mut bytes = vec![0u8; len];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::new(500, "RNG_FAILED", "无法生成安全随机数"))?;
    Ok(URL_SAFE_NO_PAD.encode(&bytes))
}

fn parse_scopes(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

fn token_expiry(tokens: &Value) -> i64 {
    let seconds = tokens["expires_in"]
        .as_i64()
        .filter(|value| *value > 0)
        .unwrap_or(3600);
    chrono::Utc::now().timestamp().saturating_add(seconds)
}

fn parse_earliest_refresh(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_str()
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .map(|dt| dt.timestamp())
    })
}

fn callback_html(status: StatusCode, title: &str, message: &str) -> Response {
    let state = if status.is_success() {
        "success"
    } else {
        "error"
    };
    let title = escape_html(title);
    let message = escape_html(message);
    let html = Html(format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{title} · 绘遇</title>
  <style>
    :root {{ color-scheme: light dark; }}
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: system-ui, sans-serif; background: #0e1014; color: #f4efe9; }}
    main {{ max-width: 420px; margin: 24px; padding: 28px; border-radius: 16px;
      background: #15181f; border: 1px solid #4b4d53; }}
    h1 {{ margin: 0 0 12px; font-size: 1.15rem; display: flex; align-items: center; gap: 10px; }}
    h1::before {{ content: ''; width: 10px; height: 10px; border-radius: 50%; flex: none; }}
    [data-state='success'] h1::before {{ background: #4ade80; }}
    [data-state='error'] h1::before {{ background: #f87171; }}
    p {{ margin: 0; line-height: 1.65; font-size: .95rem; color: #b3ada6; }}
    @media (prefers-color-scheme: light) {{
      body {{ background: #f6f3ec; color: #1b181a; }}
      main {{ background: #fdfbf7; border-color: #bfb7aa; }}
      p {{ color: #5f585b; }}
      [data-state='success'] h1::before {{ background: #18763d; }}
      [data-state='error'] h1::before {{ background: #b32f3a; }}
    }}
  </style>
</head>
<body><main data-state="{state}"><h1>{title}</h1><p>{message}</p></main></body>
</html>"#
    ));
    (
        status,
        [
            ("cache-control", "no-store"),
            ("referrer-policy", "no-referrer"),
        ],
        html,
    )
        .into_response()
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
