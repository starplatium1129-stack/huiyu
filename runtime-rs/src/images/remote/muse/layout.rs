use super::*;

fn invalid_layout() -> ApiError {
    ApiError::new(
        503,
        "SCENE_LAYOUT_INVALID",
        "目录配方的 MOSS 布局或原始画幅无效，请重新打包远程资料",
    )
}

/// Only the catalog owns the source canvas. Custom prompts and saved jobs bypass this step.
pub(super) fn resize_catalog_prompt(payload: &mut Value, width: u64, height: u64) -> Result<()> {
    let prompt = payload["prompt"].as_str().ok_or_else(invalid_layout)?;
    if !prompt.trim_start().starts_with('{') {
        return Ok(());
    }
    let mut layout: Value = serde_json::from_str(prompt).map_err(|_| invalid_layout())?;
    if layout["bbox_coord_space"] != "abs_centralized" || layout["bbox_format"] != "yxyx" {
        return Err(invalid_layout());
    }
    let source_width = payload["width"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(invalid_layout)?;
    let source_height = payload["height"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(invalid_layout)?;
    let items = layout["items"]
        .as_array_mut()
        .filter(|items| !items.is_empty())
        .ok_or_else(invalid_layout)?;
    let changed = (width, height) != (source_width, source_height);
    for item in items {
        let [top, left, bottom, right]: [f64; 4] =
            serde_json::from_value(item["bbox"].clone()).map_err(|_| invalid_layout())?;
        let (x0, x1) = scale_interval(left, right, source_width, width)?;
        let (y0, y1) = scale_interval(top, bottom, source_height, height)?;
        if width != source_width {
            item["bbox"][1] = json!(x0);
            item["bbox"][3] = json!(x1);
        }
        if height != source_height {
            item["bbox"][0] = json!(y0);
            item["bbox"][2] = json!(y1);
        }
    }
    if changed {
        payload["prompt"] = json!(serde_json::to_string_pretty(&layout)?);
    }
    Ok(())
}

fn scale_interval(start: f64, end: f64, from: u64, to: u64) -> Result<(i64, i64)> {
    let source = from as f64;
    if !(start >= -source / 2. && start < end && end <= source / 2.) {
        return Err(invalid_layout());
    }
    let target = to as f64;
    // Round outwards so even subpixel features retain positive area at smaller sizes.
    let low = (start * target / source).floor();
    let high = (end * target / source).ceil();
    if !(low >= -target / 2. && low < high && high <= target / 2.) {
        return Err(ApiError::invalid(
            "目标画幅无法容纳目录中的 MOSS 元素框，请检查宽高",
        ));
    }
    Ok((low as i64, high as i64))
}
