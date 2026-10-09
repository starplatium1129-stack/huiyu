mod pixai;
mod results;
mod settings;

use crate::{
    AppState,
    config::Config,
    error::{ApiError, Result},
    security,
};
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Request},
    http::HeaderMap,
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc};
use tokio_util::sync::CancellationToken;

const MAX_BYTES: usize = 20 * 1024 * 1024;
// Allow base64 expansion of the maximum-size image, with bounded room for its
// data URL prefix and JSON fields as well.
const MAX_BODY_BYTES: usize = MAX_BYTES.div_ceil(3) * 4 + 64 * 1024;
pub struct InterrogateService {
    client: pixai::Client,
    shutdown: CancellationToken,
    validation: Arc<tokio::sync::Semaphore>,
}
impl InterrogateService {
    pub fn new(config: &Config, shutdown: CancellationToken) -> Self {
        Self::with_settings(settings::load(config), shutdown)
    }
    fn with_settings(settings: pixai::Settings, shutdown: CancellationToken) -> Self {
        Self {
            client: pixai::Client::new(settings),
            shutdown,
            validation: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
        // Detached validation retains its slot until its bounded CPU work ends.
        let _drained = tokio::join!(self.client.close(), self.validation.acquire());
    }
    async fn interrogate(&self, input: Value) -> Result<Value> {
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
        let input = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if validation_cancel.is_cancelled() {
                return Err(closed());
            }
            validate(input)
        })
        .await
        .map_err(|_| ApiError::new(503, "INTERROGATE_UNAVAILABLE", "图片校验未完成"))??;
        let result = self
            .client
            .run(input.image, input.threshold, cancel)
            .await?;
        Ok(results::finish(
            result,
            "pixai",
            &input.mode,
            input.threshold,
        ))
    }
}
fn closed() -> ApiError {
    ApiError::new(503, "INTERROGATE_CLOSED", "Interrogation service closed")
}
struct Input {
    mode: String,
    threshold: f64,
    image: Arc<Vec<u8>>,
}
fn validate(mut input: Value) -> Result<Input> {
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
    let object = input.as_object_mut().unwrap();
    let image = object
        .remove("image")
        .filter(|value| value.as_str().is_some_and(|value| !value.is_empty()))
        .or_else(|| object.remove("imageBase64"));
    let Some(Value::String(mut base64)) = image else {
        return Err(ApiError::new(400, "INVALID_IMAGE", "请上传图片"));
    };
    base64 = base64.trim().to_owned();
    if let Some(offset) = base64.find("base64,") {
        base64.drain(..offset + 7);
    }
    base64.retain(|ch| ch != '\r' && ch != '\n');
    let bytes = STANDARD
        .decode(&base64)
        .map_err(|_| ApiError::new(400, "INVALID_IMAGE", "图片 base64 非法"))?;
    if bytes.len() < 1024 {
        return Err(ApiError::new(400, "INVALID_IMAGE", "图片过小"));
    }
    if bytes.len() > MAX_BYTES {
        return Err(ApiError::new(413, "IMAGE_TOO_LARGE", "图片超过 20MB 限制"));
    }
    Ok(Input {
        mode,
        threshold,
        image: Arc::new(bytes),
    })
}
fn local(headers: &HeaderMap, peer: SocketAddr) -> Result<()> {
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
            "/api/interrogate",
            post(interrogate).layer(DefaultBodyLimit::max(MAX_BODY_BYTES)),
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
async fn interrogate(
    Extension(service): Extension<Arc<InterrogateService>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>> {
    service.interrogate(input).await.map(Json)
}
async fn status(Extension(service): Extension<Arc<InterrogateService>>) -> Result<Json<Value>> {
    Ok(Json(
        json!({"ok":true,"local":true,"defaultEngine":"pixai","engines":["pixai"],"pixai":service.client.probe().await,"thresholdDefault":0.17,"maxBytes":MAX_BYTES}),
    ))
}

#[cfg(test)]
mod tests;
