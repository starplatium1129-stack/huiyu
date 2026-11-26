mod parser;
mod prompts;

use crate::AppState;
use axum::body::Bytes;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{ImageDecoder, ImageReader, codecs::jpeg::JpegEncoder, imageops::FilterType};
use serde_json::{Value, json};
use std::{io::Cursor, sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

pub(super) const GUARD_MIN: f64 = 0.20;
const CAPTION_TIMEOUT_SECS: u64 = 25;
pub(super) const LAYOUT_TIMEOUT_SECS: u64 = 35;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SubjectMode {
    Free,
    Bound,
}

impl SubjectMode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Bound => "bound",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Options {
    pub(super) subject_mode: SubjectMode,
    pub(super) layout: bool,
}

pub(super) struct Evidence {
    minor_nsfw: bool,
    anchors: Value,
}

impl Evidence {
    pub(super) fn from_pixai(result: &Value, options: Options) -> Self {
        Self {
            minor_nsfw: prompts::has_minor_nsfw(result),
            anchors: prompts::anchors(result, options.subject_mode),
        }
    }
}

type Original = (Bytes, Arc<OwnedSemaphorePermit>);

pub(super) async fn enrich(
    app: &AppState,
    route: Option<crate::chat::VisionRoute>,
    decoder_slots: Arc<Semaphore>,
    original: Original,
    evidence: Evidence,
    options: Options,
    parent: &CancellationToken,
    result: &mut Value,
) {
    let cancel = parent.child_token();
    let _guard = cancel.clone().drop_guard();
    let work = async {
        let chat = app.chat.as_ref().ok_or(Fallback::Unavailable)?;
        let route = route.ok_or(Fallback::Unavailable)?;
        let provider = route.provider();
        if provider == "chatgpt" && evidence.minor_nsfw {
            return Err(Fallback::MinorNsfw);
        }
        let model = route.model().to_owned();
        let permit = decoder_slots
            .acquire_owned()
            .await
            .map_err(|_| Fallback::Image)?;
        let worker_cancel = cancel.clone();
        let data = tokio::task::spawn_blocking(move || {
            let _decode = permit;
            let (image, _upload) = original;
            if worker_cancel.is_cancelled() {
                return Err(Fallback::Image);
            }
            jpeg_data(&image)
        })
        .await
        .map_err(|_| Fallback::Image)??;
        let content = chat
            .vision_complete(
                app,
                route,
                prompts::messages(evidence.anchors, data, options),
                &cancel,
            )
            .await
            .map_err(|error| match (error.status.as_u16(), error.code.as_str()) {
                (_, "VISION_REFUSAL") => Fallback::Refused,
                (400 | 413 | 415 | 422, _) => Fallback::Unsupported,
                (408 | 504, _) => Fallback::Timeout,
                _ => Fallback::Upstream,
            })?;
        let parsed = parser::parse_response(&content, options).ok_or(Fallback::InvalidCaption)?;
        Ok((parsed, provider, model))
    };
    let timeout = Duration::from_secs(if options.layout {
        LAYOUT_TIMEOUT_SECS
    } else {
        CAPTION_TIMEOUT_SECS
    });
    let outcome = tokio::select! {
        biased;
        _ = cancel.cancelled() => return,
        value = tokio::time::timeout(timeout, work) => value.unwrap_or(Err(Fallback::Timeout)),
    };
    match outcome {
        Ok((parsed, provider, model)) => {
            result["caption"] = json!(parsed.caption);
            result.as_object_mut().unwrap().remove("captionDerived");
            result["assistUsed"] = json!(true);
            result["assistProvider"] = json!(provider);
            result["assistModel"] = json!(model);
            result["assistSubjectMode"] = json!(options.subject_mode.as_str());
            if let Some(layout) = parsed.layout {
                result["assistLayout"] = json!(layout);
            }
        }
        Err(fallback) => {
            let (reason, warning) = fallback.details();
            result["assistFallbackReason"] = json!(reason);
            result["warning"] = json!(warning);
        }
    }
}

enum Fallback {
    Unavailable,
    MinorNsfw,
    Image,
    Refused,
    Unsupported,
    Timeout,
    Upstream,
    InvalidCaption,
}

impl Fallback {
    fn details(&self) -> (&'static str, &'static str) {
        match self {
            Self::Unavailable => (
                "unavailable",
                "未配置可用的视觉协同通道，已保留本地 PixAI 结果",
            ),
            Self::MinorNsfw => (
                "minor_nsfw",
                "检测到疑似未成年相关 NSFW 特征，图片未发送给 ChatGPT，已使用本地 PixAI",
            ),
            Self::Image => (
                "image_encoding",
                "图片暂时无法转换为协同格式，已保留本地 PixAI 结果",
            ),
            Self::Refused => (
                "upstream_refusal",
                "视觉服务未接受这张图的描述请求，已保留本地 PixAI 结果",
            ),
            Self::Unsupported => (
                "unsupported_request",
                "视觉服务不接受本次图片请求，已保留本地 PixAI 结果",
            ),
            Self::Timeout => ("timeout", "视觉协同等待超时，已保留本地 PixAI 结果"),
            Self::Upstream => ("upstream_error", "视觉服务暂不可用，已保留本地 PixAI 结果"),
            Self::InvalidCaption => (
                "invalid_caption",
                "视觉服务未返回可用的画面描述，已保留本地 PixAI 结果",
            ),
        }
    }
}

fn jpeg_data(bytes: &[u8]) -> Result<String, Fallback> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| Fallback::Image)?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| Fallback::Image)?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 32 * 1024 * 1024 {
        return Err(Fallback::Image);
    }
    let orientation = decoder.orientation().map_err(|_| Fallback::Image)?;
    let mut frame = image::DynamicImage::from_decoder(decoder).map_err(|_| Fallback::Image)?;
    frame.apply_orientation(orientation);
    if frame.width().max(frame.height()) > 1024 {
        frame = frame.resize(1024, 1024, FilterType::Triangle);
    }
    // Match PixAI's white background for transparent pixels before JPEG encoding.
    let rgb = if frame.color().has_alpha() {
        let rgba = frame.into_rgba8();
        image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
            let [r, g, b, alpha] = rgba.get_pixel(x, y).0;
            let alpha = u16::from(alpha);
            image::Rgb([r, g, b].map(|channel| {
                ((u16::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
            }))
        })
    } else {
        frame.into_rgb8()
    };
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 85)
        .encode_image(&rgb)
        .map_err(|_| Fallback::Image)?;
    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg)))
}
