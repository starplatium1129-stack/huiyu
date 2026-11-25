use super::super::*;

const MAX_LAYOUT_ITEMS: usize = 16;

pub(super) struct NormalizedRefItem {
    pub(super) label: String,
    pub(super) caption: String,
    pub(super) clothing: Option<String>,
    pub(super) pose: Option<String>,
    pub(super) text: Option<String>,
    /// Normalized [y1, x1, y2, x2] in 0.0..=1.0
    pub(super) bbox: [f64; 4],
}

pub(super) struct ParsedReferenceLayout {
    pub(super) canvas: String,
    pub(super) scene: Option<String>,
    pub(super) summary_caption: Option<String>,
    pub(super) items: Vec<NormalizedRefItem>,
}

pub(super) fn reference_people(layout: Option<&ParsedReferenceLayout>) -> Vec<&NormalizedRefItem> {
    let mut people: Vec<_> = layout
        .into_iter()
        .flat_map(|layout| &layout.items)
        .filter(|item| item.label == "character")
        .collect();
    people.sort_by(|a, b| (a.bbox[1] + a.bbox[3]).total_cmp(&(b.bbox[1] + b.bbox[3])));
    people
}

pub(super) fn parse_reference_layout(
    value: &Value,
    target_width: u64,
    target_height: u64,
) -> Result<ParsedReferenceLayout> {
    let root = value
        .as_object()
        .ok_or_else(|| ApiError::invalid("layout 必须是 JSON 对象"))?;
    let object = root
        .get("assistLayout")
        .and_then(Value::as_object)
        .unwrap_or(root);

    let space = object.get("bbox_coord_space").and_then(Value::as_str);
    let format = object.get("bbox_format").and_then(Value::as_str);
    let ref_w = object
        .get("width")
        .and_then(Value::as_u64)
        .filter(|w| *w > 0)
        .unwrap_or(target_width) as f64;
    let ref_h = object
        .get("height")
        .and_then(Value::as_u64)
        .filter(|h| *h > 0)
        .unwrap_or(target_height) as f64;

    let summary_obj = object.get("summary").and_then(Value::as_object);
    let canvas = summary_obj
        .and_then(|summary| summary.get("canvas"))
        .or_else(|| object.get("canvas"))
        .and_then(Value::as_str)
        .filter(|c| matches!(*c, "single" | "multi_panel" | "collage"))
        .unwrap_or("single")
        .to_owned();
    let scene = object
        .get("scene")
        .or_else(|| root.get("scene"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let summary_caption = summary_obj
        .and_then(|summary| summary.get("caption"))
        .or_else(|| object.get("caption"))
        .or_else(|| root.get("caption"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    let raw_items = object
        .get("items")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= MAX_LAYOUT_ITEMS)
        .ok_or_else(|| ApiError::invalid("参考布局的 items 须包含 1–16 个元素"))?;

    let mut items = Vec::with_capacity(raw_items.len());
    for (index, item) in raw_items.iter().enumerate() {
        let ordinal = index + 1;
        let item_obj = item
            .as_object()
            .ok_or_else(|| ApiError::invalid(format!("参考布局第 {ordinal} 项必须是对象")))?;
        let label = item_obj
            .get("label")
            .and_then(Value::as_str)
            .filter(|label| matches!(*label, "character" | "object" | "text"))
            .ok_or_else(|| {
                ApiError::invalid(format!(
                    "参考布局第 {ordinal} 项的 label 仅支持 character、object 或 text"
                ))
            })?;
        let caption = item_obj
            .get("caption")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_owned();
        let clothing = item_obj
            .get("clothing")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let pose = item_obj
            .get("pose")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let text = item_obj
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if label == "text" && text.is_none() {
            return Err(ApiError::invalid(format!(
                "参考布局第 {ordinal} 项 label=text 时必须提供非空 text"
            )));
        }
        let raw_box = parse_box4(item_obj.get("bbox"), ordinal)?;
        let bbox = normalize_box_to_unit(raw_box, space, format, ref_w, ref_h, ordinal)?;
        items.push(NormalizedRefItem {
            label: label.to_owned(),
            caption,
            clothing,
            pose,
            text,
            bbox,
        });
    }
    Ok(ParsedReferenceLayout {
        canvas,
        scene,
        summary_caption,
        items,
    })
}

fn parse_box4(value: Option<&Value>, ordinal: usize) -> Result<[f64; 4]> {
    let arr = value
        .and_then(Value::as_array)
        .filter(|coords| coords.len() == 4)
        .ok_or_else(|| {
            ApiError::invalid(format!("参考布局第 {ordinal} 项的 bbox 必须是 4 个数字"))
        })?;
    let mut coords = [0.0; 4];
    for (slot, raw) in coords.iter_mut().zip(arr.iter()) {
        *slot = raw
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| {
                ApiError::invalid(format!("参考布局第 {ordinal} 项的 bbox 包含无效数字"))
            })?;
    }
    if !(coords[0] < coords[2] && coords[1] < coords[3]) {
        return Err(ApiError::invalid(format!(
            "参考布局第 {ordinal} 项的 bbox 结束坐标必须大于起始坐标"
        )));
    }
    Ok(coords)
}

fn normalize_box_to_unit(
    coords: [f64; 4],
    space: Option<&str>,
    format: Option<&str>,
    ref_w: f64,
    ref_h: f64,
    ordinal: usize,
) -> Result<[f64; 4]> {
    let unit = match (space, format) {
        (None | Some("normalized" | "rel_0_1"), None | Some("yxyx")) => coords,
        (Some("normalized" | "rel_0_1"), Some("xyxy")) => {
            [coords[1], coords[0], coords[3], coords[2]]
        }
        (Some("rel_1000"), None | Some("yxyx")) => [
            coords[0] / 1000.0,
            coords[1] / 1000.0,
            coords[2] / 1000.0,
            coords[3] / 1000.0,
        ],
        (Some("rel_1000"), Some("xyxy")) => [
            coords[1] / 1000.0,
            coords[0] / 1000.0,
            coords[3] / 1000.0,
            coords[2] / 1000.0,
        ],
        (Some("abs"), Some("xyxy")) => [
            coords[1] / ref_h,
            coords[0] / ref_w,
            coords[3] / ref_h,
            coords[2] / ref_w,
        ],
        (Some("abs_centralized"), Some("yxyx")) => [
            (coords[0] + ref_h / 2.0) / ref_h,
            (coords[1] + ref_w / 2.0) / ref_w,
            (coords[2] + ref_h / 2.0) / ref_h,
            (coords[3] + ref_w / 2.0) / ref_w,
        ],
        _ => {
            return Err(ApiError::invalid(
                "参考布局坐标支持 abs_centralized/yxyx、abs/xyxy、normalized(0..1)/yxyx(或xyxy) 或 rel_1000/yxyx(或xyxy)",
            ));
        }
    };
    if !((0.0..=1.0).contains(&unit[0])
        && (0.0..=1.0).contains(&unit[2])
        && unit[0] < unit[2]
        && (0.0..=1.0).contains(&unit[1])
        && (0.0..=1.0).contains(&unit[3])
        && unit[1] < unit[3])
    {
        return Err(ApiError::invalid(format!(
            "参考布局第 {ordinal} 项的坐标超出有效画幅范围"
        )));
    }
    Ok(unit)
}
