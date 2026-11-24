//! Strictly read-only remote health summary and desktop gallery query/download endpoints.
//! Never exposes arbitrary file paths, secrets, tokens, environment variables, or mutations.
use crate::{
    AppState,
    error::{ApiError, Result},
    generation::RateLimit,
    http_media::{self, Source},
    storage::Storage,
};
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::SeekFrom, sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub(crate) const PART_BYTES: u64 = 128 * 1024;
pub(crate) const MAX_PART_COUNT: u64 = 16;
pub(crate) const MAX_GALLERY_PAGE_SIZE: usize = 50;
const MAX_GALLERY_PAGE: usize = 200;
const MAX_GALLERY_SCAN_ITEMS: usize = 5000;
const READ_PRINCIPAL: &str = "muse:readonly";

struct OpsLimits {
    health: RateLimit,
    gallery: RateLimit,
}

pub(crate) fn router() -> Router<AppState> {
    let limits = Arc::new(OpsLimits {
        health: RateLimit::with("远程健康检查", 30, 500),
        gallery: RateLimit::with("作品册只读查询", 60, 200),
    });
    Router::new()
        .route("/api/muse/health", get(health))
        .route("/api/muse/gallery", get(gallery_list))
        .route("/api/muse/gallery/{id}", get(gallery_item))
        .route("/api/muse/gallery/{id}/file", get(gallery_file))
        .layer(Extension(limits))
}

fn json_response(result: Result<Value>) -> Response {
    let mut response = match result {
        Ok(mut value) => {
            value["ok"] = json!(true);
            (StatusCode::OK, Json(value)).into_response()
        }
        Err(err) => err.into_response(),
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

fn count_models(models: Option<&Vec<Value>>) -> (usize, usize) {
    let Some(models) = models else {
        return (0, 0);
    };
    let available = models.iter().filter(|m| m["available"] == true).count();
    (available, models.len())
}

async fn health(
    State(state): State<AppState>,
    Extension(limits): Extension<Arc<OpsLimits>>,
) -> Response {
    if let Some(limited) = limits.health.check(false) {
        return limited;
    }
    json_response(
        async {
            state.host.check_running()?;

            let mut image_engine = "off".to_owned();
            let mut video_engine = "off".to_owned();
            let mut acceleration = "native".to_owned();
            let mut memory_policy = "auto".to_owned();
            let mut image_online = false;
            let mut image_avail = 0usize;
            let mut image_total = 0usize;
            let mut image_pending = 0usize;
            let mut gpu_owned = false;

            if let Some(images) = state.images.as_ref() {
                gpu_owned = images.native_gpu_owned();
                image_pending = images.backend.pending();
                if let Ok(settings) = images.backend.native_settings() {
                    image_engine = settings.engine.clone();
                    if let Some(v_eng) = settings.video_engine.as_deref() {
                        video_engine = v_eng.to_owned();
                    } else if state.video.is_some() {
                        video_engine = if settings.engine == "native" {
                            "native".into()
                        } else {
                            "comfy".into()
                        };
                    }
                    acceleration = settings.acceleration;
                    memory_policy = settings.memory_policy;
                }
                if image_engine == "native" {
                    let cancel = state.shutdown.child_token();
                    let _guard = cancel.clone().drop_guard();
                    if let Ok(Ok(status)) = tokio::time::timeout(
                        Duration::from_secs(3),
                        crate::images::native::status(&images.backend, "", cancel),
                    )
                    .await
                    {
                        let (avail, total) = count_models(status["models"].as_array());
                        image_avail = avail;
                        image_total = total;
                        image_online = status["online"] == true || avail > 0;
                    }
                } else if let Ok(Ok(status)) = tokio::time::timeout(
                    Duration::from_secs(3),
                    images.get_status("anima"),
                )
                .await
                {
                    let (avail, total) = count_models(status["models"].as_array());
                    image_avail = avail;
                    image_total = total;
                    image_online = status["online"] == true;
                }
            }

            let mut video_online = false;
            let mut video_avail = 0usize;
            let mut video_total = 0usize;
            let mut video_h3_dwd = false;
            let mut video_pending = 0u64;
            if let Some(video) = state.video.as_ref() {
                if let Ok(Ok(status)) =
                    tokio::time::timeout(Duration::from_secs(3), video.get_status()).await
                {
                    if let Some(engine) = status["engine"].as_str() {
                        video_engine = engine.to_owned();
                    }
                    video_online = status["online"] == true;
                    video_pending = status["pending"].as_u64().unwrap_or(0);
                    let (avail, total) = count_models(status["models"].as_array());
                    video_avail = avail;
                    video_total = total;
                    video_h3_dwd = status["models"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|m| m["id"] == "minimax-h3" && m["h3Dwd"] == true);
                }
            }

            let voice_enabled = state.voice.is_some();
            let (voice_engine_id, voice_available, voice_native_ready) =
                if let Some(voice) = state.voice.as_ref() {
                    let id = voice.engine_id();
                    let native_ready = voice.native_ready();
                    let available = match id {
                        "off" | "system" => false,
                        "native" | "qwen-tts" | "gpt-sovits" => {
                            native_ready || voice.native_files_present()
                        }
                        "openai" => voice.openai_configured(),
                        _ => true,
                    };
                    (id, available, native_ready)
                } else {
                    ("off", false, false)
                };

            let interrogate_enabled = state.interrogate.is_some();
            let desktop_chat_enabled = state.chat.is_some();
            let live2d_available = state
                .live2d
                .as_ref()
                .is_some_and(|service| service.health_status()["available"] == true);
            let qq_vm_configured =
                crate::companion_channels::muse_vm_peer(&state.config.runtime_root)
                    .await
                    .ok()
                    .flatten()
                    .is_some();

            let workspace = state.host.storage();
            let workspace_available = workspace.is_some();
            let gallery_artworks = if let Some(storage) = workspace.as_ref() {
                tokio::time::timeout(
                    Duration::from_secs(2),
                    storage.request(
                        json!({"kind": "readGalleryPage", "query": {}, "limit": 1}),
                        READ_PRINCIPAL,
                    ),
                )
                .await
                .ok()
                .and_then(|res| res.ok())
                .and_then(|val| val["total"].as_i64())
            } else {
                None
            };

            Ok(json!({
                "online": true,
                "app": "ai-cg-studio",
                "runtime": "rust",
                "protocolVersion": 1,
                "serverNow": crate::host::now_ms(),
                "remoteListening": super::listening(),
                "inference": {
                    "imageEngine": image_engine,
                    "videoEngine": video_engine,
                    "acceleration": acceleration,
                    "memoryPolicy": memory_policy,
                    "gpuOwned": gpu_owned
                },
                "modules": {
                    "image": {
                        "enabled": state.images.is_some(),
                        "online": image_online,
                        "engine": image_engine,
                        "availableModels": image_avail,
                        "totalModels": image_total,
                        "pending": image_pending
                    },
                    "video": {
                        "enabled": state.video.is_some(),
                        "online": video_online,
                        "engine": video_engine,
                        "availableModels": video_avail,
                        "totalModels": video_total,
                        "h3Dwd": video_h3_dwd,
                        "pending": video_pending
                    },
                    "interrogate": {
                        "enabled": interrogate_enabled,
                        "available": interrogate_enabled
                    },
                    "voice": {
                        "enabled": voice_enabled,
                        "available": voice_available,
                        "engineId": voice_engine_id,
                        "nativeReady": voice_native_ready
                    },
                    "qq": {
                        "enabled": true,
                        "vmConfigured": qq_vm_configured
                    },
                    "desktop": {
                        "chatEnabled": desktop_chat_enabled,
                        "workspaceAvailable": workspace_available,
                        "live2dAvailable": live2d_available
                    }
                },
                "counts": {
                    "imageModelsAvailable": image_avail,
                    "imageModelsTotal": image_total,
                    "videoModelsAvailable": video_avail,
                    "videoModelsTotal": video_total,
                    "galleryArtworks": gallery_artworks
                },
                "capabilities": {
                    "image": state.images.is_some(),
                    "video": state.video.is_some(),
                    "videoH3Dwd": video_h3_dwd,
                    "videoBatch": state.video.is_some(),
                    "interrogate": interrogate_enabled,
                    "voice": voice_enabled && voice_available,
                    "qq": true,
                    "desktopChat": desktop_chat_enabled,
                    "gallery": workspace_available,
                    "partDownload": true,
                    "rangeDownload": true,
                    "partBytes": PART_BYTES
                }
            }))
        }
        .await,
    )
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct GalleryListQuery {
    page: Option<usize>,
    page_size: Option<usize>,
    kind: Option<String>,
    media_type: Option<String>,
    character: Option<String>,
    search: Option<String>,
    favorite: Option<String>,
    tag: Option<String>,
    engine: Option<String>,
    model: Option<String>,
    review_state: Option<String>,
}

fn parse_optional_bool(value: Option<&str>) -> Result<Option<bool>> {
    let Some(raw) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    match raw.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" => Ok(Some(true)),
        "0" | "false" | "no" => Ok(Some(false)),
        _ => Err(ApiError::invalid("favorite 须为 true/false 或 1/0")),
    }
}

fn parse_media_kind(kind: Option<&str>, media_type: Option<&str>) -> Result<Option<&'static str>> {
    let raw = media_type
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| kind.map(str::trim).filter(|s| !s.is_empty()));
    match raw.map(|s| s.to_ascii_lowercase()).as_deref() {
        None | Some("all") => Ok(None),
        Some("image" | "photo" | "picture") => Ok(Some("image")),
        Some("video") => Ok(Some("video")),
        Some("audio") => Ok(Some("audio")),
        _ => Err(ApiError::invalid(
            "kind/mediaType 仅支持 all、image、video 或 audio",
        )),
    }
}

fn validate_short_filter(value: Option<&str>, max_chars: usize, label: &str) -> Result<Option<String>> {
    let Some(trimmed) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if trimmed.chars().count() > max_chars || trimmed.chars().any(char::is_control) {
        return Err(ApiError::invalid(format!(
            "{label} 须不超过 {max_chars} 字且不含控制字符"
        )));
    }
    Ok(Some(trimmed.to_owned()))
}

fn safe_alias(body: &Value) -> Option<&str> {
    for key in ["image_id", "mediaAlias", "video_id", "videoAlias", "imageId"] {
        if let Some(alias) = body.get(key).and_then(Value::as_str).map(str::trim)
            && !alias.is_empty()
            && alias.len() <= 256
            && !alias.contains(['\0', '/', '\\'])
            && !alias.contains("..")
        {
            return Some(alias);
        }
    }
    None
}

fn detect_media_type(body: &Value, mime: Option<&str>) -> &'static str {
    if let Some(mime) = mime {
        if mime.starts_with("video/") {
            return "video";
        }
        if mime.starts_with("audio/") {
            return "audio";
        }
        if mime.starts_with("image/") {
            return "image";
        }
    }
    for key in ["mediaType", "mediaKind", "type", "kind", "mime", "mimeType"] {
        if let Some(val) = body.get(key).and_then(Value::as_str) {
            let lower = val.trim().to_ascii_lowercase();
            if lower == "video" || lower.starts_with("video/") {
                return "video";
            }
            if lower == "audio" || lower.starts_with("audio/") {
                return "audio";
            }
            if lower == "image" || lower.starts_with("image/") {
                return "image";
            }
        }
    }
    if body
        .get("engine")
        .and_then(Value::as_str)
        .is_some_and(|e| e.eq_ignore_ascii_case("video") || e.to_ascii_lowercase().starts_with("video"))
    {
        return "video";
    }
    if body
        .get("video_id")
        .or_else(|| body.get("videoAlias"))
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
    {
        return "video";
    }
    if safe_alias(body).is_some() {
        "image"
    } else {
        "unknown"
    }
}

fn id_to_string(id: &Value) -> (String, &'static str) {
    match id {
        Value::String(s) => (s.clone(), "string"),
        Value::Number(n) => (n.to_string(), "number"),
        other => (other.to_string(), "string"),
    }
}

fn encode_path_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

fn collect_tags(body: &Value) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for key in ["collectionTags", "manual_tags", "tags"] {
        if let Some(items) = body.get(key).and_then(Value::as_array) {
            for item in items {
                if let Some(text) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    set.insert(text.to_owned());
                }
            }
        }
    }
    set.into_iter().collect()
}

fn truthy_flag(value: &Value) -> bool {
    match value {
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0),
        Value::String(s) => matches!(s.to_ascii_lowercase().as_str(), "true" | "1"),
        _ => false,
    }
}

fn sanitize_artwork(
    record: &Value,
    include_detail: bool,
    media_info: Option<(&str, u64, &str)>,
) -> Value {
    let body = &record["body"];
    let (id_str, id_type) = id_to_string(&record["id"]);
    let has_file = safe_alias(body).is_some();
    let media_type = detect_media_type(body, media_info.map(|(m, _, _)| m));
    let file_url = if has_file {
        let encoded = encode_path_segment(&id_str);
        if id_type == "number" {
            Some(format!("/api/muse/gallery/{encoded}/file?idType=number"))
        } else {
            Some(format!("/api/muse/gallery/{encoded}/file"))
        }
    } else {
        None
    };

    let mut out = Map::new();
    out.insert("id".into(), record["id"].clone());
    out.insert("idText".into(), json!(id_str));
    out.insert("idType".into(), json!(id_type));
    out.insert("mediaType".into(), json!(media_type));
    out.insert("hasFile".into(), json!(has_file));
    out.insert("fileUrl".into(), json!(file_url));
    out.insert("revision".into(), record["revision"].clone());
    out.insert("favorite".into(), json!(truthy_flag(&body["favorite"])));
    out.insert("tags".into(), json!(collect_tags(body)));

    // Strict allow-list of safe metadata fields; never copy arbitrary body keys or local paths.
    for key in [
        "title",
        "scene",
        "sceneTitle",
        "character",
        "characterId",
        "outfitId",
        "blueprintId",
        "project",
        "engine",
        "model",
        "checkpoint",
        "lora",
        "size",
        "width",
        "height",
        "seed",
        "sampler",
        "scheduler",
        "steps",
        "cfg",
        "reviewState",
        "timestamp",
        "duration",
        "fps",
    ] {
        if let Some(value) = body.get(key)
            && (value.is_string() || value.is_number() || value.is_boolean() || value.is_null())
        {
            out.insert(key.into(), value.clone());
        }
    }

    if let Some(prompt) = body.get("prompt").and_then(Value::as_str) {
        if include_detail {
            out.insert("prompt".into(), json!(prompt));
        } else {
            let preview: String = prompt.chars().take(240).collect();
            out.insert("promptPreview".into(), json!(preview));
        }
    }

    if include_detail {
        if let Some(story) = body.get("story").and_then(Value::as_str) {
            out.insert("story".into(), json!(story));
        }
        if let Some(neg) = body
            .get("negative")
            .or_else(|| body.get("negativePrompt"))
            .and_then(Value::as_str)
        {
            out.insert("negative".into(), json!(neg));
        }
        if let Some((mime, bytes, sha256)) = media_info {
            out.insert("mimeType".into(), json!(mime));
            out.insert("bytes".into(), json!(bytes));
            out.insert("sha256".into(), json!(sha256));
            out.insert("partBytes".into(), json!(PART_BYTES));
        } else {
            out.insert("mimeType".into(), Value::Null);
            out.insert("bytes".into(), Value::Null);
            out.insert("sha256".into(), Value::Null);
        }
    }
    Value::Object(out)
}

fn require_storage(state: &AppState) -> Result<Storage> {
    state
        .host
        .storage()
        .ok_or_else(|| ApiError::new(503, "WORKSPACE_UNAVAILABLE", "桌面作品库尚未启用"))
}

async fn gallery_list(
    State(state): State<AppState>,
    Extension(limits): Extension<Arc<OpsLimits>>,
    Query(query): Query<GalleryListQuery>,
) -> Response {
    if let Some(limited) = limits.gallery.check(false) {
        return limited;
    }
    json_response(
        async {
            state.host.check_running()?;
            let storage = require_storage(&state)?;
            let page = query.page.unwrap_or(1);
            let page_size = query.page_size.unwrap_or(20);
            if !(1..=MAX_GALLERY_PAGE).contains(&page) {
                return Err(ApiError::invalid(format!(
                    "page 须在 1 至 {MAX_GALLERY_PAGE} 之间"
                )));
            }
            if !(1..=MAX_GALLERY_PAGE_SIZE).contains(&page_size) {
                return Err(ApiError::invalid(format!(
                    "pageSize 须在 1 至 {MAX_GALLERY_PAGE_SIZE} 之间"
                )));
            }
            let kind_filter =
                parse_media_kind(query.kind.as_deref(), query.media_type.as_deref())?;
            let favorite = parse_optional_bool(query.favorite.as_deref())?;
            let character = validate_short_filter(query.character.as_deref(), 160, "character")?;
            let search = validate_short_filter(query.search.as_deref(), 200, "search")?;
            let tag = validate_short_filter(query.tag.as_deref(), 160, "tag")?;
            let engine = validate_short_filter(query.engine.as_deref(), 80, "engine")?;
            let model = validate_short_filter(query.model.as_deref(), 160, "model")?;
            let review_state =
                validate_short_filter(query.review_state.as_deref(), 40, "reviewState")?;
            if let Some(rs) = review_state.as_deref()
                && !matches!(rs, "candidate" | "preferred" | "rejected")
            {
                return Err(ApiError::invalid(
                    "reviewState 仅支持 candidate、preferred 或 rejected",
                ));
            }

            let mut filter = Map::new();
            if let Some(character) = character {
                filter.insert("characterId".into(), json!(character));
            }
            if let Some(search) = search {
                filter.insert("search".into(), json!(search));
            }
            if let Some(tag) = tag {
                filter.insert("tag".into(), json!(tag));
            }
            if favorite == Some(true) {
                filter.insert("favoriteOnly".into(), json!(true));
            }
            let mut generation = Map::new();
            if let Some(engine) = engine {
                generation.insert("engine".into(), json!(format!("v:{engine}")));
            }
            if let Some(model) = model {
                generation.insert("model".into(), json!(format!("v:{model}")));
            }
            if let Some(rs) = review_state {
                generation.insert("reviewState".into(), json!(format!("v:{rs}")));
            }
            if !generation.is_empty() {
                filter.insert("generation".into(), Value::Object(generation));
            }
            let filter_value = Value::Object(filter);

            let offset = (page - 1) * page_size;
            let need_end = offset + page_size;
            let post_filtered = kind_filter.is_some() || favorite == Some(false);

            let mut cursor: Option<Value> = None;
            let mut matched = 0usize;
            let mut scanned = 0usize;
            let mut collected = Vec::with_capacity(page_size);
            let mut has_more = false;
            let mut total_unfiltered;
            let mut revision;

            loop {
                let batch_limit = if !post_filtered {
                    let remaining = (need_end + 1).saturating_sub(matched);
                    remaining.clamp(1, 200)
                } else {
                    200
                };
                let mut cmd = json!({
                    "kind": "readGalleryPage",
                    "query": filter_value,
                    "limit": batch_limit as i64
                });
                if let Some(c) = cursor.take() {
                    cmd["cursor"] = c;
                }
                let result = storage.request(cmd, READ_PRINCIPAL).await?;
                total_unfiltered = result["total"].as_i64().unwrap_or(0);
                revision = result["revision"].as_i64().unwrap_or(0);
                let items = result["items"].as_array().cloned().unwrap_or_default();
                let next_cursor = result.get("nextCursor").filter(|v| !v.is_null()).cloned();

                for record in items {
                    scanned += 1;
                    let body = &record["body"];
                    if let Some(expected_kind) = kind_filter
                        && detect_media_type(body, None) != expected_kind
                    {
                        continue;
                    }
                    if favorite == Some(false) && truthy_flag(&body["favorite"]) {
                        continue;
                    }
                    if matched >= offset && collected.len() < page_size {
                        collected.push(sanitize_artwork(&record, false, None));
                    } else if matched >= need_end {
                        has_more = true;
                        break;
                    }
                    matched += 1;
                }

                if has_more || next_cursor.is_none() || scanned >= MAX_GALLERY_SCAN_ITEMS {
                    if !has_more && next_cursor.is_some() && collected.len() == page_size {
                        has_more = true;
                    }
                    break;
                }
                cursor = next_cursor;
            }

            let total = if post_filtered {
                Value::Null
            } else {
                json!(total_unfiltered)
            };

            Ok(json!({
                "page": page,
                "pageSize": page_size,
                "total": total,
                "hasMore": has_more,
                "revision": revision,
                "items": collected
            }))
        }
        .await,
    )
}

fn validate_artwork_id_segment(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 256
        || id.contains(['\0', '/', '\\'])
        || id.contains("..")
    {
        return Err(ApiError::invalid("作品编号无效"));
    }
    Ok(())
}

async fn lookup_artwork(
    storage: &Storage,
    id: &str,
    id_type: Option<&str>,
) -> Result<Value> {
    validate_artwork_id_segment(id)?;
    let parse_num = |raw: &str| -> Option<Value> {
        if raw.trim() != raw {
            return None;
        }
        let n: f64 = raw.parse().ok()?;
        if !n.is_finite() {
            return None;
        }
        Some(json!(n))
    };
    let record = match id_type {
        Some("number") => {
            let num = parse_num(id).ok_or_else(|| ApiError::invalid("数字类型作品编号无效"))?;
            storage
                .request(json!({"kind": "getArtwork", "id": num}), READ_PRINCIPAL)
                .await?
        }
        Some("string") => {
            storage
                .request(json!({"kind": "getArtwork", "id": id}), READ_PRINCIPAL)
                .await?
        }
        None => {
            let by_str = storage
                .request(json!({"kind": "getArtwork", "id": id}), READ_PRINCIPAL)
                .await?;
            if !by_str.is_null() {
                by_str
            } else if let Some(num) = parse_num(id) {
                storage
                    .request(json!({"kind": "getArtwork", "id": num}), READ_PRINCIPAL)
                    .await?
            } else {
                Value::Null
            }
        }
        _ => return Err(ApiError::invalid("idType 仅支持 string 或 number")),
    };
    if record.is_null() || !record["deletedAt"].is_null() {
        return Err(ApiError::new(
            404,
            "GALLERY_ITEM_NOT_FOUND",
            "作品不存在或已移入回收站",
        ));
    }
    Ok(record)
}

async fn gallery_item(
    State(state): State<AppState>,
    Extension(limits): Extension<Arc<OpsLimits>>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if let Some(limited) = limits.gallery.check(false) {
        return limited;
    }
    json_response(
        async {
            state.host.check_running()?;
            let storage = require_storage(&state)?;
            let id_type = query.get("idType").map(String::as_str);
            let record = lookup_artwork(&storage, &id, id_type).await?;
            let media = if let Some(alias) = safe_alias(&record["body"]) {
                tokio::time::timeout(Duration::from_secs(10), storage.media(alias))
                    .await
                    .ok()
                    .and_then(|res| res.ok())
            } else {
                None
            };
            let media_info = media
                .as_ref()
                .map(|m| (m.mime.as_str(), m.total_bytes, m.sha256.as_str()));
            let item = sanitize_artwork(&record, true, media_info);
            Ok(json!({"item": item}))
        }
        .await,
    )
}

async fn serve_gallery_part(
    mut file: tokio::fs::File,
    total: u64,
    mime: &str,
    digest: &str,
    part_index: &str,
    count: Option<&String>,
    method: &Method,
    closed: tokio_util::sync::CancellationToken,
    shutdown: tokio_util::sync::CancellationToken,
) -> Result<Response> {
    let start = part_index
        .parse::<u64>()
        .ok()
        .and_then(|index| index.checked_mul(PART_BYTES))
        .filter(|&start| start < total)
        .ok_or_else(|| {
            ApiError::new(
                416,
                "RESULT_PART_INVALID",
                "分片从 0 开始，编号超出作品文件范围",
            )
        })?;
    let count = count
        .map_or(Some(1), |s| s.parse::<u64>().ok())
        .filter(|n| (1..=MAX_PART_COUNT).contains(n))
        .ok_or_else(|| ApiError::invalid("每次可取 1 至 16 片作品分片"))?;
    let size = (total - start).min(PART_BYTES * count) as usize;
    let mut part = vec![0u8; size];
    tokio::select! {
        biased;
        _ = closed.cancelled() => return Err(ApiError::new(503, "MEDIA_CLOSED", "作品媒体已关闭")),
        _ = shutdown.cancelled() => return Err(ApiError::new(499, "CANCELLED", "作品下载已取消")),
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

async fn gallery_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    match async {
        state.host.check_running()?;
        let storage = require_storage(&state)?;
        let id_type = query.get("idType").map(String::as_str);
        let record = lookup_artwork(&storage, &id, id_type).await?;
        let alias = safe_alias(&record["body"]).ok_or_else(|| {
            ApiError::new(
                404,
                "GALLERY_MEDIA_NOT_FOUND",
                "该作品没有可读取的媒体文件",
            )
        })?;
        let source = tokio::time::timeout(Duration::from_secs(30), storage.open_media(alias))
            .await
            .map_err(|_| ApiError::new(504, "WORKSPACE_TIMEOUT", "读取作品媒体超时"))??;
        let total = source.media.total_bytes;
        if total == 0 {
            return Err(ApiError::new(404, "GALLERY_MEDIA_NOT_FOUND", "作品媒体为空"));
        }
        let mime = source.media.mime.clone();
        let digest = source.media.sha256.clone();

        if let Some(part) = query.get("part") {
            if headers.contains_key(header::RANGE) {
                return Err(ApiError::invalid(
                    "分片请求无需 Range；请单独使用 part 或 Range",
                ));
            }
            return serve_gallery_part(
                source.file,
                total,
                &mime,
                &digest,
                part,
                query.get("count"),
                &method,
                source.closed,
                state.shutdown.clone(),
            )
            .await;
        }

        let etag = format!("\"{digest}\"");
        let range_header = headers
            .get(header::RANGE)
            .filter(|_| {
                method == Method::GET
                    && headers
                        .get(header::IF_RANGE)
                        .is_none_or(|value| value.as_bytes() == etag.as_bytes())
            })
            .map(|value| value.to_str().unwrap_or(""));
        let mut response = match http_media::range(range_header, total) {
            Ok(range) => {
                http_media::stream(
                    &method,
                    range,
                    Source::Opened(source.file, source.closed),
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
            HeaderValue::from_str(&total.to_string()).unwrap(),
        );
        out_headers.insert("x-result-sha256", HeaderValue::from_str(&digest).unwrap());
        Ok::<_, ApiError>(response)
    }
    .await
    {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}
