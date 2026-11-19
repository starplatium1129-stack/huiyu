use crate::{
    error::{ApiError, Result},
    storage::Storage,
};
use tokio_util::sync::CancellationToken;

pub(super) const IMAGE_LIMIT: usize = 3 * 1024 * 1024;

pub(super) async fn read_image(
    storage: &Storage,
    alias: &str,
    cancel: &CancellationToken,
) -> Result<(&'static str, Vec<u8>)> {
    let bytes =
        crate::images::read_media(storage.media(alias).await?, 32 * 1024 * 1024, cancel).await?;
    if bytes.len() <= IMAGE_LIMIT {
        match crate::image_decode::sniff(&bytes).map(|(_, extension)| extension) {
            Some("png") => return Ok(("huiyu.png", bytes)),
            Some("jpg") => return Ok(("huiyu.jpg", bytes)),
            _ => {}
        }
    }
    tokio::task::spawn_blocking(move || {
        let mut reader =
            image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format()?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(8192);
        limits.max_image_height = Some(8192);
        limits.max_alloc = Some(160 * 1024 * 1024);
        reader.limits(limits);
        let source = reader
            .decode()
            .map_err(|_| ApiError::invalid("成图无法读取"))?;
        let mut output = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 88)
            .encode_image(&source.thumbnail(1600, 1600).to_rgb8())
            .map_err(|_| ApiError::invalid("成图无法转换"))?;
        if output.len() > IMAGE_LIMIT {
            return Err(ApiError::invalid("成图超出手机回传大小限制"));
        }
        Ok(("huiyu.jpg", output))
    })
    .await
    .map_err(|_| ApiError::invalid("成图转换未完成"))?
}
