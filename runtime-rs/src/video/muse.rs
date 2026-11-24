//! Remote Muse HTTP interface for short video generation, uploads, batches and downloads.
use super::*;
use crate::{
    AppState,
    file_identity::Version,
    http_media::{self, Source},
    images::{ImageKind, upload_body},
};
use axum::{
    Extension, Json, Router,
    body::{Bytes, to_bytes},
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read as _, Seek as _, SeekFrom},
    net::SocketAddr,
    sync::Mutex,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub(crate) const PART_BYTES: u64 = 128 * 1024;
pub(crate) const MAX_PART_COUNT: u64 = 16;
pub(crate) const MAX_RAW_INPUT_BYTES: usize = 20 * 1024 * 1024;
pub(crate) const MAX_JSON_INPUT_BYTES: usize = 3 * 1024 * 1024;
pub(crate) const MAX_JSON_BODY_BYTES: usize = 4 * 1024 * 1024 + 64 * 1024;
const DIGEST_CACHE_CAP: usize = 64;

struct DigestEntry {
    path: PathBuf,
    version: Version,
    sha256: String,
}

struct MuseVideo {
    query_limit: generation::RateLimit,
    upload_limit: generation::RateLimit,
    job_limit: generation::RateLimit,
    digests: Mutex<VecDeque<DigestEntry>>,
}

impl MuseVideo {
    fn new() -> Self {
        Self {
            query_limit: generation::RateLimit::with("远程视频状态查询", 60, 200),
            upload_limit: generation::RateLimit::with("远程视频素材上传", 16, 2_000),
            job_limit: generation::RateLimit::with("远程视频生成", 6, 15_000),
            digests: Mutex::new(VecDeque::with_capacity(DIGEST_CACHE_CAP)),
        }
    }

    fn cached_digest(&self, path: &PathBuf, version: &Version) -> Option<String> {
        self.digests
            .lock()
            .unwrap()
            .iter()
            .find(|entry| &entry.path == path && &entry.version == version)
            .map(|entry| entry.sha256.clone())
    }

    fn remember_digest(&self, path: PathBuf, version: Version, sha256: String) {
        let mut cache = self.digests.lock().unwrap();
        cache.retain(|entry| entry.path != path);
        if cache.len() >= DIGEST_CACHE_CAP {
            cache.pop_front();
        }
        cache.push_back(DigestEntry {
            path,
            version,
            sha256,
        });
    }
}

pub(crate) fn router() -> Router<AppState> {
    let muse = Arc::new(MuseVideo::new());
    Router::new()
        .route("/api/muse/video/status", get(status))
        .route(
            "/api/muse/video/prompt/preview",
            post(preview_prompt).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/muse/video/inputs",
            post(upload_input).layer(DefaultBodyLimit::max(MAX_RAW_INPUT_BYTES)),
        )
        .route(
            "/api/muse/video/jobs",
            post(create_job).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route("/api/muse/video/jobs/{id}", get(get_job).delete(cancel_job))
        .route("/api/muse/video/jobs/{id}/result", get(job_result))
        .route(
            "/api/muse/video/requests/{key}",
            get(job_request_status).delete(cancel_job_request),
        )
        .route(
            "/api/muse/video/batches",
            post(create_batch).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/muse/video/batches/{id}",
            get(get_batch).delete(cancel_batch),
        )
        .route("/api/muse/video/batches/{id}/result", get(batch_result))
        .route("/api/muse/video/batches/{id}/concat", post(concat_batch))
        .route(
            "/api/muse/video/batches/{id}/retry",
            post(retry_batch).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/muse/video/batch-requests/{key}",
            get(batch_request_status).delete(cancel_batch_request),
        )
        .layer(Extension(muse))
}

fn response(result: Result<Value>, status: StatusCode) -> Response {
    let mut response = match result {
        Ok(mut value) => {
            value["ok"] = json!(true);
            (status, Json(value)).into_response()
        }
        Err(err) => err.into_response(),
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

fn video_service(state: &AppState) -> Result<&Arc<Service>> {
    state
        .video
        .as_ref()
        .ok_or_else(|| error(503, "VIDEO_UNAVAILABLE", "视频生成服务未启用"))
}

async fn status(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if let Some(limited) = muse.query_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let Some(service) = state.video.as_ref() else {
                return Ok(json!({
                    "online": false,
                    "available": false,
                    "engine": "off",
                    "provider": "off",
                    "models": [],
                    "pending": 0,
                    "maxPending": 0,
                    "defaults": {},
                    "qualities": [],
                    "partBytes": PART_BYTES,
                    "maxPartCount": MAX_PART_COUNT,
                    "maxRawInputBytes": MAX_RAW_INPUT_BYTES,
                    "maxJsonInputBytes": MAX_JSON_INPUT_BYTES,
                    "supportedInputKinds": [
                        "image",
                        "first-frame",
                        "last-frame",
                        "studio-frame",
                        "reference",
                        "driving-video",
                        "driving-audio",
                        "studio-audio"
                    ]
                }));
            };
            let mut value = if query.get("modelId").is_some_and(|id| {
                matches!(
                    id.as_str(),
                    crate::studio_workflows::MODEL | crate::studio_workflows::DIALOGUE
                )
            }) {
                native::status(&service.backend).await?
            } else {
                service.get_status().await?
            };
            if value.get("engine").is_none() {
                value["engine"] = json!(if service.backend.native_enabled() {
                    "native"
                } else {
                    "comfy"
                });
            }
            if value.get("provider").is_none() {
                value["provider"] = value["engine"].clone();
            }
            value["available"] = json!(value["online"] == true);
            value["partBytes"] = json!(PART_BYTES);
            value["maxPartCount"] = json!(MAX_PART_COUNT);
            value["maxRawInputBytes"] = json!(MAX_RAW_INPUT_BYTES);
            value["maxJsonInputBytes"] = json!(MAX_JSON_INPUT_BYTES);
            value["supportedInputKinds"] = json!([
                "image",
                "first-frame",
                "last-frame",
                "studio-frame",
                "reference",
                "driving-video",
                "driving-audio",
                "studio-audio"
            ]);
            Ok(value)
        }
        .await,
        StatusCode::OK,
    )
}

async fn preview_prompt(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(limited) = muse.query_limit.check(false) {
        return limited;
    }
    let result = (|| {
        state.host.check_running()?;
        let service = video_service(&state)?;
        let id = body["modelId"].as_str().unwrap_or("");
        let is_native = service.uses_native_model(&body["modelId"]);
        let model = if is_native {
            native::video_model(id)?
        } else {
            catalog::model(id).ok_or_else(|| error(400, "UNKNOWN_MODEL", "未知视频模型"))?
        };
        let mode = body["mode"].as_str().unwrap_or("");
        let duration = validation::duration_for(
            &body,
            is_native.then_some(model),
            model["family"] == "minimax-h3",
        )?;
        validation::validate_motion(&body)?;
        let compiled = prompt_compiler::compile(&body, model, mode, duration)?;
        let mut value = json!({"prompt": compiled.prompt});
        if let Some(negative) = compiled.negative {
            value["negative"] = json!(negative);
        }
        Ok(value)
    })();
    response(result, StatusCode::OK)
}

fn parse_input_kind(raw: Option<&str>) -> Result<(ImageKind, &'static str)> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("image" | "first-frame" | "last-frame" | "frame") => {
            Ok((ImageKind::VideoInput, "image"))
        }
        Some("studio-frame") => Ok((ImageKind::StudioVideoInput, "studio-frame")),
        Some("reference" | "ref") => Ok((ImageKind::VideoReference, "reference")),
        Some("video" | "driving-video" | "motion") => Ok((ImageKind::MotionVideo, "driving-video")),
        Some("audio" | "driving-audio") => Ok((ImageKind::DrivingAudio, "driving-audio")),
        Some("studio-audio") => Ok((ImageKind::StudioAudio, "studio-audio")),
        _ => Err(error(
            400,
            "INVALID_PARAMETER",
            "未知视频输入类型，支持 image/first-frame/last-frame/studio-frame/reference/driving-video/driving-audio/studio-audio",
        )),
    }
}

fn normalize_mime(raw: &str) -> String {
    let base = raw
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match base.as_str() {
        "image/jpg" => "image/jpeg".into(),
        "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => "audio/wav".into(),
        _ => base,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JsonInputUpload {
    kind: Option<String>,
    mime_type: String,
    data: String,
}

async fn collect_bounded_body(
    request: Request,
    limit: usize,
    scope: &CancellationToken,
) -> Result<Bytes> {
    if let Some(length) = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        && length > limit as u64
    {
        return Err(error(
            413,
            "VIDEO_INPUT_TOO_LARGE",
            format!("上传内容超出 {} 字节限制", limit),
        ));
    }
    let body = request.into_body();
    tokio::select! {
        biased;
        _ = scope.cancelled() => Err(error(499, "CANCELLED", "素材上传已取消")),
        collected = tokio::time::timeout(Duration::from_secs(60), to_bytes(body, limit)) => {
            let bytes = collected
                .map_err(|_| error(408, "VIDEO_UPLOAD_TIMEOUT", "视频素材上传超时，请重试"))?
                .map_err(|err| {
                    if err.to_string().to_ascii_lowercase().contains("length limit") {
                        error(413, "VIDEO_INPUT_TOO_LARGE", format!("上传内容超出 {} 字节限制", limit))
                    } else {
                        error(400, "VIDEO_INPUT_BODY_INVALID", "无法读取上传请求体")
                    }
                })?;
            Ok(bytes)
        }
    }
}

async fn upload_input(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    if let Some(limited) = muse.upload_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let content_type = headers
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<mime::Mime>().ok());
            let is_json = match content_type.as_ref().map(|m| m.essence_str()) {
                Some("application/octet-stream") => false,
                Some("application/json") => true,
                _ => {
                    return Err(error(
                        415,
                        "VIDEO_INPUT_BODY_INVALID",
                        "Content-Type 须为 application/octet-stream 或 application/json",
                    ));
                }
            };
            let scope = service.shutdown.child_token();
            let _guard = scope.clone().drop_guard();
            let admission = upload_body::admit(&scope).await?;
            let (kind, canonical_kind, bytes, declared_mime) = if is_json {
                let raw = collect_bounded_body(request, MAX_JSON_BODY_BYTES, &scope).await?;
                let parsed: JsonInputUpload = serde_json::from_slice(&raw).map_err(|_| {
                    error(
                        400,
                        "INVALID_BODY",
                        "JSON 上传须包含 mimeType、data（标准 Base64）及可选 kind",
                    )
                })?;
                let (kind, canonical_kind) =
                    parse_input_kind(parsed.kind.as_deref().or_else(|| query.get("kind").map(String::as_str)))?;
                if parsed.data.is_empty() {
                    return Err(error(400, "VIDEO_INPUT_INVALID", "上传数据不能为空"));
                }
                if parsed.data.len() > MAX_JSON_INPUT_BYTES.div_ceil(3) * 4 {
                    return Err(error(
                        413,
                        "VIDEO_INPUT_TOO_LARGE",
                        "JSON Base64 素材大小不能超过 3 MiB",
                    ));
                }
                let decoded = STANDARD.decode(&parsed.data).map(Bytes::from).map_err(|_| {
                    error(400, "VIDEO_INPUT_BASE64", "data 须为原文件的标准 Base64")
                })?;
                if decoded.len() < 16 {
                    return Err(error(400, "VIDEO_INPUT_INVALID", "上传素材内容过小或已损坏"));
                }
                if decoded.len() > MAX_JSON_INPUT_BYTES {
                    return Err(error(
                        413,
                        "VIDEO_INPUT_TOO_LARGE",
                        "JSON Base64 素材大小不能超过 3 MiB",
                    ));
                }
                let declared = normalize_mime(&parsed.mime_type);
                if declared.is_empty() {
                    return Err(error(415, "VIDEO_INPUT_TYPE", "缺少有效的 mimeType"));
                }
                (kind, canonical_kind, decoded, Some(declared))
            } else {
                let (kind, canonical_kind) =
                    parse_input_kind(query.get("kind").map(String::as_str))?;
                let raw = collect_bounded_body(request, MAX_RAW_INPUT_BYTES, &scope).await?;
                if raw.len() < 16 {
                    return Err(error(400, "VIDEO_INPUT_INVALID", "上传素材内容过小或已损坏"));
                }
                if raw.len() > MAX_RAW_INPUT_BYTES {
                    return Err(error(
                        413,
                        "VIDEO_INPUT_TOO_LARGE",
                        "直传视频素材大小不能超过 20 MiB",
                    ));
                }
                (kind, canonical_kind, raw, None)
            };

            let (sniffed_mime, _) = kind.format(&bytes).ok_or_else(|| {
                error(
                    415,
                    "VIDEO_INPUT_TYPE",
                    match kind {
                        ImageKind::MotionVideo => "驱动视频仅支持 MP4 (video/mp4)",
                        ImageKind::DrivingAudio | ImageKind::StudioAudio => {
                            "驱动音频仅支持 PCM WAV (audio/wav)"
                        }
                        _ => "帧图与参考图仅支持 PNG、JPEG 或 WebP",
                    },
                )
            })?;
            if let Some(declared) = declared_mime
                && declared != sniffed_mime
            {
                return Err(error(
                    415,
                    "VIDEO_INPUT_TYPE",
                    format!("声明的 mimeType（{declared}）与文件内容（{sniffed_mime}）不符"),
                ));
            }
            let audio_frames = if matches!(kind, ImageKind::StudioAudio) {
                Some(inputs::dialogue_frames(&bytes)?)
            } else if matches!(kind, ImageKind::DrivingAudio) {
                inputs::dialogue_frames(&bytes).ok()
            } else {
                None
            };
            let sha256 = hex::encode(Sha256::digest(&bytes));
            let owner = generation::request_owner(&headers, peer, &query);
            let name = service
                .upload(bytes, owner, kind, service.shutdown.child_token(), admission)
                .await?;
            let file_bytes = tokio::fs::metadata(inputs::path(&service.config, &name)?)
                .await?
                .len();
            let mut receipt = json!({
                "inputId": name,
                "name": name,
                "kind": canonical_kind,
                "mimeType": sniffed_mime,
                "bytes": file_bytes,
                "sha256": sha256
            });
            if let Some(frames) = audio_frames {
                receipt["audioFrames"] = frames.into();
            }
            Ok(receipt)
        }
        .await,
        StatusCode::OK,
    )
}

async fn enrich_job(
    muse: &MuseVideo,
    service: &Service,
    owner: &str,
    job: &mut Value,
    cancel: &CancellationToken,
) {
    let Some(id) = job.get("id").and_then(Value::as_str).map(str::to_owned) else {
        return;
    };
    let available = job["resultAvailable"] == true
        || job
            .get("resultUrl")
            .and_then(Value::as_str)
            .is_some_and(|u| !u.is_empty());
    if !available {
        return;
    }
    job["resultUrl"] = json!(format!("/api/muse/video/jobs/{id}/result"));
    job["partBytes"] = json!(PART_BYTES);
    if let Ok(Output::File { path, mime, bytes }) = service.result(&id, owner).await {
        job["resultBytes"] = json!(bytes);
        job["resultMime"] = json!(mime);
        if let Ok((_, sha256)) = open_verified_video(muse, &service.config, path, bytes, cancel).await {
            job["resultSha256"] = json!(sha256);
        }
    }
}

async fn enrich_batch(
    muse: &MuseVideo,
    service: &Service,
    owner: &str,
    batch: &mut Value,
    cancel: &CancellationToken,
) {
    if let Some(shots) = batch.get_mut("shots").and_then(Value::as_array_mut) {
        for shot in shots {
            if let Some(url) = shot.get("resultUrl").and_then(Value::as_str)
                && let Some(suffix) = url.strip_prefix("/api/video/jobs/")
            {
                shot["resultUrl"] = json!(format!("/api/muse/video/jobs/{suffix}"));
            }
        }
    }
    let Some(id) = batch.get("id").and_then(Value::as_str).map(str::to_owned) else {
        return;
    };
    if batch["concatAvailable"] == true {
        batch["concatUrl"] = json!(format!("/api/muse/video/batches/{id}/result"));
        batch["partBytes"] = json!(PART_BYTES);
        if let Ok(Output::File { path, mime, bytes }) = service.batch_result(&id, owner).await {
            batch["concatBytes"] = json!(bytes);
            batch["concatMime"] = json!(mime);
            if let Ok((_, sha256)) =
                open_verified_video(muse, &service.config, path, bytes, cancel).await
            {
                batch["concatSha256"] = json!(sha256);
            }
        }
    }
}

async fn create_job(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Response {
    if let Some(limited) = muse.job_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let key = body
                .get("requestKey")
                .and_then(Value::as_str)
                .ok_or_else(|| ApiError::invalid("视频请求必须携带请求编号 requestKey"))?
                .to_owned();
            if let Some(object) = body.as_object_mut() {
                object.remove("requestKey");
            }
            let owner = generation::request_owner(&headers, peer, &query);
            let mut value = service
                .accept_request(requests::RequestInput::Job(body), key, owner.clone(), false)
                .await?;
            if let Some(job) = value.get_mut("job") {
                enrich_job(&muse, service, &owner, job, &state.shutdown).await;
            }
            Ok(value)
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

async fn get_job(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(limited) = muse.query_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            let mut job = service.get_job(&id, &owner).await?;
            enrich_job(&muse, service, &owner, &mut job, &state.shutdown).await;
            Ok(json!({"job": job}))
        }
        .await,
        StatusCode::OK,
    )
}

async fn cancel_job(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            let mut job = service.cancel(&id, &owner).await?;
            enrich_job(&muse, service, &owner, &mut job, &state.shutdown).await;
            Ok(json!({"job": job}))
        }
        .await,
        StatusCode::OK,
    )
}

async fn job_request_status(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(limited) = muse.query_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            let mut value = service.request_status(&key, &owner, requests::JOB).await?;
            if let Some(job) = value.get_mut("job") {
                enrich_job(&muse, service, &owner, job, &state.shutdown).await;
            }
            Ok(value)
        }
        .await,
        StatusCode::OK,
    )
}

async fn cancel_job_request(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            service.cancel_request(&key, &owner, requests::JOB).await
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

async fn create_batch(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Response {
    if let Some(limited) = muse.job_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let key = body
                .get("requestKey")
                .and_then(Value::as_str)
                .ok_or_else(|| ApiError::invalid("分镜批次请求必须携带请求编号 requestKey"))?
                .to_owned();
            if let Some(object) = body.as_object_mut() {
                object.remove("requestKey");
            }
            let owner = generation::request_owner(&headers, peer, &query);
            let mut value = service
                .accept_request(requests::RequestInput::Batch(body), key, owner.clone(), false)
                .await?;
            if let Some(batch) = value.get_mut("batch") {
                enrich_batch(&muse, service, &owner, batch, &state.shutdown).await;
            }
            Ok(value)
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

async fn get_batch(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(limited) = muse.query_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            let mut batch = service.get_batch(&id, &owner).await?;
            enrich_batch(&muse, service, &owner, &mut batch, &state.shutdown).await;
            Ok(json!({"batch": batch}))
        }
        .await,
        StatusCode::OK,
    )
}

async fn cancel_batch(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            let mut batch = service.cancel_batch(&id, &owner).await?;
            enrich_batch(&muse, service, &owner, &mut batch, &state.shutdown).await;
            Ok(json!({"batch": batch}))
        }
        .await,
        StatusCode::OK,
    )
}

async fn concat_batch(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(limited) = muse.job_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let cancel = service.shutdown.child_token();
            let _guard = cancel.clone().drop_guard();
            let owner = generation::request_owner(&headers, peer, &query);
            let mut batch = service
                .clone()
                .batch_action(&id, &owner, "concat", cancel)
                .await?;
            enrich_batch(&muse, service, &owner, &mut batch, &state.shutdown).await;
            Ok(json!({"batch": batch}))
        }
        .await,
        StatusCode::OK,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetrySelection {
    indices: Vec<usize>,
    request_key: String,
}

async fn retry_batch(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(selection): Json<RetrySelection>,
) -> Response {
    if let Some(limited) = muse.job_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let indices = selection
                .indices
                .into_iter()
                .map(|index| {
                    index
                        .checked_sub(1)
                        .ok_or_else(|| error(400, "SHOT_INDEX_INVALID", "分镜序号无效"))
                })
                .collect::<Result<Vec<_>>>()?;
            let owner = generation::request_owner(&headers, peer, &query);
            let mut value = service
                .accept_request(
                    requests::RequestInput::Retry {
                        batch_id: id,
                        indices,
                    },
                    selection.request_key,
                    owner.clone(),
                    false,
                )
                .await?;
            if let Some(batch) = value.get_mut("batch") {
                enrich_batch(&muse, service, &owner, batch, &state.shutdown).await;
            }
            Ok(value)
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

async fn batch_request_status(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(limited) = muse.query_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            let mut value = service.request_status(&key, &owner, requests::BATCH).await?;
            if let Some(batch) = value.get_mut("batch") {
                enrich_batch(&muse, service, &owner, batch, &state.shutdown).await;
            }
            Ok(value)
        }
        .await,
        StatusCode::OK,
    )
}

async fn cancel_batch_request(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            service.cancel_request(&key, &owner, requests::BATCH).await
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

async fn open_verified_video(
    muse: &MuseVideo,
    config: &Config,
    path: PathBuf,
    expected_bytes: u64,
    cancel: &CancellationToken,
) -> Result<(tokio::fs::File, String)> {
    let root = tokio::fs::canonicalize(config.runtime_root.join("outputs/video"))
        .await
        .map_err(|_| error(404, "RESULT_NOT_FOUND", "视频结果不存在"))?;
    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| error(404, "RESULT_NOT_FOUND", "视频结果不存在"))?;
    if !canonical.starts_with(&root) {
        return Err(error(404, "RESULT_NOT_FOUND", "视频结果不存在"));
    }
    let scope = cancel.child_token();
    let _guard = scope.clone().drop_guard();
    let check_path = canonical.clone();
    let (file, version) = tokio::task::spawn_blocking(move || -> Result<(std::fs::File, Version)> {
        let file = std::fs::File::open(&check_path)
            .map_err(|_| error(404, "RESULT_NOT_FOUND", "视频结果不存在"))?;
        let meta = file.metadata()?;
        if !meta.is_file() {
            return Err(error(404, "RESULT_NOT_FOUND", "视频结果不存在"));
        }
        if meta.len() != expected_bytes {
            return Err(error(409, "RESULT_CHANGED", "视频结果在读取前发生变化"));
        }
        let version = Version::of(&file)?;
        Ok((file, version))
    })
    .await
    .map_err(|_| error(503, "RESULT_UNAVAILABLE", "视频结果读取未完成"))??;

    if let Some(sha256) = muse.cached_digest(&canonical, &version) {
        return Ok((tokio::fs::File::from_std(file), sha256));
    }
    let hash_cancel = scope.clone();
    let (file, sha256) =
        tokio::task::spawn_blocking(move || -> Result<(std::fs::File, String)> {
            let mut file = file;
            let mut hasher = Sha256::new();
            let mut buffer = vec![0u8; 256 * 1024];
            let mut read_total = 0u64;
            loop {
                if hash_cancel.is_cancelled() {
                    return Err(error(499, "CANCELLED", "视频校验已取消"));
                }
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
                read_total += count as u64;
                if read_total > expected_bytes {
                    return Err(error(409, "RESULT_CHANGED", "视频结果在校验期间发生变化"));
                }
            }
            if read_total != expected_bytes {
                return Err(error(409, "RESULT_CHANGED", "视频结果在校验期间发生变化"));
            }
            file.seek(SeekFrom::Start(0))?;
            Ok((file, hex::encode(hasher.finalize())))
        })
        .await
        .map_err(|_| error(503, "RESULT_UNAVAILABLE", "视频校验未完成"))??;
    muse.remember_digest(canonical, version, sha256.clone());
    Ok((tokio::fs::File::from_std(file), sha256))
}

async fn serve_part(
    mut file: tokio::fs::File,
    total: u64,
    mime: &str,
    digest: &str,
    part_index: &str,
    count: Option<&String>,
    method: &Method,
    cancel: CancellationToken,
) -> Result<Response> {
    let start = part_index
        .parse::<u64>()
        .ok()
        .and_then(|index| index.checked_mul(PART_BYTES))
        .filter(|&start| start < total)
        .ok_or_else(|| {
            error(
                416,
                "RESULT_PART_INVALID",
                "分片从 0 开始，编号超出视频范围",
            )
        })?;
    let count = count
        .map_or(Some(1), |s| s.parse::<u64>().ok())
        .filter(|n| (1..=MAX_PART_COUNT).contains(n))
        .ok_or_else(|| ApiError::invalid("每次可取 1 至 16 片视频分片"))?;
    let size = (total - start).min(PART_BYTES * count) as usize;
    let mut part = vec![0u8; size];
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(error(499, "CANCELLED", "视频分片读取已取消")),
        io = async {
            file.seek(SeekFrom::Start(start)).await?;
            file.read_exact(&mut part).await
        } => { io?; }
    }
    let part_digest = hex::encode(Sha256::digest(&part));
    let body = if *method == Method::HEAD {
        Bytes::new()
    } else {
        Bytes::from(part)
    };
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&size.to_string()).unwrap(),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, no-transform"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Ok(value) = HeaderValue::from_str(mime) {
        headers.insert("x-result-mime", value);
    }
    headers.insert(
        "x-result-offset",
        HeaderValue::from_str(&start.to_string()).unwrap(),
    );
    headers.insert(
        "x-result-bytes",
        HeaderValue::from_str(&total.to_string()).unwrap(),
    );
    headers.insert("x-result-sha256", HeaderValue::from_str(digest).unwrap());
    headers.insert(
        "x-part-sha256",
        HeaderValue::from_str(&part_digest).unwrap(),
    );
    headers.insert(
        "x-part-bytes",
        HeaderValue::from_str(&PART_BYTES.to_string()).unwrap(),
    );
    Ok(response)
}

async fn serve_video_output(
    state: &AppState,
    muse: &MuseVideo,
    service: &Service,
    output: Output,
    query: &HashMap<String, String>,
    headers: &HeaderMap,
    method: &Method,
) -> Result<Response> {
    let Output::File { path, mime, bytes } = output else {
        return Err(error(404, "RESULT_NOT_FOUND", "视频结果不存在"));
    };
    if bytes == 0 {
        return Err(error(404, "RESULT_NOT_FOUND", "视频结果为空"));
    }
    let (file, digest) =
        open_verified_video(muse, &service.config, path, bytes, &state.shutdown).await?;
    if let Some(part) = query.get("part") {
        if headers.contains_key(header::RANGE) {
            return Err(ApiError::invalid(
                "分片请求无需 Range；请单独使用 part 或 Range",
            ));
        }
        return serve_part(
            file,
            bytes,
            &mime,
            &digest,
            part,
            query.get("count"),
            method,
            state.shutdown.clone(),
        )
        .await;
    }
    let etag = format!("\"{digest}\"");
    let range_header = headers
        .get(header::RANGE)
        .filter(|_| {
            *method == Method::GET
                && headers
                    .get(header::IF_RANGE)
                    .is_none_or(|value| value.as_bytes() == etag.as_bytes())
        })
        .map(|value| value.to_str().unwrap_or(""));
    let mut response = match http_media::range(range_header, bytes) {
        Ok(range) => {
            http_media::stream(
                method,
                range,
                Source::Opened(file, service.shutdown.clone()),
                state.shutdown.clone(),
            )
            .await?
        }
        Err(response) => response,
    };
    let out_headers = response.headers_mut();
    out_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, no-transform"),
    );
    out_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    out_headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Ok(value) = HeaderValue::from_str(&mime) {
        out_headers.insert(header::CONTENT_TYPE, value);
    }
    if let Ok(value) = HeaderValue::from_str(&etag) {
        out_headers.insert(header::ETAG, value);
    }
    out_headers.insert(
        "x-result-bytes",
        HeaderValue::from_str(&bytes.to_string()).unwrap(),
    );
    out_headers.insert(
        "x-result-sha256",
        HeaderValue::from_str(&digest).unwrap(),
    );
    Ok(response)
}

async fn job_result(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    match async {
        state.host.check_running()?;
        let service = video_service(&state)?;
        let owner = generation::request_owner(&headers, peer, &query);
        let output = service.result(&id, &owner).await?;
        serve_video_output(&state, &muse, service, output, &query, &headers, &method).await
    }
    .await
    {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}

async fn batch_result(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    match async {
        state.host.check_running()?;
        let service = video_service(&state)?;
        let owner = generation::request_owner(&headers, peer, &query);
        let output = service.batch_result(&id, &owner).await?;
        serve_video_output(&state, &muse, service, output, &query, &headers, &method).await
    }
    .await
    {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}
