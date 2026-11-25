use super::Options;
use serde::Serialize;
use serde_json::Value;

const MAX_CAPTION_CHARS: usize = 2400;
const MAX_LAYOUT_ITEMS: usize = 12;
const MAX_ITEM_CAPTION_CHARS: usize = 600;
const MAX_ITEM_TEXT_CHARS: usize = 300;

pub(super) struct ParsedAssist {
    pub caption: String,
    pub layout: Option<AssistLayout>,
}

#[derive(Serialize)]
pub(super) struct AssistLayout {
    canvas: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    scene: Option<String>,
    items: Vec<AssistLayoutItem>,
}

#[derive(Serialize)]
struct AssistLayoutItem {
    label: &'static str,
    caption: String,
    bbox: [f64; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    clothing: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pose: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

fn strip_code_fence(text: &str) -> Option<&str> {
    let fence = text.strip_prefix("```")?;
    let (language, body) = fence.split_once('\n')?;
    let language = language.trim();
    if !language.is_empty() && !language.eq_ignore_ascii_case("json") {
        return None;
    }
    let end = body.rfind("```")?;
    Some(body[..end].trim())
}

fn parse_json_object(content: &str) -> Option<serde_json::Map<String, Value>> {
    let trimmed = content.trim_start_matches('\u{feff}').trim();
    if trimmed.starts_with("```") {
        let body = strip_code_fence(trimmed)?;
        return match serde_json::from_str::<Value>(body) {
            Ok(Value::Object(map)) => Some(map),
            _ => None,
        };
    }
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(trimmed) {
        return Some(map);
    }
    if let Some(fence_start) = trimmed.find("```")
        && let Some(body) = strip_code_fence(&trimmed[fence_start..])
        && let Ok(Value::Object(map)) = serde_json::from_str::<Value>(body)
    {
        return Some(map);
    }
    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}'))
        && start < end
        && let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&trimmed[start..=end])
    {
        return Some(map);
    }
    None
}

fn parse_bbox(value: &Value) -> Option<[f64; 4]> {
    let arr = value.as_array()?;
    if arr.len() != 4 {
        return None;
    }
    let mut coords = [0.0_f64; 4];
    for (slot, entry) in coords.iter_mut().zip(arr.iter()) {
        let num = entry.as_f64()?;
        if !num.is_finite() || !(0.0..=1000.0).contains(&num) {
            return None;
        }
        *slot = num;
    }
    let scale = if coords.iter().any(|&v| v > 1.0) {
        1000.0
    } else {
        1.0
    };
    let [y1, x1, y2, x2] = coords.map(|v| ((v / scale) * 10_000.0).round() / 10_000.0);
    if !(0.0..=1.0).contains(&y1)
        || !(0.0..=1.0).contains(&x1)
        || !(0.0..=1.0).contains(&y2)
        || !(0.0..=1.0).contains(&x2)
        || !(y1 < y2 && x1 < x2)
    {
        return None;
    }
    Some([y1, x1, y2, x2])
}

fn optional_trimmed(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty() && text.chars().count() <= max_chars).then(|| text.to_owned())
}

fn parse_layout_item(value: &Value) -> Option<AssistLayoutItem> {
    let obj = value.as_object()?;
    let label = match obj
        .get("label")?
        .as_str()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "character" => "character",
        "object" => "object",
        "text" => "text",
        _ => return None,
    };
    let clothing = if label == "character" {
        optional_trimmed(obj.get("clothing"), MAX_ITEM_CAPTION_CHARS)
    } else {
        None
    };
    let pose = if label == "character" {
        optional_trimmed(obj.get("pose"), MAX_ITEM_CAPTION_CHARS)
    } else {
        None
    };
    let raw_caption = optional_trimmed(obj.get("caption"), MAX_ITEM_CAPTION_CHARS);
    let caption = match raw_caption {
        Some(text) => text,
        None if label == "character" && (clothing.is_some() || pose.is_some()) => {
            [clothing.as_deref(), pose.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(", ")
        }
        None => return None,
    };
    let bbox = parse_bbox(obj.get("bbox")?)?;
    let text = if label == "text" {
        let raw = obj.get("text")?.as_str()?.trim();
        if raw.is_empty() || raw.chars().count() > MAX_ITEM_TEXT_CHARS {
            return None;
        }
        Some(raw.to_owned())
    } else {
        None
    };
    Some(AssistLayoutItem {
        label,
        caption,
        bbox,
        clothing,
        pose,
        text,
    })
}

fn parse_layout(value: &Value, top_scene: Option<String>) -> Option<AssistLayout> {
    let obj = value.as_object()?;
    let canvas = match obj
        .get("canvas")?
        .as_str()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "single" => "single",
        "multi_panel" => "multi_panel",
        "collage" => "collage",
        _ => return None,
    };
    let scene = optional_trimmed(obj.get("scene"), MAX_CAPTION_CHARS).or(top_scene);
    let raw_items = obj.get("items")?.as_array()?;
    let items: Vec<AssistLayoutItem> = raw_items
        .iter()
        .filter_map(parse_layout_item)
        .take(MAX_LAYOUT_ITEMS)
        .collect();
    if items.is_empty() {
        return None;
    }
    Some(AssistLayout { canvas, scene, items })
}

pub(super) fn parse_response(content: &str, options: Options) -> Option<ParsedAssist> {
    let map = parse_json_object(content)?;
    let caption = map.get("caption")?.as_str()?.trim();
    let lower = caption.to_ascii_lowercase().replace('’', "'");
    let refusal = [
        "i can't",
        "i cannot",
        "i'm unable",
        "i am unable",
        "i won't",
        "i'm sorry",
        "sorry",
        "as an ai",
        "i must decline",
        "无法描述",
        "抱歉",
    ];
    if caption.is_empty()
        || caption.chars().count() > MAX_CAPTION_CHARS
        || refusal.iter().any(|prefix| lower.starts_with(prefix))
    {
        return None;
    }
    let top_scene = optional_trimmed(map.get("scene"), MAX_CAPTION_CHARS);
    let layout = if options.layout {
        map.get("layout").and_then(|value| parse_layout(value, top_scene))
    } else {
        None
    };
    Some(ParsedAssist {
        caption: caption.to_owned(),
        layout,
    })
}
