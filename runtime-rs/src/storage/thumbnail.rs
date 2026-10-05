mod queue;
pub(super) use queue::Readers;

use super::{Storage, schema, string};
use crate::error::{ApiError, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{
    DynamicImage, ImageDecoder, ImageReader, Rgb, RgbImage, codecs::jpeg::JpegEncoder,
    imageops::FilterType,
};
use serde_json::Value;
use std::{fs, io::Write, path::Path, sync::OnceLock};

static DECODERS: OnceLock<queue::Queue> = OnceLock::new();

pub(super) async fn read(storage: &Storage, command: &Value) -> Result<Value> {
    let (reader, cancelled) = storage.thumbnails.begin()?;
    let _cancel = cancelled.clone().drop_guard();
    let source = match tokio::select! { biased;
        _ = cancelled.cancelled() => return Err(super::unavailable()),
        source = storage.media(string(command, "alias")?) => source,
    } {
        Ok(source) => source,
        Err(error) if error.status.as_u16() == 404 => return Ok(Value::Null),
        Err(error) => return Err(error),
    };
    if !source.mime.starts_with("image/") {
        return Ok(Value::Null);
    }
    let root = storage.root.clone();
    // Different encoders/resampling must never share sharp's thumbnails-v1 cache.
    let native = storage.native_images.clone();
    let version = if native.is_some() {
        "thumbnails-rust-vips-v1"
    } else {
        "thumbnails-rust-v1"
    };
    let relative = format!("cache/{version}/{}.jpg", source.sha256);
    let cache = schema::safe(&root, Path::new(&relative))?;
    match tokio::fs::read(&cache).await {
        Ok(bytes) => return Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)).into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let queue = DECODERS.get_or_init(queue::Queue::new);
    // Coalesce the same workspace/hash/cache-version before taking a decoder
    // slot. Otherwise two windows can both miss the cache and decode it twice.
    let image_guard = tokio::select! { biased;
        _ = cancelled.cancelled() => return Err(super::unavailable()),
        guard = queue.image(cache.clone()) => guard,
    };
    match tokio::fs::read(&cache).await {
        Ok(bytes) => return Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)).into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let permit = tokio::select! { biased;
        _ = cancelled.cancelled() => return Err(super::unavailable()),
        permit = queue.decoder() => permit?,
    };
    let owner = storage.sender.clone();
    #[cfg(test)]
    let readers = storage.thumbnails.clone();
    tokio::task::spawn_blocking(move || {
        let (_permit, _reader, _owner) = (permit, reader, owner);
        // Cancellation drops the awaiting future, not a running blocking
        // decoder. Keep the image lock until that worker really finishes.
        let _image_guard = image_guard;
        #[cfg(test)]
        readers.paused();
        if cancelled.is_cancelled() {
            return Ok(Value::Null);
        }
        let encoded = if let Some(library) = native {
            crate::native_images::thumbnail(&source.path, &library, &cancelled)
                .map_err(|error| ApiError::new(422, "THUMBNAIL_FAILED", error))?
        } else {
            encode(&source.path)?
        };
        let Some(bytes) = encoded else {
            return Ok(Value::Null);
        };
        if cancelled.is_cancelled() {
            return Ok(Value::Null);
        }
        let parent = cache.parent().expect("cache has a parent");
        fs::create_dir_all(parent)?;
        schema::safe(&root, Path::new(&relative))?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&bytes)?;
        // Temp ownership also reclaims a partially written thumbnail on error.
        if let Err(error) = temporary.persist(&cache)
            && !cache.is_file()
        {
            return Err(error.error.into());
        }
        Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)).into())
    })
    .await
    .map_err(|_| ApiError::new(503, "THUMBNAIL_FAILED", "Thumbnail worker failed"))?
}

fn encode(path: &Path) -> Result<Option<Vec<u8>>> {
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
    let width = decoded.width().min(560);
    let height = ((f64::from(decoded.height()) * f64::from(width) / f64::from(decoded.width()))
        .round() as u32)
        .max(1);
    let resized = decoded
        .resize_exact(width, height, FilterType::Lanczos3)
        .to_rgba8();
    let mut rgb = RgbImage::new(width, height);
    for (input, output) in resized.pixels().zip(rgb.pixels_mut()) {
        let alpha = u16::from(input[3]);
        *output = Rgb([
            ((u16::from(input[0]) * alpha + 127) / 255) as u8,
            ((u16::from(input[1]) * alpha + 127) / 255) as u8,
            ((u16::from(input[2]) * alpha + 127) / 255) as u8,
        ]);
    }
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 82)
        .encode_image(&rgb)
        .map_err(decode_error)?;
    Ok(Some(bytes))
}

fn decode_error(_: image::ImageError) -> ApiError {
    ApiError::new(422, "MEDIA_INVALID", "Image cannot be decoded")
}
