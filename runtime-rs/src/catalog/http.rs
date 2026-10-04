use super::*;
use crate::{AppState, security};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Query as QueryParam, State},
    http::HeaderMap,
    routing::{get, post},
};
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/catalog", get(list))
        .route("/api/catalog/stats", get(stats))
        .route("/api/catalog/record", get(detail))
        .route("/api/catalog/history", get(history))
        .route("/api/catalog/character", get(character))
        .route("/api/catalog/export", get(export))
        .route("/api/catalog/changes", post(change))
        .layer(DefaultBodyLimit::max(20 * 1024 * 1024))
        .route("/api/catalog/import", post(import))
        .layer(DefaultBodyLimit::max(20 * 1024 * 1024))
        .route("/api/catalog/check", get(check))
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                let mut response = next.run(request).await;
                response.headers_mut().insert(
                    axum::http::header::CACHE_CONTROL,
                    axum::http::HeaderValue::from_static("no-store"),
                );
                response
            },
        ))
}
fn authorize(app: &AppState, headers: &HeaderMap, peer: std::net::SocketAddr) -> Result<()> {
    if !security::is_direct_local(headers, peer.ip()) {
        return Err(ApiError::new(403, "LOCAL_ONLY", "内容管理仅允许本机访问"));
    }
    app.host.check_available()?;
    Ok(())
}
async fn work<T: Send + 'static>(
    app: &AppState,
    action: impl FnOnce(&mut Catalog) -> Result<T> + Send + 'static,
) -> Result<T> {
    let options = Options::from_config(&app.config);
    tokio::task::spawn_blocking(move || action(&mut Catalog::open(options)?))
        .await
        .map_err(|_| ApiError::new(503, "CATALOG_UNAVAILABLE", "内容库暂不可用"))?
}
async fn list(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    QueryParam(query): QueryParam<Query>,
) -> Result<Json<Value>> {
    authorize(&app, &headers, peer)?;
    Ok(Json(work(&app, move |c| c.query(&query)).await?))
}
async fn stats(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    authorize(&app, &headers, peer)?;
    Ok(Json(work(&app, |c| c.stats()).await?))
}
async fn check(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    authorize(&app, &headers, peer)?;
    Ok(Json(work(&app, |c| c.check()).await?))
}
#[derive(Deserialize)]
struct Key {
    kind: String,
    id: String,
    revision: Option<i64>,
}
async fn detail(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    QueryParam(key): QueryParam<Key>,
) -> Result<Json<Value>> {
    authorize(&app, &headers, peer)?;
    Ok(Json(work(&app,move|c|Ok(json!({"ok":true,"record":if let Some(revision)=key.revision{c.historical(&key.kind,&key.id,revision)?}else{c.get(&key.kind,&key.id)?}}))).await?))
}
async fn history(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    QueryParam(key): QueryParam<Key>,
) -> Result<Json<Value>> {
    authorize(&app, &headers, peer)?;
    Ok(Json(
        work(&app, move |c| c.history(&key.kind, &key.id)).await?,
    ))
}
#[derive(Deserialize)]
struct Character {
    id: String,
}
async fn character(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    QueryParam(key): QueryParam<Character>,
) -> Result<Json<Value>> {
    authorize(&app, &headers, peer)?;
    Ok(Json(
        work(&app, move |c| c.character_bundle(&key.id)).await?,
    ))
}
async fn export(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    authorize(&app, &headers, peer)?;
    Ok(Json(work(&app, |c| c.snapshot()).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Submission {
    changes: Vec<Change>,
    #[serde(default)]
    preview: bool,
}
async fn change(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Submission>,
) -> Result<Json<Value>> {
    authorize(&app, &headers, peer)?;
    let admission = app.host.admit_owned()?;
    let cancel = app.shutdown.clone();
    Ok(Json(
        work(&app, move |c| {
            let _admission = admission;
            if cancel.is_cancelled() {
                return Err(ApiError::new(499, "ABORT_ERR", "内容保存已取消"));
            }
            c.apply(&body.changes, body.preview)
        })
        .await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Import {
    snapshot: Value,
    #[serde(default)]
    preview: bool,
}
async fn import(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Import>,
) -> Result<Json<Value>> {
    authorize(&app, &headers, peer)?;
    let admission = app.host.admit_owned()?;
    Ok(Json(
        work(&app, move |c| {
            let _admission = admission;
            c.import(&body.snapshot, body.preview)
        })
        .await?,
    ))
}
