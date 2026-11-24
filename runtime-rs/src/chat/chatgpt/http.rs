use crate::{
    AppState,
    chat::{ChatService, Error, local, running},
};
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::Value;
use std::{net::SocketAddr, sync::Arc};

pub(in crate::chat) fn router() -> Router<AppState> {
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

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct ModelsQuery {
    refresh: Option<String>,
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
    Query(query): Query<ModelsQuery>,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = local(&headers, peer).and_then(|()| running(&app)) {
        return error.into_response();
    }
    let force_refresh = matches!(
        query.refresh.as_deref(),
        Some("1" | "true" | "TRUE" | "yes")
    );
    let settings = chat.settings(&app).await;
    let cancel = app.shutdown.child_token();
    match chat
        .chatgpt
        .list_models(&chat.transport, settings, force_refresh, &cancel)
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
