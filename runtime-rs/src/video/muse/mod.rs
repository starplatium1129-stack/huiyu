//! Remote Muse HTTP interface for short video generation, uploads, batches and downloads.
mod batches;
mod inputs;
mod jobs;
mod media;

use super::*;
use crate::{AppState, file_identity::Version};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};

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
            post(inputs::upload_input).layer(DefaultBodyLimit::max(MAX_RAW_INPUT_BYTES)),
        )
        .route(
            "/api/muse/video/jobs",
            post(jobs::create_job).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/muse/video/jobs/{id}",
            get(jobs::get_job).delete(jobs::cancel_job),
        )
        .route("/api/muse/video/jobs/{id}/result", get(jobs::job_result))
        .route(
            "/api/muse/video/requests/{key}",
            get(jobs::job_request_status).delete(jobs::cancel_job_request),
        )
        .route(
            "/api/muse/video/batches",
            post(batches::create_batch).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/muse/video/batches/{id}",
            get(batches::get_batch).delete(batches::cancel_batch),
        )
        .route(
            "/api/muse/video/batches/{id}/result",
            get(batches::batch_result),
        )
        .route(
            "/api/muse/video/batches/{id}/concat",
            post(batches::concat_batch),
        )
        .route(
            "/api/muse/video/batches/{id}/retry",
            post(batches::retry_batch).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/muse/video/batch-requests/{key}",
            get(batches::batch_request_status).delete(batches::cancel_batch_request),
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
