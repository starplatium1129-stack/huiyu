use crate::error::{ApiError, Result};
use image::{ImageDecoder, ImageReader};
use std::{io::Cursor, sync::Arc};
use tokio_util::sync::CancellationToken;
static DECODERS: std::sync::LazyLock<Arc<tokio::sync::Semaphore>> =
    std::sync::LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(2)));
pub(crate) fn sniff(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(("image/webp", "webp"))
    } else {
        None
    }
}
fn invalid() -> ApiError {
    ApiError::new(
        400,
        "INVALID_IMAGE",
        "图片损坏、动画或超出解码预算（8192 边长、32M 像素、单帧）",
    )
}
fn cancelled() -> ApiError {
    ApiError::new(499, "CANCELLED", "图像操作已取消")
}
pub(crate) async fn validate(bytes: Arc<Vec<u8>>, cancel: &CancellationToken) -> Result<()> {
    let permit = DECODERS
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new(503, "IMAGE_STORAGE_BUSY", "图像解码资源繁忙"))?;
    let worker_cancel = cancel.clone();
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if worker_cancel.is_cancelled() {
            return Err(cancelled());
        }
        let format = sniff(&bytes).ok_or_else(invalid)?.1;
        if format == "png" {
            let mut at = 8usize;
            while at + 12 <= bytes.len() {
                let size = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
                if size
                    .checked_add(at + 12)
                    .is_none_or(|end| end > bytes.len())
                    || bytes.get(at + 4..at + 8) == Some(b"acTL")
                {
                    return Err(invalid());
                }
                at += 12 + size;
            }
        }
        if format == "webp"
            && image::codecs::webp::WebPDecoder::new(Cursor::new(bytes.as_slice()))
                .map_err(|_| invalid())?
                .has_animation()
        {
            return Err(invalid());
        }
        let mut reader = ImageReader::new(Cursor::new(bytes.as_slice()))
            .with_guessed_format()
            .map_err(|_| invalid())?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(8192);
        limits.max_image_height = Some(8192);
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        let decoder = reader.into_decoder().map_err(|_| invalid())?;
        let (w, h) = decoder.dimensions();
        if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 32 * 1024 * 1024 {
            return Err(invalid());
        }
        // Full compressed-data decode, bounded by dimensions and allocation limits.
        // The request deadline can abandon this bounded CPU work, never publish it.
        image::DynamicImage::from_decoder(decoder).map_err(|_| invalid())?;
        if worker_cancel.is_cancelled() {
            return Err(cancelled());
        }
        Ok(())
    });
    tokio::select! {result=tokio::time::timeout(std::time::Duration::from_secs(5),work)=>result.map_err(|_|invalid())?.map_err(|_|invalid())?,_=cancel.cancelled()=>Err(cancelled())}
}
