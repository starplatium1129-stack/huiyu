use super::*;
use axum::{
    Extension, Json, Router,
    extract::{Path, Query},
    response::Response,
    routing::{get, post},
};
use std::collections::HashMap;

pub(super) fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/api/local-setup", get(local_setup))
        .route(
            "/api/local-setup/environment/{environment}",
            post(prepare_environment),
        )
        .route(
            "/api/local-setup/environment-cancel",
            post(cancel_environment),
        )
        .route(
            "/api/local-setup/llama",
            get(llama_status).post(start_llama).delete(stop_llama),
        )
        .route("/api/local-setup/llama-ensure", post(ensure_llama))
        .route("/api/local-setup/operation", get(setup_operation))
        .route("/api/local-setup/verify/{model}", post(verify_setup_model))
        .route(
            "/api/local-setup/download/{model}",
            post(download_setup_model),
        )
}
async fn local_setup(
    Extension(s): Extension<Arc<ControlService>>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    Ok(Json(match query.get("model") {
        Some(model) => s.local_setup_for(model).await?,
        None => s.local_setup().await?,
    }))
}
async fn prepare_environment(
    Extension(s): Extension<Arc<ControlService>>,
    Path(environment): Path<String>,
    Json(body): Json<setup_environment::EnvironmentRequest>,
) -> Result<Json<Value>> {
    Ok(Json(s.prepare_environment(environment, body)?))
}
async fn cancel_environment(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    Ok(Json(s.cancel_environment(body["operationId"].as_str())?))
}
async fn llama_status(Extension(s): Extension<Arc<ControlService>>) -> Json<Value> {
    Json(json!({"ok":true,"llama":s.llama_status().await}))
}
async fn start_llama(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<llama::StartRequest>,
) -> Result<Json<Value>> {
    Ok(Json(s.start_llama(body)?))
}
async fn stop_llama(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    s.stop_llama().await?;
    Ok(Json(json!({"ok":true})))
}
async fn ensure_llama(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    Ok(Json(
        s.ensure_llama(body["baseUrl"].as_str().unwrap_or(""))
            .await?,
    ))
}
async fn setup_operation(Extension(s): Extension<Arc<ControlService>>) -> Json<Value> {
    Json(json!({"ok":true,"operation":s.state.lock().unwrap().operation.clone()}))
}
async fn verify_setup_model(
    Extension(s): Extension<Arc<ControlService>>,
    Path(model): Path<String>,
) -> Result<Response> {
    s.verify_setup_model(model)
}
async fn download_setup_model(
    Extension(s): Extension<Arc<ControlService>>,
    Path(model): Path<String>,
    Json(body): Json<setup_download::DownloadRequest>,
) -> Result<Response> {
    s.download_setup_model(model, body)
}
