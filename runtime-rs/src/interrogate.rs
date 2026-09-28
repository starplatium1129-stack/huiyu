mod fallback;
mod model;
mod ort_runtime;
mod preprocess;
mod results;
mod settings;
mod temporary;
use crate::native_images::{api as vips_api, library as native_library};
mod worker;

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

const MAX_BYTES: usize = 12 * 1024 * 1024;
pub struct InterrogateService {
    native: worker::Client,
    fallback: fallback::Fallback,
    shutdown: CancellationToken,
}
impl InterrogateService {
    pub fn new(config: &Config, shutdown: CancellationToken) -> Self {
        Self::with_settings(settings::Settings::new(config), shutdown)
    }
    fn with_settings(settings: settings::Settings, shutdown: CancellationToken) -> Self {
        Self {
            native: worker::Client::new(settings.clone()),
            fallback: fallback::Fallback::new(settings),
            shutdown,
        }
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
        self.native.close().await;
        self.fallback.close().await;
    }
    async fn interrogate(&self, input: Value) -> Result<Value> {
        if self.shutdown.is_cancelled() {
            return Err(ApiError::new(
                503,
                "INTERROGATE_CLOSED",
                "Interrogation service closed",
            ));
        }
        let input = validate(input)?;
        let admission = self.native.admit()?;
        let cancel = self.shutdown.child_token();
        let _cancel = CancelRequest(cancel.clone());
        let native = self
            .native
            .run(
                input.image.clone(),
                input.threshold,
                cancel.clone(),
                admission.clone(),
            )
            .await;
        if cancel.is_cancelled() {
            return Err(fallback::cancelled());
        }
        let reason = match native {
            Ok(result) => {
                return Ok(results::finish(
                    result,
                    "wd14",
                    &input.mode,
                    input.threshold,
                ));
            }
            Err(error)
                if [
                    "INTERROGATE_BUSY",
                    "INTERROGATE_TIMEOUT",
                    "INTERROGATE_CLOSED",
                    "CANCELLED",
                ]
                .contains(&error.code.as_str()) =>
            {
                return Err(error);
            }
            Err(error) => error.message,
        };
        if let Some(result) = self
            .fallback
            .webui(input.base64, input.threshold, &cancel)
            .await?
        {
            return Ok(results::finish(
                result,
                "webui",
                &input.mode,
                input.threshold,
            ));
        }
        if input.mode == "tag"
            && let Some(result) = self.fallback.comfy(&input.image, &cancel).await?
        {
            return Ok(results::finish(
                result,
                "comfy",
                &input.mode,
                input.threshold,
            ));
        }
        Ok(results::heuristic(&input.mode, input.threshold, &reason))
    }
}
struct CancelRequest(CancellationToken);
impl Drop for CancelRequest {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
struct Input {
    mode: String,
    threshold: f64,
    base64: String,
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
        None => Some(0.35),
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
        return Err(ApiError::new(413, "IMAGE_TOO_LARGE", "图片超过 12MB 限制"));
    }
    Ok(Input {
        mode,
        threshold,
        base64,
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
            post(interrogate).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
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
        json!({"ok":true,"local":true,"engines":["wd14","webui","comfy","heuristic"],"wd14":service.native.probe().await,"thresholdDefault":0.35,"maxBytes":MAX_BYTES}),
    ))
}

#[cfg(test)]
mod tests;
