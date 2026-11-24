use super::{InterrogateService, MAX_BYTES};
use crate::{
    AppState,
    error::{ApiError, Result},
    generation::{RateLimit, receipts::valid_request_key},
    image_decode,
    images::upload_body,
};
use axum::{
    Extension, Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub(crate) const STATUS_PATH: &str = "/api/muse/interrogate/status";
pub(crate) const INTERROGATE_PATH: &str = "/api/muse/interrogate";
pub(crate) const MAX_JSON_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_JSON_BASE64_LEN: usize = MAX_JSON_IMAGE_BYTES.div_ceil(3) * 4;
const MAX_JSON_BODY_BYTES: usize = MAX_JSON_BASE64_LEN + 64 * 1024;
const MIN_IMAGE_BYTES: usize = 1024;

struct Limits {
    status: RateLimit,
    interrogate: RateLimit,
}

pub(crate) fn router() -> Router<AppState> {
    let limits = Arc::new(Limits {
        status: RateLimit::with("远程反推状态查询", 30, 5000),
        interrogate: RateLimit::with("远程图像反推", 6, 5000),
    });
    Router::new()
        .route(STATUS_PATH, get(status))
        .route(
            INTERROGATE_PATH,
            post(interrogate).layer(DefaultBodyLimit::max(MAX_BYTES)),
        )
        .layer(Extension(limits))
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn json_response(result: Result<Value>) -> Response {
    let response = match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => error.into_response(),
    };
    no_store(response)
}

async fn status(
    State(app): State<AppState>,
    Extension(limits): Extension<Arc<Limits>>,
) -> Response {
    if let Some(response) = limits.status.check(false) {
        return no_store(response);
    }
    json_response(status_inner(&app).await)
}

async fn status_inner(app: &AppState) -> Result<Value> {
    app.host.check_running()?;
    let (pixai, cache) = match &app.interrogate {
        Some(service) => (service.probe().await, service.cache_stats().await),
        None => (
            json!({"available": false, "reason": "本机图像反推服务未启用"}),
            json!({"enabled": false}),
        ),
    };
    // Remote callers only use host-configured ChatGPT or API vision routes;
    // never honor caller-supplied personal API headers over the remote port.
    let empty = HeaderMap::new();
    let route = match &app.chat {
        Some(chat) => chat.vision_route(app, &empty).await,
        None => None,
    };
    let available = app.interrogate.is_some() && pixai["available"] == true;
    Ok(json!({
        "ok": true,
        "available": available,
        "defaultEngine": "pixai",
        "engines": ["pixai"],
        "pixai": pixai,
        "assist": crate::chat::VisionRoute::status(route.as_ref()),
        "cache": cache,
        "thresholdDefault": 0.17,
        "maxRawBytes": MAX_BYTES,
        "maxJsonImageBytes": MAX_JSON_IMAGE_BYTES,
        "inputFormats": ["application/octet-stream", "image/png", "image/jpeg", "image/webp", "application/json"],
        "parameters": {
            "mode": ["tag", "caption"],
            "threshold": {"min": 0.05, "max": 0.95, "default": 0.17},
            "assist": {"type": "boolean", "default": false},
            "subjectMode": ["free", "bound"],
            "layout": {"type": "boolean", "default": false, "requiresAssist": true},
            "noCache": {"type": "boolean", "default": false}
        }
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JsonInput {
    request_key: Option<String>,
    image_base64: String,
    mime_type: Option<String>,
    mode: Option<String>,
    threshold: Option<f64>,
    assist: Option<bool>,
    subject_mode: Option<String>,
    layout: Option<bool>,
    no_cache: Option<bool>,
}

enum InputMode {
    Json,
    Raw { expected_mime: Option<&'static str> },
}

fn parse_content_type(headers: &HeaderMap) -> Result<InputMode> {
    let parsed = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<mime::Mime>().ok());
    match parsed.as_ref().map(mime::Mime::essence_str) {
        Some("application/json") => Ok(InputMode::Json),
        Some("application/octet-stream") => Ok(InputMode::Raw {
            expected_mime: None,
        }),
        Some("image/png") => Ok(InputMode::Raw {
            expected_mime: Some("image/png"),
        }),
        Some("image/jpeg") => Ok(InputMode::Raw {
            expected_mime: Some("image/jpeg"),
        }),
        Some("image/webp") => Ok(InputMode::Raw {
            expected_mime: Some("image/webp"),
        }),
        _ => Err(ApiError::new(
            415,
            "INVALID_IMAGE_BODY",
            "请使用 application/octet-stream（或 image/png、image/jpeg、image/webp）提交原始图片，或使用 application/json 提交 imageBase64",
        )),
    }
}

fn parse_bool_param(value: &str, name: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "0" | "false" => Ok(false),
        "1" | "true" => Ok(true),
        _ => Err(ApiError::new(
            400,
            "INVALID_PARAMETER",
            format!("{name} 仅支持 0/1 或 false/true"),
        )),
    }
}

fn parse_raw_query(query: &HashMap<String, String>) -> Result<(Value, bool)> {
    for key in query.keys() {
        if !matches!(
            key.as_str(),
            "mode" | "threshold" | "assist" | "subjectMode" | "layout" | "noCache"
        ) {
            return Err(ApiError::new(
                400,
                "INVALID_PARAMETER",
                format!("不支持的反推参数：{key}"),
            ));
        }
    }
    let assist = match query.get("assist") {
        Some(value) => parse_bool_param(value, "assist")?,
        None => false,
    };
    let layout = match query.get("layout") {
        Some(value) => parse_bool_param(value, "layout")?,
        None => false,
    };
    let no_cache = match query.get("noCache") {
        Some(value) => parse_bool_param(value, "noCache")?,
        None => false,
    };
    let mut input = serde_json::Map::new();
    if let Some(mode) = query.get("mode") {
        input.insert("mode".into(), json!(mode));
    }
    if let Some(threshold) = query.get("threshold") {
        input.insert("threshold".into(), json!(threshold));
    }
    if let Some(subject_mode) = query.get("subjectMode") {
        input.insert("subjectMode".into(), json!(subject_mode));
    }
    if layout {
        input.insert("layout".into(), json!("1"));
    }
    if no_cache {
        input.insert("noCache".into(), json!("1"));
    }
    Ok((Value::Object(input), assist))
}

async fn read_bounded(
    headers: &HeaderMap,
    body: Body,
    limit: usize,
    too_large_message: &'static str,
    cancel: &CancellationToken,
) -> Result<Bytes> {
    if headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > limit as u64)
    {
        return Err(ApiError::new(413, "IMAGE_TOO_LARGE", too_large_message));
    }
    let collect = async {
        let mut stream = body.into_data_stream();
        let mut buffer = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ApiError::new(400, "INVALID_BODY", "请求体读取失败"))?;
            if chunk.len() > limit.saturating_sub(buffer.len()) {
                return Err(ApiError::new(413, "IMAGE_TOO_LARGE", too_large_message));
            }
            buffer.extend_from_slice(&chunk);
        }
        Ok(Bytes::from(buffer))
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(ApiError::new(499, "CANCELLED", "图像操作已取消")),
        result = tokio::time::timeout(Duration::from_secs(60), collect) => {
            result.map_err(|_| ApiError::new(408, "IMAGE_UPLOAD_TIMEOUT", "图片上传超时，请重试"))?
        }
    }
}

fn validate_mime(expected: Option<&str>, sniffed: &str) -> Result<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let normalized = expected.trim().to_ascii_lowercase();
    if !matches!(normalized.as_str(), "image/png" | "image/jpeg" | "image/webp") {
        return Err(ApiError::new(
            400,
            "INVALID_IMAGE",
            "mimeType 仅支持 image/png、image/jpeg 或 image/webp",
        ));
    }
    if normalized != sniffed {
        return Err(ApiError::new(
            400,
            "INVALID_IMAGE",
            "声明的 mimeType 与实际图片格式不匹配",
        ));
    }
    Ok(())
}

async fn interrogate(
    State(app): State<AppState>,
    Extension(limits): Extension<Arc<Limits>>,
    Query(query): Query<HashMap<String, String>>,
    request: Request,
) -> Response {
    if let Some(response) = limits.interrogate.check(false) {
        return no_store(response);
    }
    json_response(interrogate_inner(app, query, request).await)
}

async fn interrogate_inner(
    app: AppState,
    query: HashMap<String, String>,
    request: Request,
) -> Result<Value> {
    app.host.check_running()?;
    let service: Arc<InterrogateService> = app
        .interrogate
        .clone()
        .ok_or_else(|| ApiError::new(503, "INTERROGATE_UNAVAILABLE", "本机图像反推服务未启用"))?;
    let mode = parse_content_type(request.headers())?;
    let cancel = app.shutdown.child_token();
    let _guard = cancel.clone().drop_guard();
    let admission = upload_body::admit(&cancel).await?;

    let (params, image, assist, request_key) = match mode {
        InputMode::Json => {
            if !query.is_empty() {
                return Err(ApiError::new(
                    400,
                    "INVALID_PARAMETER",
                    "JSON 模式请将 mode、threshold、assist、subjectMode、layout、noCache 放在请求体中",
                ));
            }
            let (parts, body) = request.into_parts();
            let raw = read_bounded(
                &parts.headers,
                body,
                MAX_JSON_BODY_BYTES,
                "JSON 反推请求超过大小限制（图片解码上限 8 MiB）",
                &cancel,
            )
            .await?;
            let payload: JsonInput = serde_json::from_slice(&raw)
                .map_err(|error| ApiError::new(400, "INVALID_BODY", format!("反推请求体无效：{error}")))?;
            if let Some(key) = payload.request_key.as_deref()
                && !valid_request_key(key)
            {
                return Err(ApiError::new(
                    400,
                    "INVALID_PARAMETER",
                    "requestKey 格式无效",
                ));
            }
            let encoded = payload.image_base64.trim();
            if encoded.is_empty() {
                return Err(ApiError::new(400, "INVALID_IMAGE", "缺少 imageBase64 图片数据"));
            }
            if encoded.len() > MAX_JSON_BASE64_LEN {
                return Err(ApiError::new(
                    413,
                    "IMAGE_TOO_LARGE",
                    "JSON 模式反推图片解码后不能超过 8 MiB",
                ));
            }
            let decoded = STANDARD
                .decode(encoded.as_bytes())
                .map_err(|_| ApiError::new(400, "INVALID_IMAGE", "imageBase64 不是有效的标准 Base64"))?;
            if decoded.len() > MAX_JSON_IMAGE_BYTES {
                return Err(ApiError::new(
                    413,
                    "IMAGE_TOO_LARGE",
                    "JSON 模式反推图片解码后不能超过 8 MiB",
                ));
            }
            if decoded.len() < MIN_IMAGE_BYTES {
                return Err(ApiError::new(400, "INVALID_IMAGE", "图片过小"));
            }
            let (sniffed, _) = image_decode::sniff(&decoded).ok_or_else(|| {
                ApiError::new(400, "INVALID_IMAGE", "仅支持 PNG、JPEG 或 WebP 图片")
            })?;
            validate_mime(payload.mime_type.as_deref(), sniffed)?;
            let mut input = serde_json::Map::new();
            if let Some(mode) = payload.mode {
                input.insert("mode".into(), json!(mode));
            }
            if let Some(threshold) = payload.threshold {
                input.insert("threshold".into(), json!(threshold));
            }
            if let Some(subject_mode) = payload.subject_mode {
                input.insert("subjectMode".into(), json!(subject_mode));
            }
            if payload.layout == Some(true) {
                input.insert("layout".into(), json!("1"));
            }
            if payload.no_cache == Some(true) {
                input.insert("noCache".into(), json!("1"));
            }
            (
                Value::Object(input),
                Bytes::from(decoded),
                payload.assist == Some(true),
                payload.request_key,
            )
        }
        InputMode::Raw { expected_mime } => {
            let (params, assist) = parse_raw_query(&query)?;
            let (parts, body) = request.into_parts();
            let bytes = read_bounded(
                &parts.headers,
                body,
                MAX_BYTES,
                "图片超过 20MB 限制",
                &cancel,
            )
            .await?;
            if bytes.len() < MIN_IMAGE_BYTES {
                return Err(ApiError::new(400, "INVALID_IMAGE", "图片过小"));
            }
            let (sniffed, _) = image_decode::sniff(&bytes).ok_or_else(|| {
                ApiError::new(400, "INVALID_IMAGE", "仅支持 PNG、JPEG 或 WebP 图片")
            })?;
            validate_mime(expected_mime, sniffed)?;
            (params, bytes, assist, None)
        }
    };

    image_decode::validate(Arc::new(image.clone()), &cancel).await?;
    let empty_headers = HeaderMap::new();
    let mut result = service
        .interrogate(
            params,
            image,
            admission,
            assist.then_some((&app, &empty_headers)),
        )
        .await?;
    if let Some(key) = request_key {
        result["requestKey"] = json!(key);
    }
    Ok(result)
}
