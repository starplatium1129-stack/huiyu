mod catalog;
mod editor;
mod import;
mod manifest;
mod profile;
mod textures;
mod upload_checks;

use crate::{
    AppState,
    config::Config,
    error::{ApiError, Result},
    security,
};
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Request},
    http::{HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use tower_http::services::ServeFile;

#[derive(Clone)]
pub struct Live2dService {
    builtins: PathBuf,
    local: PathBuf,
    catalog: Arc<catalog::Catalog>,
    public_catalog: Arc<catalog::Catalog>,
    textures: Arc<textures::Textures>,
    native_library: PathBuf,
    workers: Arc<Semaphore>,
    shutdown: CancellationToken,
}
struct CancelWork(CancellationToken);
impl Drop for CancelWork {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
impl Live2dService {
    pub fn new(config: &Config, shutdown: CancellationToken) -> Self {
        let assets = env::var_os("AICS_ASSETS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| config.app_root.join("assets"));
        let assets = if assets.is_absolute() {
            assets
        } else {
            env::current_dir()
                .unwrap_or_else(|_| config.app_root.clone())
                .join(assets)
        };
        let runtime = if env::var("AICS_DESKTOP_PACKAGED").as_deref() == Ok("1") {
            config.runtime_root.clone()
        } else {
            config.app_root.join("runtime")
        };
        let mut service = Self::with_roots(
            assets.join("live2d"),
            runtime.join("live2d-imports"),
            shutdown,
        );
        service.native_library = crate::native_images::library_path(config);
        service
    }
    fn with_roots(builtins: PathBuf, local: PathBuf, shutdown: CancellationToken) -> Self {
        Self {
            builtins,
            local,
            catalog: Arc::new(catalog::Catalog::default()),
            public_catalog: Arc::new(catalog::Catalog::default()),
            textures: Arc::new(textures::Textures::default()),
            native_library: PathBuf::new(),
            workers: Arc::new(Semaphore::new(2)),
            shutdown,
        }
    }
    async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(Self, &CancellationToken) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let cancel = self.shutdown.child_token();
        let _cancel = CancelWork(cancel.clone());
        let service = self.clone();
        let workers = self.workers.clone();
        let work = async move {
            let permit = tokio::select! { permit = workers.acquire_owned() => permit.map_err(|_| manifest::invalid("Live2D worker closed"))?, _ = cancel.cancelled() => return Err(ApiError::new(503,"LIVE2D_CLOSED","Live2D service is closed")) };
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                editor::check_cancel(&cancel)?;
                operation(service, &cancel)
            })
            .await
            .map_err(|_| ApiError::new(503, "LIVE2D_FAILED", "Live2D filesystem worker failed"))?
        };
        tokio::time::timeout(std::time::Duration::from_secs(60), work)
            .await
            .map_err(|_| {
                ApiError::new(
                    504,
                    "LIVE2D_TIMEOUT",
                    "Live2D filesystem operation timed out",
                )
            })?
    }
    async fn snapshot(&self) -> Result<Arc<catalog::Snapshot>> {
        if let Some(snapshot) = self.catalog.cached() {
            return Ok(snapshot);
        }
        self.run(|service, _| Ok(service.catalog.read(&service.builtins, &service.local)))
            .await
    }
    pub async fn available(&self) -> bool {
        self.snapshot()
            .await
            .is_ok_and(|snapshot| snapshot.status["available"] == true)
    }
    async fn public_snapshot(&self) -> Result<Arc<catalog::Snapshot>> {
        if let Some(snapshot) = self.public_catalog.cached() {
            return Ok(snapshot);
        }
        self.run(|service, _| Ok(service.public_catalog.read_builtin(&service.builtins)))
            .await
    }
}

pub fn router(service: Arc<Live2dService>) -> Router<AppState> {
    Router::new()
        .route("/api/live2d-status", get(status))
        .route("/api/live2d-companions", get(companions))
        .route("/api/live2d-local/{character}/{*file}", get(asset))
        .route("/assets/live2d-current/{character}/{*file}", get(asset))
        .route("/api/live2d-model/{character}/{quality}", get(derived))
        .route(
            "/api/live2d-texture/{character}/{quality}/{index}",
            get(derived_texture),
        )
        .route(
            "/api/live2d-import",
            post(upload).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route(
            "/api/live2d-import/{id}",
            get(get_profile)
                .put(save_profile)
                .delete(disable)
                .layer(DefaultBodyLimit::max(96 * 1024)),
        )
        .route(
            "/api/live2d-import/{id}/rollback",
            post(rollback).layer(DefaultBodyLimit::max(96 * 1024)),
        )
        .layer(axum::middleware::from_fn(local_only))
        .layer(Extension(service))
}
async fn local_only(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    let public = matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    ) && ["/api/live2d-status", "/api/live2d-companions"]
        .contains(&request.uri().path());
    // Root middleware authenticates and validates the registered remote Host.
    // Only these two handlers produce public metadata; they never read imports.
    if !public
        && (!security::is_direct_local(request.headers(), peer.ip())
            || !request
                .headers()
                .get("host")
                .and_then(|h| h.to_str().ok())
                .is_some_and(security::host_allowed))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .entry("cache-control")
        .or_insert(HeaderValue::from_static("private, no-store"));
    response
}
async fn status(
    Extension(service): Extension<Arc<Live2dService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Value>> {
    let snapshot = if security::is_direct_local(&headers, peer.ip()) {
        service.snapshot().await?
    } else {
        service.public_snapshot().await?
    };
    Ok(Json(snapshot.status.clone()))
}
async fn companions(
    Extension(service): Extension<Arc<Live2dService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Value>> {
    if !security::is_direct_local(&headers, peer.ip()) {
        return Ok(Json(json!([])));
    }
    Ok(Json(Value::Array(service.snapshot().await?.models.iter().filter_map(|model| model.receipt.as_ref()).map(|receipt| json!({"character":receipt["character"],"avatar":receipt["avatar"],"profile":receipt["profile"]})).collect())))
}
async fn asset(
    Extension(service): Extension<Arc<Live2dService>>,
    Path((character, file)): Path<(String, String)>,
    request: Request,
) -> Response {
    let local = request.uri().path().starts_with("/api/live2d-local/");
    let resolved = service
        .run(move |service, _| {
            let snapshot = service.catalog.read(&service.builtins, &service.local);
            let model = snapshot
                .models
                .iter()
                .find(|model| model.id == character)
                .ok_or_else(|| manifest::invalid("Unknown model"))?;
            if model.receipt.is_some() != local {
                return Err(manifest::invalid(
                    "Model is outside this resource namespace",
                ));
            }
            if !model.files.contains(&file) {
                return Err(manifest::invalid("Model resource is outside its manifest"));
            }
            manifest::model_file(&model.directory, &file)
        })
        .await;
    let Ok(file) = resolved else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match ServeFile::new(file).try_call(request).await {
        Ok(response) => response.map(Body::new),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn derived(
    Extension(service): Extension<Arc<Live2dService>>,
    Path((character, quality)): Path<(String, String)>,
) -> Response {
    match service
        .run(move |service, _| {
            let snapshot = service.catalog.read(&service.builtins, &service.local);
            textures::projected(&snapshot, &character, &quality)
        })
        .await
    {
        Ok(document) => ([("cache-control", "private, no-cache")], Json(document)).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn derived_texture(
    Extension(service): Extension<Arc<Live2dService>>,
    Path((character, quality, index)): Path<(String, String, String)>,
    headers: axum::http::HeaderMap,
) -> Response {
    let Some(index) = index
        .strip_suffix(".webp")
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|index| *index <= 63)
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let entry = match service
        .textures
        .get(&service, character, quality, index as usize)
        .await
    {
        Ok(entry) => entry,
        Err(error) => return error.into_response(),
    };
    let response = if headers
        .get("if-none-match")
        .and_then(|value| value.to_str().ok())
        == Some(&entry.etag)
    {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        ([("content-type", "image/webp")], entry.bytes).into_response()
    };
    let mut response = response;
    response
        .headers_mut()
        .insert("etag", HeaderValue::from_str(&entry.etag).unwrap());
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, no-cache"),
    );
    response
}
fn import_error(mut error: ApiError) -> ApiError {
    if ![409, 413, 499, 503, 504].contains(&error.status.as_u16()) {
        error.status = StatusCode::BAD_REQUEST;
    }
    error
}
async fn get_profile(
    Extension(service): Extension<Arc<Live2dService>>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    service
        .run(move |service, cancel| editor::get(&service.local, &id, cancel))
        .await
        .map(Json)
        .map_err(import_error)
}
async fn update(
    service: Arc<Live2dService>,
    id: String,
    input: Value,
    action: &'static str,
) -> Result<Json<Value>> {
    let result = service
        .run(move |service, cancel| editor::edit(&service.local, &id, &input, action, cancel))
        .await;
    service.catalog.clear();
    result.map(Json).map_err(import_error)
}
async fn save_profile(
    Extension(service): Extension<Arc<Live2dService>>,
    Path(id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>> {
    update(service, id, input, "save").await
}
async fn rollback(
    Extension(service): Extension<Arc<Live2dService>>,
    Path(id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>> {
    update(service, id, input, "rollback").await
}
async fn disable(
    Extension(service): Extension<Arc<Live2dService>>,
    Path(id): Path<String>,
    Json(input): Json<Value>,
) -> Result<Json<Value>> {
    update(service, id, input, "disable").await
}
async fn upload(
    Extension(service): Extension<Arc<Live2dService>>,
    form: Multipart,
) -> Result<Response> {
    let cancel = service.shutdown.child_token();
    let _cancel = CancelWork(cancel.clone());
    let upload = import::receive(&service.local, form, &cancel)
        .await
        .map_err(import_error)?;
    let result = service
        .run(move |service, cancel| import::publish(&service.local, upload, cancel))
        .await;
    service.catalog.clear();
    Ok((StatusCode::CREATED, Json(result.map_err(import_error)?)).into_response())
}

#[cfg(test)]
mod tests;
