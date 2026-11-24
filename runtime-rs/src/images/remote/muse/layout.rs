use super::*;

const MAX_LAYOUT_ITEMS: usize = 16;
const MAX_ITEM_CAPTION_CHARS: usize = 2000;
const MAX_ITEM_TEXT_CHARS: usize = 600;
const MAX_PROMPT_UTF16: usize = 12_000;

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

fn strip_json_fence(source: &str) -> Option<&str> {
    let trimmed = source.trim();
    if trimmed.starts_with('{') {
        return Some(trimmed);
    }
    let rest = trimmed.strip_prefix("```")?;
    let body = if let Some(after) = rest.strip_prefix("json").or_else(|| rest.strip_prefix("JSON"))
    {
        after
    } else {
        rest
    };
    let body = body.trim_start();
    if !body.starts_with('{') {
        return None;
    }
    let inner = body.strip_suffix("```")?.trim();
    inner.starts_with('{').then_some(inner)
}

/// Validates and compiles custom MOSS prompts (plain text, JSON layout string, or explicit `layout` object).
/// Supports:
/// 1. Native `abs_centralized` + `yxyx` (validates pixel bounds against target canvas).
/// 2. Pixel draft `abs` + `xyxy` (converts to `abs_centralized` / `yxyx`).
/// 3. Normalized `0..=1` (including `assistLayout` output from `/api/muse/interrogate`) or `rel_1000` (`0..=1000`),
///    automatically converted to target canvas `abs_centralized` / `yxyx` integer pixel boxes.
pub(super) fn compile_custom_prompt(
    prompt: Option<&str>,
    layout: Option<&Value>,
    width: u64,
    height: u64,
) -> Result<String> {
    if let Some(layout_value) = layout {
        return compile_layout_value(layout_value, prompt, width, height);
    }
    let prompt_text = prompt
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| ApiError::invalid("请输入 prompt 或有效的 MOSS layout 布局对象"))?;
    let Some(json_source) = strip_json_fence(prompt_text) else {
        return Ok(prompt_text.to_owned());
    };
    let parsed: Value = serde_json::from_str(json_source).map_err(|_| {
        ApiError::invalid("MOSS 布局 JSON 无法解析，请检查引号、逗号和括号")
    })?;
    compile_layout_value(&parsed, None, width, height)
}

enum CoordMode {
    CenteredYxyx,
    AbsXyxy,
    NormalizedYxyx,
    NormalizedXyxy,
    Rel1000Yxyx,
    Rel1000Xyxy,
}

fn coord_mode(object: &serde_json::Map<String, Value>) -> Result<CoordMode> {
    let space = object.get("bbox_coord_space").and_then(Value::as_str);
    let format = object.get("bbox_format").and_then(Value::as_str);
    if object.get("bbox_coord_space").is_some_and(|v| !v.is_string())
        || object.get("bbox_format").is_some_and(|v| !v.is_string())
    {
        return Err(ApiError::invalid(
            "bbox_coord_space 和 bbox_format 必须是字符串",
        ));
    }
    match (space, format) {
        (Some("abs_centralized"), Some("yxyx")) => Ok(CoordMode::CenteredYxyx),
        (Some("abs"), Some("xyxy")) => Ok(CoordMode::AbsXyxy),
        (None | Some("normalized" | "rel_0_1"), None | Some("yxyx")) => {
            Ok(CoordMode::NormalizedYxyx)
        }
        (Some("normalized" | "rel_0_1"), Some("xyxy")) => Ok(CoordMode::NormalizedXyxy),
        (Some("rel_1000"), None | Some("yxyx")) => Ok(CoordMode::Rel1000Yxyx),
        (Some("rel_1000"), Some("xyxy")) => Ok(CoordMode::Rel1000Xyxy),
        _ => Err(ApiError::invalid(
            "MOSS 布局坐标支持 abs_centralized/yxyx、abs/xyxy、normalized(0..1)/yxyx(或xyxy) 或 rel_1000/yxyx(或xyxy)",
        )),
    }
}

fn compile_layout_value(
    value: &Value,
    fallback_caption: Option<&str>,
    width: u64,
    height: u64,
) -> Result<String> {
    let object = value
        .as_object()
        .ok_or_else(|| ApiError::invalid("MOSS 布局必须是 JSON 对象"))?;
    let mode = coord_mode(object)?;

    if matches!(mode, CoordMode::AbsXyxy) {
        if let Some(draft_w) = object.get("width")
            && draft_w.as_u64() != Some(width)
        {
            return Err(ApiError::invalid(format!(
                "MOSS 像素草稿 width 与目标画幅 {width}×{height} 不一致"
            )));
        }
        if let Some(draft_h) = object.get("height")
            && draft_h.as_u64() != Some(height)
        {
            return Err(ApiError::invalid(format!(
                "MOSS 像素草稿 height 与目标画幅 {width}×{height} 不一致"
            )));
        }
    }

    let summary_obj = match object.get("summary") {
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) => Some(map),
        Some(_) => return Err(ApiError::invalid("MOSS 布局 summary 必须是对象")),
    };

    let canvas = match summary_obj
        .and_then(|summary| summary.get("canvas"))
        .or_else(|| object.get("canvas"))
    {
        None | Some(Value::Null) => "single",
        Some(Value::String(kind))
            if matches!(kind.as_str(), "single" | "multi_panel" | "collage") =>
        {
            kind.as_str()
        }
        _ => {
            return Err(ApiError::invalid(
                "MOSS 布局 canvas 仅支持 single、multi_panel 或 collage",
            ));
        }
    };

    let caption = fallback_caption
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            summary_obj
                .and_then(|summary| summary.get("caption"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })
        .or_else(|| {
            object
                .get("caption")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })
        .ok_or_else(|| {
            ApiError::invalid("MOSS 布局需要非空的 summary.caption（或在 prompt 中提供画面总描述）")
        })?;

    let raw_items = object
        .get("items")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= MAX_LAYOUT_ITEMS)
        .ok_or_else(|| {
            ApiError::invalid(format!(
                "MOSS 布局的 items 须包含 1–{MAX_LAYOUT_ITEMS} 个元素"
            ))
        })?;

    let mut normalized_items = Vec::with_capacity(raw_items.len());
    for (index, item) in raw_items.iter().enumerate() {
        let ordinal = index + 1;
        let item_obj = item
            .as_object()
            .ok_or_else(|| ApiError::invalid(format!("布局第 {ordinal} 项必须是对象")))?;
        let label = item_obj
            .get("label")
            .and_then(Value::as_str)
            .filter(|label| matches!(*label, "character" | "object" | "text"))
            .ok_or_else(|| {
                ApiError::invalid(format!(
                    "布局第 {ordinal} 项的 label 仅支持 character、object 或 text"
                ))
            })?;
        let item_caption = item_obj
            .get("caption")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty() && text.chars().count() <= MAX_ITEM_CAPTION_CHARS)
            .ok_or_else(|| {
                ApiError::invalid(format!(
                    "布局第 {ordinal} 项需要 1–{MAX_ITEM_CAPTION_CHARS} 字的 caption"
                ))
            })?;
        let text = match item_obj.get("text") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    None
                } else if trimmed.chars().count() > MAX_ITEM_TEXT_CHARS {
                    return Err(ApiError::invalid(format!(
                        "布局第 {ordinal} 项的 text 不能超过 {MAX_ITEM_TEXT_CHARS} 字"
                    )));
                } else {
                    Some(trimmed.to_owned())
                }
            }
            Some(_) => {
                return Err(ApiError::invalid(format!(
                    "布局第 {ordinal} 项的 text 必须是字符串"
                )));
            }
        };
        if label == "text" && text.is_none() {
            return Err(ApiError::invalid(format!(
                "布局第 {ordinal} 项 label=text 时必须填写非空 text"
            )));
        }

        let raw_box = parse_box(item_obj.get("bbox"), ordinal)?;
        let centered = convert_box(raw_box, &mode, width, height, ordinal)?;

        let mut out = serde_json::Map::new();
        out.insert("label".into(), json!(label));
        out.insert("caption".into(), json!(item_caption));
        out.insert("bbox".into(), json!(centered));
        if let Some(text) = text {
            out.insert("text".into(), json!(text));
        }
        normalized_items.push(Value::Object(out));
    }

    let rendered = serde_json::to_string_pretty(&json!({
        "summary": {
            "canvas": canvas,
            "caption": caption,
        },
        "items": normalized_items,
        "bbox_coord_space": "abs_centralized",
        "bbox_format": "yxyx",
    }))?;
    if rendered.encode_utf16().count() > MAX_PROMPT_UTF16 {
        return Err(ApiError::invalid(
            "编译后的 MOSS 布局 JSON 超过 12000 字符上限，请精简描述或元素数量",
        ));
    }
    Ok(rendered)
}

fn parse_box(value: Option<&Value>, ordinal: usize) -> Result<[f64; 4]> {
    let array = value
        .and_then(Value::as_array)
        .filter(|coords| coords.len() == 4)
        .ok_or_else(|| {
            ApiError::invalid(format!("布局第 {ordinal} 项的 bbox 必须是 4 个数字"))
        })?;
    let mut coords = [0.0_f64; 4];
    for (slot, raw) in coords.iter_mut().zip(array.iter()) {
        let number = raw
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| {
                ApiError::invalid(format!("布局第 {ordinal} 项的 bbox 包含无效数字"))
            })?;
        *slot = number;
    }
    if !(coords[0] < coords[2] && coords[1] < coords[3]) {
        return Err(ApiError::invalid(format!(
            "布局第 {ordinal} 项的 bbox 结束坐标必须大于起始坐标"
        )));
    }
    Ok(coords)
}

fn convert_box(
    coords: [f64; 4],
    mode: &CoordMode,
    width: u64,
    height: u64,
    ordinal: usize,
) -> Result<[i64; 4]> {
    let half_w = width as f64 / 2.0;
    let half_h = height as f64 / 2.0;
    match mode {
        CoordMode::CenteredYxyx => {
            let [top, left, bottom, right] = coords;
            if !(top >= -half_h && bottom <= half_h && left >= -half_w && right <= half_w) {
                return Err(ApiError::invalid(format!(
                    "布局第 {ordinal} 项的 bbox 超出 {width}×{height} 中心坐标范围（y: [-{half_h}, {half_h}], x: [-{half_w}, {half_w}]）"
                )));
            }
            let top = top.round() as i64;
            let left = left.round() as i64;
            let bottom = bottom.round() as i64;
            let right = right.round() as i64;
            if !(top < bottom && left < right) {
                return Err(ApiError::invalid(format!(
                    "布局第 {ordinal} 项的 bbox 取整后面积为零"
                )));
            }
            Ok([top, left, bottom, right])
        }
        CoordMode::AbsXyxy => {
            let [x1, y1, x2, y2] = coords;
            if !(x1 >= 0.0 && x2 <= width as f64 && y1 >= 0.0 && y2 <= height as f64) {
                return Err(ApiError::invalid(format!(
                    "布局第 {ordinal} 项的 abs/xyxy bbox 超出 0..{width} × 0..{height} 画幅"
                )));
            }
            let top = (y1.floor() - half_h) as i64;
            let left = (x1.floor() - half_w) as i64;
            let bottom = (y2.ceil() - half_h) as i64;
            let right = (x2.ceil() - half_w) as i64;
            if !(top as f64 >= -half_h
                && bottom as f64 <= half_h
                && left as f64 >= -half_w
                && right as f64 <= half_w
                && top < bottom
                && left < right)
            {
                return Err(ApiError::invalid(format!(
                    "布局第 {ordinal} 项的像素框换算后超出 {width}×{height} 画幅"
                )));
            }
            Ok([top, left, bottom, right])
        }
        CoordMode::NormalizedYxyx => {
            normalized_to_centered(coords, width, height, 1.0, ordinal)
        }
        CoordMode::NormalizedXyxy => {
            let [x1, y1, x2, y2] = coords;
            normalized_to_centered([y1, x1, y2, x2], width, height, 1.0, ordinal)
        }
        CoordMode::Rel1000Yxyx => {
            normalized_to_centered(coords, width, height, 1000.0, ordinal)
        }
        CoordMode::Rel1000Xyxy => {
            let [x1, y1, x2, y2] = coords;
            normalized_to_centered([y1, x1, y2, x2], width, height, 1000.0, ordinal)
        }
    }
}

fn normalized_to_centered(
    [y1, x1, y2, x2]: [f64; 4],
    width: u64,
    height: u64,
    scale: f64,
    ordinal: usize,
) -> Result<[i64; 4]> {
    if !((0.0..=scale).contains(&y1)
        && (0.0..=scale).contains(&y2)
        && y1 < y2
        && (0.0..=scale).contains(&x1)
        && (0.0..=scale).contains(&x2)
        && x1 < x2)
    {
        return Err(ApiError::invalid(format!(
            "布局第 {ordinal} 项的归一化 bbox 须满足 0 <= y1 < y2 <= {scale} 且 0 <= x1 < x2 <= {scale}"
        )));
    }
    let ny1 = y1 / scale;
    let nx1 = x1 / scale;
    let ny2 = y2 / scale;
    let nx2 = x2 / scale;
    let w = width as f64;
    let h = height as f64;
    let half_w = w / 2.0;
    let half_h = h / 2.0;
    let min_y = (-half_h).ceil() as i64;
    let max_y = half_h.floor() as i64;
    let min_x = (-half_w).ceil() as i64;
    let max_x = half_w.floor() as i64;
    let clamp_int = |v: f64, lo: i64, hi: i64| (v.round() as i64).clamp(lo, hi);

    let mut top = clamp_int(ny1 * h - half_h, min_y, max_y - 1);
    let mut bottom = clamp_int(ny2 * h - half_h, min_y + 1, max_y);
    if bottom <= top {
        if top < max_y {
            bottom = top + 1;
        } else {
            top = bottom - 1;
        }
    }
    let mut left = clamp_int(nx1 * w - half_w, min_x, max_x - 1);
    let mut right = clamp_int(nx2 * w - half_w, min_x + 1, max_x);
    if right <= left {
        if left < max_x {
            right = left + 1;
        } else {
            left = right - 1;
        }
    }
    Ok([top, left, bottom, right])
}
