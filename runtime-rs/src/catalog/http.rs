use super::*;
use crate::{AppState, security};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        ConnectInfo, DefaultBodyLimit, Query as QueryParam, State,
        rejection::MissingJsonContentType,
    },
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
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
async fn work(
    app: &AppState,
    action: impl FnOnce(&mut Catalog) -> Result<Value> + Send + 'static,
) -> Result<Response> {
    let options = Options::from_config(&app.config);
    // JSON encoding and dropping the large Value tree are CPU work too. Keep
    // them off Tokio request workers together with the catalog query.
    blocking_response(move || {
        Ok(Json(action(&mut Catalog::open_existing(options)?)?).into_response())
    })
    .await
}
async fn blocking_response(
    action: impl FnOnce() -> Result<Response> + Send + 'static,
) -> Result<Response> {
    tokio::task::spawn_blocking(action)
        .await
        .map_err(|_| ApiError::new(503, "CATALOG_UNAVAILABLE", "内容库暂不可用"))?
}
async fn submission<T: serde::de::DeserializeOwned + Send + 'static>(
    app: &AppState,
    headers: &HeaderMap,
    bytes: Bytes,
    action: impl FnOnce(&mut Catalog, T) -> Result<Value> + Send + 'static,
) -> Result<Response> {
    let json_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<mime::Mime>().ok())
        .is_some_and(|value| {
            value.type_() == mime::APPLICATION
                && (value.subtype() == mime::JSON || value.suffix() == Some(mime::JSON))
        });
    if !json_type {
        return Ok(MissingJsonContentType::default().into_response());
    }
    let admission = app.host.admit_owned()?;
    let cancel = app.shutdown.clone();
    let options = Options::from_config(&app.config);
    blocking_response(move || {
        let _admission = admission;
        if cancel.is_cancelled() {
            return Err(ApiError::new(499, "ABORT_ERR", "内容保存已取消"));
        }
        // Keep Axum's syntax/data rejection and field paths, but decode large
        // snapshots away from async request workers. Bytes retains the body limit.
        let Json(body) = match Json::<T>::from_bytes(&bytes) {
            Ok(body) => body,
            Err(error) => return Ok(error.into_response()),
        };
        if cancel.is_cancelled() {
            return Err(ApiError::new(499, "ABORT_ERR", "内容保存已取消"));
        }
        Ok(Json(action(&mut Catalog::open_existing(options)?, body)?).into_response())
    })
    .await
}
async fn list(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    QueryParam(query): QueryParam<Query>,
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    let cache = app.catalog_facets.clone();
    work(&app, move |c| c.query_cached(&query, Some(&cache))).await
}
async fn stats(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    work(&app, |c| c.stats()).await
}
async fn check(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    work(&app, |c| c.check()).await
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
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    work(&app, move |c| {
        let record = if let Some(revision) = key.revision {
            c.historical(&key.kind, &key.id, revision)?
        } else {
            c.get(&key.kind, &key.id)?
        };
        let mut value = json!({"ok":true,"record":null});
        value["record"] = record.into_value()?;
        Ok(value)
    })
    .await
}
async fn history(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    QueryParam(key): QueryParam<Key>,
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    work(&app, move |c| c.history(&key.kind, &key.id)).await
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
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    work(&app, move |c| c.character_bundle(&key.id)).await
}
async fn export(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    work(&app, |c| c.snapshot()).await
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
    body: Bytes,
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    submission(&app, &headers, body, |c, body: Submission| {
        c.apply(&body.changes, body.preview)
    })
    .await
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
    body: Bytes,
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    submission(&app, &headers, body, |c, body: Import| {
        c.import(&body.snapshot, body.preview)
    })
    .await
}
