mod assist;
mod pixai;
mod results;
mod settings;
mod workspace;
pub(crate) use workspace::WorkspaceInput;

use crate::{
    AppState,
    config::Config,
    error::{ApiError, Result},
    images::upload_body::RawUploadBody,
    security,
};
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Query, Request, State},
    http::HeaderMap,
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use tokio_util::sync::CancellationToken;

const MAX_BYTES: usize = 20 * 1024 * 1024;
pub struct InterrogateService {
    client: tokio::sync::RwLock<pixai::Client>,
    shutdown: CancellationToken,
    validation: Arc<tokio::sync::Semaphore>,
    media_jobs: tokio_util::task::TaskTracker,
    media_closed: std::sync::Mutex<bool>,
}
impl InterrogateService {
    pub fn new(config: &Config, shutdown: CancellationToken) -> Self {
        Self::with_settings(settings::load(config), shutdown)
    }
    fn with_settings(settings: pixai::Settings, shutdown: CancellationToken) -> Self {
        Self {
            client: tokio::sync::RwLock::new(pixai::Client::new(settings)),
            shutdown,
            validation: Arc::new(tokio::sync::Semaphore::new(1)),
            media_jobs: tokio_util::task::TaskTracker::new(),
            media_closed: std::sync::Mutex::new(false),
        }
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
        {
            let mut closed = self.media_closed.lock().unwrap();
            *closed = true;
            self.media_jobs.close();
        }
        self.media_jobs.wait().await;
        // Detached validation retains its slot until its bounded CPU work ends.
        let client = self.client.write().await;
        let _drained = tokio::join!(client.close(), self.validation.acquire());
    }
    pub(crate) async fn reload(&self, config: &Config) -> Result<Value> {
        let mut client = self.client.write().await;
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        // Retire and drain the old worker before a new client can start GPU work.
        client.close().await?;
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        *client = pixai::Client::new(settings::load(config));
        Ok(client.probe().await)
    }
    async fn interrogate(
        &self,
        input: Value,
        image: Bytes,
        upload_admission: tokio::sync::OwnedSemaphorePermit,
        assistance: Option<(&AppState, &HeaderMap)>,
    ) -> Result<Value> {
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        let cancel = self.shutdown.child_token();
        let _cancel = cancel.clone().drop_guard();
        let permit = tokio::select! { biased;
            _ = cancel.cancelled() => return Err(closed()),
            permit = self.validation.clone().acquire_owned() => permit.map_err(|_| closed())?,
        };
        let validation_cancel = cancel.clone();
        let (input, upload_admission) = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if validation_cancel.is_cancelled() {
                return Err(closed());
            }
            validate(input, image).map(|input| (input, upload_admission))
        })
        .await
        .map_err(|_| ApiError::new(503, "INTERROGATE_UNAVAILABLE", "图片校验未完成"))??;
        let upload_admission = Arc::new(upload_admission);
        let original = assistance.map(|_| (input.image.clone(), upload_admission.clone()));
        let threshold = if assistance.is_some() {
            input.threshold.min(assist::EXPLICIT_MIN.next_down())
        } else {
            input.threshold
        };
        let mut result = self
            .client
            .read()
            .await
            .run(input.image, threshold, cancel.clone(), upload_admission)
            .await?;
        let evidence = assistance.map(|_| assist::Evidence::from_pixai(&result));
        if threshold < input.threshold {
            results::retain_threshold(&mut result, input.threshold);
        }
        let mut result = results::finish(result, "pixai", &input.mode, input.threshold);
        if let (Some((app, headers)), Some(original), Some(evidence)) = (assistance, original, evidence) {
            assist::enrich(app, headers, self.validation.clone(), original, evidence, &cancel, &mut result).await;
        }
        Ok(result)
    }
}
fn closed() -> ApiError {
    ApiError::new(503, "INTERROGATE_CLOSED", "Interrogation service closed")
}
struct Input {
    mode: String,
    threshold: f64,
    image: Bytes,
}
fn validate(input: Value, bytes: Bytes) -> Result<Input> {
    if !input.is_object() {
        return Err(ApiError::new(400, "INVALID_BODY", "请求体必须是 JSON"));
    }
    let mode = input["mode"]
        .as_str()
        .filter(|mode| !mode.is_empty())
        .unwrap_or("tag")
        .to_lowercase();
    if !["tag", "caption"].contains(&mode.as_str()) {
        return Err(ApiError::new(
            400,
            "INVALID_PARAMETER",
            "mode 仅支持 tag/caption",
        ));
    }
    let threshold = match input.get("threshold") {
        None => Some(0.17),
        Some(value) => value
            .as_f64()
            .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok())),
    }
    .filter(|n| n.is_finite() && (0.05..=0.95).contains(n))
    .ok_or_else(|| ApiError::new(400, "INVALID_PARAMETER", "threshold 需在 0.05-0.95"))?;
    if bytes.len() < 1024 {
        return Err(ApiError::new(400, "INVALID_IMAGE", "图片过小"));
    }
    if bytes.len() > MAX_BYTES {
        return Err(ApiError::new(413, "IMAGE_TOO_LARGE", "图片超过 20MB 限制"));
    }
    Ok(Input {
        mode,
        threshold,
        image: bytes,
    })
}
pub(crate) fn local(headers: &HeaderMap, peer: SocketAddr) -> Result<()> {
    if security::is_direct_local(headers, peer.ip())
        && headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .is_some_and(security::host_allowed)
    {
        Ok(())
    } else {
        Err(ApiError::new(403, "LOCAL_ONLY", "图片反推仅供本机使用"))
    }
}
pub fn router(service: Arc<InterrogateService>) -> Router<AppState> {
    Router::new()
        .route(
            "/api/interrogate/raw",
            post(interrogate_raw).layer(DefaultBodyLimit::max(MAX_BYTES)),
        )
        .route("/api/interrogate/status", get(status))
        .layer(Extension(service))
        .layer(axum::middleware::from_fn(local_only))
}
async fn local_only(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    if let Err(error) = local(request.headers(), peer) {
        return error.into_response();
    }
    next.run(request).await
}
async fn interrogate_raw(
    State(app): State<AppState>,
    Extension(service): Extension<Arc<InterrogateService>>,
    Query(parameters): Query<HashMap<String, String>>,
    headers: HeaderMap,
    RawUploadBody(image, admission): RawUploadBody,
) -> Result<Json<Value>> {
    let assist = parameters.get("assist").is_some_and(|value| value == "1");
    service
        .interrogate(json!(parameters), image, admission, assist.then_some((&app, &headers)))
        .await
        .map(Json)
}
async fn status(
    State(app): State<AppState>,
    Extension(service): Extension<Arc<InterrogateService>>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let route = match &app.chat {
        Some(chat) => chat.vision_route(&app, &headers).await,
        None => None,
    };
    Ok(Json(
        json!({"ok":true,"local":true,"defaultEngine":"pixai","engines":["pixai"],"pixai":service.client.read().await.probe().await,"thresholdDefault":0.17,"maxBytes":MAX_BYTES,"assist":crate::chat::VisionRoute::status(route.as_ref())}),
    ))
}
