mod queue;

use super::{Storage, schema, string};
use crate::error::{ApiError, Result};
use axum::body::Bytes;
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{
    DynamicImage, ImageDecoder, ImageReader, Rgb, RgbImage,
    codecs::{jpeg::JpegEncoder, webp::WebPEncoder},
    imageops::FilterType,
};
use serde_json::Value;
use std::{collections::VecDeque, fs, io::Write, path::Path, sync::{Mutex, OnceLock}};

static DECODERS: OnceLock<queue::Queue> = OnceLock::new();

#[derive(Clone)]
pub(crate) struct Derivative {
    pub(crate) bytes: Bytes,
    pub(crate) mime: &'static str,
}

pub(crate) struct DerivativeResponse {
    pub(crate) etag: String,
    pub(crate) immutable: bool,
    pub(crate) image: Option<Derivative>,
}

#[derive(Default)]
pub(super) struct Cache(Mutex<VecDeque<(String, Derivative)>>);

impl Cache {
    const MAX_BYTES: usize = 24 * 1024 * 1024;
    const MAX_ENTRIES: usize = 128;

    fn get(&self, key: &str) -> Option<Derivative> {
        let mut entries = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let index = entries.iter().position(|(entry_key, _)| entry_key == key)?;
        let entry = entries.remove(index)?;
        let value = entry.1.clone();
        entries.push_back(entry);
        Some(value)
    }

    fn put(&self, key: String, value: Derivative) {
        if value.bytes.len() > Self::MAX_BYTES { return; }
        let mut entries = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        entries.retain(|(entry_key, _)| entry_key != &key);
        let mut total = value.bytes.len() + entries.iter().map(|(_, entry)| entry.bytes.len()).sum::<usize>();
        while entries.len() >= Self::MAX_ENTRIES || total > Self::MAX_BYTES {
            let Some((_, old)) = entries.pop_front() else { break };
            total -= old.bytes.len();
        }
        entries.push_back((key, value));
    }

    pub(super) fn forget(&self, source_hash: &str) {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|(key, _)| !key.rsplit_once('/').is_some_and(|(_, file)| file.starts_with(source_hash)));
    }
}

pub(super) async fn read(storage: &Storage, command: &Value) -> Result<Value> {
    let requested = command
        .get("width")
        .map(|value| value.as_u64().ok_or_else(invalid_width))
        .transpose()?;
    Ok(read_binary(storage, string(command, "alias")?, requested, None, |_| false).await?
        .and_then(|result| result.image)
        .map_or(Value::Null, |image| thumbnail_value(&image.bytes, image.mime)))
}

fn invalid_width() -> ApiError {
    ApiError::new(400, "INVALID_WIDTH", "Preview width must be 1–8192")
}

pub(super) async fn read_binary(
    storage: &Storage,
    alias: &str,
    requested: Option<u64>,
    version_hash: Option<&str>,
    matches_tag: impl FnOnce(&str) -> bool,
) -> Result<Option<DerivativeResponse>> {
    let preview = requested.is_some();
    let requested = requested.unwrap_or(560);
    if !(1..=8192).contains(&requested) { return Err(invalid_width()); }
    let width = [560, 1120, 1680, 2240, 3360, 4480, 8192]
        .into_iter()
        .find(|width| u64::from(*width) >= requested)
        .unwrap_or(8192);
    let (reader, cancelled) = storage.thumbnails.begin()?;
    let _cancel = cancelled.clone().drop_guard();
    let source = match tokio::select! { biased;
        _ = cancelled.cancelled() => return Err(super::unavailable()),
        source = storage.lookup_media(alias) => source,
    } {
        Ok(source) => source,
        Err(error) if error.status.as_u16() == 404 => return Ok(None),
        Err(error) => return Err(error),
    };
    if version_hash.is_some_and(|hash| hash != source.sha256) || !source.mime.starts_with("image/") {
        return Ok(None);
    }
    // Unsupported preview codecs must leave the browser's original fallback in
    // charge instead of publishing a derivative with different image semantics.
    if preview
        && !matches!(
            source.mime.as_str(),
            "image/png" | "image/jpeg" | "image/webp"
        )
    {
        return Ok(None);
    }
    // Different encoders/resampling must never share sharp's thumbnails-v1 cache.
    let native = storage.native_images.clone();
    let (version, extension) = match (native.is_some(), preview) {
        (true, true) => ("previews-rust-vips-v1", "webp"),
        (false, true) => ("previews-rust-v2", "img"),
        (true, false) => ("thumbnails-rust-vips-v1", "jpg"),
        (false, false) => ("thumbnails-rust-v2", "jpg"),
    };
    let etag = format!("W/\"{version}-{}-{width}\"", source.sha256);
    let immutable = version_hash.is_some();
    if matches_tag(&etag) {
        return Ok(Some(DerivativeResponse { etag, immutable, image: None }));
    }
    let root = storage.root.clone();
    let source = match tokio::select! { biased;
        _ = cancelled.cancelled() => return Err(super::unavailable()),
        verified = storage.verification.verify(root.clone(), source, storage.sender.clone()) => verified,
    } {
        Ok(verified) => verified.media,
        Err(error) if error.status.as_u16() == 404 => return Ok(None),
        Err(error) => return Err(error),
    };
    let response = move |image| DerivativeResponse { etag, immutable, image: Some(image) };
    let suffix = if width == 560 {
        String::new()
    } else {
        format!("-{width}")
    };
    let relative = format!("cache/{version}/{}{suffix}.{extension}", source.sha256);
    let memory = storage.derivatives.clone();
    if let Some(value) = memory.get(&relative) { return Ok(Some(response(value))); }
    let owner = storage.sender.clone();
    let (cache_root, cache_relative, read_cancel) =
        (root.clone(), relative.clone(), cancelled.clone());
    let (cache, cached, reader, owner) = tokio::task::spawn_blocking(move || {
        // Warm reads still validate every ancestor. Keep their lifetime with
        // the worker too, so close drains an abandoned filesystem read.
        if read_cancel.is_cancelled() {
            return Err(super::unavailable());
        }
        let cache = schema::safe(&cache_root, Path::new(&cache_relative))?;
        let cached = read_cached(&cache)?;
        if read_cancel.is_cancelled() {
            return Err(super::unavailable());
        }
        Ok::<_, ApiError>((cache, cached, reader, owner))
    })
    .await
    .map_err(|_| worker_failed())??;
    if let Some(value) = cached {
        memory.put(relative, value.clone());
        return Ok(Some(response(value)));
    }
    let queue = DECODERS.get_or_init(queue::Queue::new);
    // Coalesce the same workspace/hash/cache-version before taking a decoder
    // slot. Otherwise two windows can both miss the cache and decode it twice.
    let image_guard = tokio::select! { biased;
        _ = cancelled.cancelled() => return Err(super::unavailable()),
        guard = queue.image(cache.clone()) => guard,
    };
    if let Some(value) = memory.get(&relative) { return Ok(Some(response(value))); }
    let (cache_path, read_cancel) = (cache.clone(), cancelled.clone());
    let (cached, image_guard, reader, owner) = tokio::task::spawn_blocking(move || {
        if read_cancel.is_cancelled() {
            return Err(super::unavailable());
        }
        let cached = read_cached(&cache_path)?;
        if read_cancel.is_cancelled() {
            return Err(super::unavailable());
        }
        Ok::<_, ApiError>((cached, image_guard, reader, owner))
    })
    .await
    .map_err(|_| worker_failed())??;
    if let Some(value) = cached {
        memory.put(relative, value.clone());
        return Ok(Some(response(value)));
    }
    let permit = tokio::select! { biased;
        _ = cancelled.cancelled() => return Err(super::unavailable()),
        permit = queue.decoder() => permit?,
    };

    tokio::task::spawn_blocking(move || {
        let (_permit, _reader, _owner) = (permit, reader, owner);
        // Cancellation drops the awaiting future, not a running blocking
        // decoder. Keep the image lock until that worker really finishes.
        let _image_guard = image_guard;

        if cancelled.is_cancelled() {
            return Ok(None);
        }
        let encoded = if let Some(library) = native {
            crate::native_images::thumbnail(&source.path, &library, width, preview, &cancelled)
                .map_err(|error| ApiError::new(422, "THUMBNAIL_FAILED", error))?
        } else {
            encode(&source.path, width, preview)?.map(Bytes::from)
        };
        let Some(bytes) = encoded else {
            return Ok(None);
        };
        if cancelled.is_cancelled() {
            return Ok(None);
        }
        let Some(value) = derivative(bytes) else { return Err(worker_failed()); };
        let parent = cache.parent().expect("cache has a parent");
        fs::create_dir_all(parent)?;
        schema::safe(&root, Path::new(&relative))?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&value.bytes)?;
        // Temp ownership also reclaims a partially written thumbnail on error.
        if let Err(error) = temporary.persist(&cache)
            && !cache.is_file()
        {
            return Err(error.error.into());
        }
        memory.put(relative, value.clone());
        Ok(Some(value))
    })
    .await
    .map_err(|_| worker_failed())?
    .map(|image| image.map(response))
}

fn derivative(bytes: Bytes) -> Option<Derivative> {
    let mime = super::media::detected_mime(&bytes)?;
    matches!(mime, "image/jpeg" | "image/webp").then_some(Derivative { bytes, mime })
}

fn read_cached(cache: &Path) -> Result<Option<Derivative>> {
    match fs::read(cache) {
        Ok(bytes) => Ok(derivative(bytes.into())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn thumbnail_value(bytes: &[u8], mime: &str) -> Value {
    let prefix = format!("data:{mime};base64,");
    let mut uri = String::with_capacity(
        prefix.len() + base64::encoded_len(bytes.len(), true).expect("thumbnail is too large"),
    );
    uri.push_str(&prefix);
    STANDARD.encode_string(bytes, &mut uri);
    Value::String(uri)
}

fn worker_failed() -> ApiError {
    ApiError::new(503, "THUMBNAIL_FAILED", "Thumbnail worker failed")
}

fn encode(path: &Path, max_width: u32, preserve_alpha: bool) -> Result<Option<Vec<u8>>> {
    let reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut decoder = match reader.into_decoder() {
        Ok(decoder) => decoder,
        Err(image::ImageError::Unsupported(_)) => return Ok(None),
        Err(error) => return Err(decode_error(error)),
    };
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 32 * 1024 * 1024
    {
        return Ok(None);
    }
    // Full ICC/AVIF equivalence belongs to the media migration. Preserve the
    // original fallback instead of publishing a thumbnail with incorrect colors.
    if decoder.icc_profile().map_err(decode_error)?.is_some() {
        return Ok(None);
    }
    let orientation = decoder.orientation().map_err(decode_error)?;
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    decoded.apply_orientation(orientation);
    let width = decoded.width().min(max_width);
    let height = ((f64::from(decoded.height()) * f64::from(width) / f64::from(decoded.width()))
        .round() as u32)
        .max(1);
    let resized = if width == decoded.width() {
        decoded
    } else {
        decoded.resize_exact(width, height, FilterType::Triangle)
    };
    let mut bytes = Vec::new();
    let rgb = if resized.color().has_alpha() {
        let rgba = resized.into_rgba8();
        if preserve_alpha && rgba.pixels().any(|pixel| pixel[3] != u8::MAX) {
            WebPEncoder::new_lossless(&mut bytes)
                .encode(&rgba, width, height, image::ExtendedColorType::Rgba8)
                .map_err(decode_error)?;
            return Ok(Some(bytes));
        }
        RgbImage::from_fn(width, height, |x, y| {
            let pixel = rgba.get_pixel(x, y);
            let alpha = u16::from(pixel[3]);
            Rgb([pixel[0], pixel[1], pixel[2]].map(|value| ((u16::from(value) * alpha + 127) / 255) as u8))
        })
    } else {
        resized.into_rgb8()
    };
    JpegEncoder::new_with_quality(&mut bytes, 82)
        .encode_image(&rgb)
        .map_err(decode_error)?;
    Ok(Some(bytes))
}

fn decode_error(_: image::ImageError) -> ApiError {
    ApiError::new(422, "MEDIA_INVALID", "Image cannot be decoded")
}
