use axum::{
    body::{Body, Bytes},
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use image::{
    ImageDecoder, ImageReader,
    codecs::{jpeg::JpegEncoder, webp::WebPEncoder},
    imageops::FilterType,
};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    io::Cursor,
    path::PathBuf,
    sync::{LazyLock, Mutex},
};

const CACHE_BYTES: usize = 24 * 1024 * 1024;
static CACHE: LazyLock<Mutex<VecDeque<(String, Preview)>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
static DECODERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Clone)]
pub(crate) struct Preview {
    pub(crate) bytes: Bytes,
    pub(crate) mime: &'static str,
    width: u32,
}

pub(crate) fn cached(key: String, make: impl FnOnce() -> Option<Preview>) -> Option<Preview> {
    {
        let mut cache = CACHE.lock().ok()?;
        if let Some(index) = cache.iter().position(|(id, _)| *id == key) {
            let hit = cache.remove(index)?;
            let preview = hit.1.clone();
            cache.push_back(hit);
            return Some(preview);
        }
    }
    let preview = make()?;
    let mut cache = CACHE.lock().ok()?;
    cache.retain(|(id, _)| *id != key);
    if preview.bytes.len() <= CACHE_BYTES {
        let mut bytes = cache
            .iter()
            .map(|(_, entry)| entry.bytes.len())
            .sum::<usize>()
            + preview.bytes.len();
        while bytes > CACHE_BYTES {
            bytes -= cache.pop_front()?.1.bytes.len();
        }
        cache.push_back((key, preview.clone()));
    }
    Some(preview)
}

pub(crate) fn resize(bytes: &[u8], max_width: u32, webp: bool) -> Option<Preview> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 32 * 1024 * 1024
    {
        return None;
    }
    if decoder.icc_profile().ok()?.is_some() {
        return None;
    }
    let orientation = decoder.orientation().ok()?;
    let mut image = image::DynamicImage::from_decoder(decoder).ok()?;
    image.apply_orientation(orientation);
    if image.width() > max_width {
        let height = ((u64::from(image.height()) * u64::from(max_width)
            + u64::from(image.width()) / 2)
            / u64::from(image.width()))
        .max(1) as u32;
        image = image.resize_exact(max_width, height, FilterType::Triangle);
    }
    let mut encoded = Vec::new();
    let (width, height) = (image.width(), image.height());
    let mime = if webp || image.color().has_alpha() {
        WebPEncoder::new_lossless(&mut encoded)
            .encode(
                &image.to_rgba8(),
                width,
                height,
                image::ExtendedColorType::Rgba8,
            )
            .ok()?;
        "image/webp"
    } else {
        JpegEncoder::new_with_quality(&mut encoded, 82)
            .encode_image(&image.to_rgb8())
            .ok()?;
        "image/jpeg"
    };
    Some(Preview {
        bytes: encoded.into(),
        mime,
        width,
    })
}

pub(super) async fn serve(
    base: PathBuf,
    file: PathBuf,
    width: u32,
    head: bool,
    condition: Option<HeaderValue>,
) -> Response {
    let permit = match DECODERS.acquire().await {
        Ok(permit) => permit,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let response = tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let _permit = permit;
        let base = base.canonicalize().ok()?;
        let file = file.canonicalize().ok()?;
        if !file.starts_with(base) {
            return None;
        }
        let identity = crate::file_identity::path(&file, false).ok()?;
        let key = format!("showcase/{file:?}/{identity:?}/{width}");
        let image = cached(key.clone(), || {
            let mut bytes = Vec::new();
            std::fs::File::open(&file)
                .ok()?
                .take(32 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            if bytes.len() > 32 * 1024 * 1024
                || crate::file_identity::path(&file, false).ok()? != identity
            {
                return None;
            }
            resize(&bytes, width, false)
        })?;
        let tag = hex::encode(Sha256::digest(key.as_bytes()));
        let length = image.bytes.len();
        let mut response = (
            [
                ("content-type", image.mime),
                ("cache-control", "private, no-cache"),
                (
                    "access-control-expose-headers",
                    "ETag, X-Huiyu-Preview-Width",
                ),
            ],
            image.bytes,
        )
            .into_response();
        response
            .headers_mut()
            .insert("x-huiyu-preview-width", image.width.into());
        if head {
            *response.body_mut() = Body::empty();
            response
                .headers_mut()
                .insert("content-length", length.into());
        }
        Some(super::conditional(response, &tag, condition.as_ref()))
    })
    .await;
    response
        .ok()
        .flatten()
        .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}
