mod assist;
mod cache;
pub(crate) mod muse;
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

pub(super) const MAX_BYTES: usize = 20 * 1024 * 1024;
pub struct InterrogateService {
    client: tokio::sync::RwLock<pixai::Client>,
    cache: cache::InterrogateCache,
    shutdown: CancellationToken,
    validation: Arc<tokio::sync::Semaphore>,
    media_jobs: tokio_util::task::TaskTracker,
    media_closed: std::sync::Mutex<bool>,
}
impl InterrogateService {
    pub fn new(config: &Config, shutdown: CancellationToken) -> Self {
        Self::with_settings(settings::load(config), cache::InterrogateCache::new(config), shutdown)
    }
    fn with_settings(
        settings: pixai::Settings,
        cache: cache::InterrogateCache,
        shutdown: CancellationToken,
    ) -> Self {
        Self {
            client: tokio::sync::RwLock::new(pixai::Client::new(settings)),
            cache,
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
    pub(super) async fn probe(&self) -> Value {
        self.client.read().await.probe().await
    }
    pub(super) async fn cache_stats(&self) -> Value {
        self.cache.stats().await
    }
    pub(super) async fn interrogate(
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
        let (input, image_sha256, upload_admission) = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if validation_cancel.is_cancelled() {
                return Err(closed());
            }
            let validated = validate(input, image)?;
            let digest = cache::image_sha256(&validated.image);
            Ok((validated, digest, upload_admission))
        })
        .await
        .map_err(|_| ApiError::new(503, "INTERROGATE_UNAVAILABLE", "图片校验未完成"))??;

        let assist_identity = match assistance {
            Some((app, headers)) => match &app.chat {
                Some(chat) => chat
                    .vision_route(app, headers)
                    .await
                    .map(|route| route.cache_identity()),
                None => None,
            },
            None => None,
        };
        let cache_key = if assistance.is_none() || assist_identity.is_some() {
            Some(cache::cache_key(&cache::CacheKeyInput {
                image_sha256: &image_sha256,
                engine: "pixai",
                mode: &input.mode,
                threshold: input.threshold,
                assist_identity: assist_identity.as_deref(),
                subject_mode: input.subject_mode.as_str(),
                layout: input.layout,
            }))
        } else {
            None
        };
        if !input.no_cache
            && let Some(key) = cache_key.as_deref()
            && let Some((mut cached, cached_at)) = self.cache.get(key).await
        {
            drop(upload_admission);
            cached["cacheHit"] = json!(true);
            cached["cachedAt"] = json!(cached_at);
            return Ok(cached);
        }

        let upload_admission = Arc::new(upload_admission);
        let original = assistance.map(|_| (input.image.clone(), upload_admission.clone()));
        let threshold = if assistance.is_some() {
            input.threshold.min(assist::GUARD_MIN.next_down())
        } else {
            input.threshold
        };
        let mut result = self
            .client
            .read()
            .await
            .run(input.image, threshold, cancel.clone(), upload_admission)
            .await?;
        let assist_options = assist::Options {
            subject_mode: input.subject_mode,
            layout: input.layout,
        };
        let evidence = assistance.map(|_| assist::Evidence::from_pixai(&result, assist_options));
        if threshold < input.threshold {
            results::retain_threshold(&mut result, input.threshold);
        }
        let mut result = results::finish(result, "pixai", &input.mode, input.threshold);
        if let (Some((app, headers)), Some(original), Some(evidence)) =
            (assistance, original, evidence)
        {
            assist::enrich(
                app,
                headers,
                self.validation.clone(),
                original,
                evidence,
                assist_options,
                &cancel,
                &mut result,
            )
            .await;
        }
        let cacheable = result["ok"] == true
            && (assistance.is_none() || result["assistUsed"] == true);
        if cacheable && let Some(key) = cache_key {
            self.cache.put(key, image_sha256, result.clone()).await;
        }
        result["cacheHit"] = json!(false);
        Ok(result)
    }
}
fn closed() -> ApiError {
    ApiError::new(503, "INTERROGATE_CLOSED", "Interrogation service closed")
}
struct Input {
    mode: String,
    threshold: f64,
    subject_mode: assist::SubjectMode,
    layout: bool,
    no_cache: bool,
    image: Bytes,
}
fn parse_flag(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => matches!(text.trim().to_ascii_lowercase().as_str(), "1" | "true"),
        _ => false,
    }
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
    let subject_mode = match input.get("subjectMode") {
        None => assist::SubjectMode::Free,
        Some(value) => match value.as_str().map(|s| s.to_lowercase()).as_deref() {
            Some("") | Some("free") => assist::SubjectMode::Free,
            Some("bound") => assist::SubjectMode::Bound,
            _ => {
                return Err(ApiError::new(
                    400,
                    "INVALID_PARAMETER",
                    "subjectMode 仅支持 free/bound",
                ));
            }
        },
    };
    let layout = parse_flag(input.get("layout"));
    let no_cache = parse_flag(input.get("noCache"));
    if bytes.len() < 1024 {
        return Err(ApiError::new(400, "INVALID_IMAGE", "图片过小"));
    }
    if bytes.len() > MAX_BYTES {
        return Err(ApiError::new(413, "IMAGE_TOO_LARGE", "图片超过 20MB 限制"));
    }
    Ok(Input {
        mode,
        threshold,
        subject_mode,
        layout,
        no_cache,
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
        json!({"ok":true,"local":true,"defaultEngine":"pixai","engines":["pixai"],"pixai":service.client.read().await.probe().await,"thresholdDefault":0.17,"maxBytes":MAX_BYTES,"assist":crate::chat::VisionRoute::status(route.as_ref()),"cache":service.cache_stats().await}),
    ))
}
