use super::*;

pub(super) fn conservative(input: &mut Value) -> Option<()> {
    if input["modelId"] != "wan2.2-i2v-a14b-gguf" || input["wanMemoryTier"] == "conservative" {
        return None;
    }
    let (width, height) = (input["width"].as_u64()?, input["height"].as_u64()?);
    let short = width.min(height);
    if short == 0 {
        return None;
    }
    let (width, height) = if short > 480 {
        // Preserve orientation and the accepted aspect ratio, aligned to Wan's 16-pixel grid.
        let scale = |size: u64| ((size * 480 + 8 * short) / (16 * short)).max(1) * 16;
        (scale(width), scale(height))
    } else {
        (width, height)
    };
    input["wanMemoryTier"] = json!("conservative");
    input["width"] = json!(width);
    input["height"] = json!(height);
    Some(())
}

pub(super) fn preview(event: &Value) -> Option<String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let url = event["previewDataUrl"].as_str()?;
    let encoded = url.strip_prefix("data:image/jpeg;base64,")?;
    if encoded.len() > 128 * 1024 {
        return None;
    }
    let data = STANDARD.decode(encoded).ok()?;
    let (width, height) =
        image::ImageReader::with_format(std::io::Cursor::new(data), image::ImageFormat::Jpeg)
            .into_dimensions()
            .ok()?;
    ((1..=384).contains(&width) && (1..=384).contains(&height)).then(|| url.into())
}
