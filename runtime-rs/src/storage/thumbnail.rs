mod queue;

use super::{Storage, schema, string};
use crate::error::{ApiError, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{
    DynamicImage, ImageDecoder, ImageReader, Rgb, RgbImage, codecs::jpeg::JpegEncoder,
    imageops::FilterType,
};
use serde_json::Value;
use std::{fs, path::Path, sync::OnceLock};
use tokio_util::sync::CancellationToken;

static DECODERS: OnceLock<queue::Queue> = OnceLock::new();
struct Cancel(CancellationToken);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub(super) async fn read(storage: &Storage, command: &Value) -> Result<Value> {
    let source = match storage.media(string(command, "alias")?).await {
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
    let image_guard = queue.image(cache.clone()).await;
    match tokio::fs::read(&cache).await {
        Ok(bytes) => return Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)).into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let permit = queue.decoder().await?;
    let cancel = Cancel(CancellationToken::new());
    let cancelled = cancel.0.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        // Cancellation drops the awaiting future, not a running blocking
        // decoder. Keep the image lock until that worker really finishes.
        let _image_guard = image_guard;
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
        let temporary = parent.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temporary, &bytes)?;
        // A competing decoder may have already published identical derived work.
        if let Err(error) = fs::rename(&temporary, &cache)
            && !cache.is_file()
        {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        let _ = fs::remove_file(&temporary);
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
