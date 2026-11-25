use super::super::*;
use super::{
    MAX_JSON_BODY_BYTES, MAX_JSON_INPUT_BYTES, MAX_RAW_INPUT_BYTES, MuseVideo, response,
    video_service,
};
use crate::{
    AppState,
    images::{ImageKind, upload_body},
};
use axum::{
    Extension,
    body::{Bytes, to_bytes},
    extract::{ConnectInfo, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, net::SocketAddr};

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

pub(super) async fn upload_input(
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
                let (kind, canonical_kind) = parse_input_kind(
                    parsed
                        .kind
                        .as_deref()
                        .or_else(|| query.get("kind").map(String::as_str)),
                )?;
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
