use super::PART_BYTES;
use serde_json::{Map, Value, json};

pub(super) fn safe_alias(body: &Value) -> Option<&str> {
    for key in ["image_id", "mediaAlias", "video_id", "videoAlias", "imageId"] {
        if let Some(alias) = body.get(key).and_then(Value::as_str).map(str::trim)
            && !alias.is_empty()
            && alias.len() <= 256
            && !alias.contains(['\0', '/', '\\'])
            && !alias.contains("..")
        {
            return Some(alias);
        }
    }
    None
}

pub(super) fn detect_media_type(body: &Value, mime: Option<&str>) -> &'static str {
    if let Some(mime) = mime {
        if mime.starts_with("video/") {
            return "video";
        }
        if mime.starts_with("audio/") {
            return "audio";
        }
        if mime.starts_with("image/") {
            return "image";
        }
    }
    for key in ["mediaType", "mediaKind", "type", "kind", "mime", "mimeType"] {
        if let Some(val) = body.get(key).and_then(Value::as_str) {
            let lower = val.trim().to_ascii_lowercase();
            if lower == "video" || lower.starts_with("video/") {
                return "video";
            }
            if lower == "audio" || lower.starts_with("audio/") {
                return "audio";
            }
            if lower == "image" || lower.starts_with("image/") {
                return "image";
            }
        }
    }
    if body
        .get("engine")
        .and_then(Value::as_str)
        .is_some_and(|e| e.eq_ignore_ascii_case("video") || e.to_ascii_lowercase().starts_with("video"))
    {
        return "video";
    }
    if body
        .get("video_id")
        .or_else(|| body.get("videoAlias"))
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
    {
        return "video";
    }
    if safe_alias(body).is_some() {
        "image"
    } else {
        "unknown"
    }
}

fn id_to_string(id: &Value) -> (String, &'static str) {
    match id {
        Value::String(s) => (s.clone(), "string"),
        Value::Number(n) => (n.to_string(), "number"),
        other => (other.to_string(), "string"),
    }
}

fn encode_path_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

fn collect_tags(body: &Value) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for key in ["collectionTags", "manual_tags", "tags"] {
        if let Some(items) = body.get(key).and_then(Value::as_array) {
            for item in items {
                if let Some(text) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    set.insert(text.to_owned());
                }
            }
        }
    }
    set.into_iter().collect()
}

pub(super) fn truthy_flag(value: &Value) -> bool {
    match value {
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0),
        Value::String(s) => matches!(s.to_ascii_lowercase().as_str(), "true" | "1"),
        _ => false,
    }
}

pub(super) fn sanitize_artwork(
    record: &Value,
    include_detail: bool,
    media_info: Option<(&str, u64, &str)>,
) -> Value {
    let body = &record["body"];
    let (id_str, id_type) = id_to_string(&record["id"]);
    let has_file = safe_alias(body).is_some();
    let media_type = detect_media_type(body, media_info.map(|(m, _, _)| m));
    let file_url = if has_file {
        let encoded = encode_path_segment(&id_str);
        if id_type == "number" {
            Some(format!("/api/muse/gallery/{encoded}/file?idType=number"))
        } else {
            Some(format!("/api/muse/gallery/{encoded}/file"))
        }
    } else {
        None
    };

    let mut out = Map::new();
    out.insert("id".into(), record["id"].clone());
    out.insert("idText".into(), json!(id_str));
    out.insert("idType".into(), json!(id_type));
    out.insert("mediaType".into(), json!(media_type));
    out.insert("hasFile".into(), json!(has_file));
    out.insert("fileUrl".into(), json!(file_url));
    out.insert("revision".into(), record["revision"].clone());
    out.insert("favorite".into(), json!(truthy_flag(&body["favorite"])));
    out.insert("tags".into(), json!(collect_tags(body)));

    // Strict allow-list of safe metadata fields; never copy arbitrary body keys or local paths.
    for key in [
        "title",
        "scene",
        "sceneTitle",
        "character",
        "characterId",
        "outfitId",
        "blueprintId",
        "project",
        "engine",
        "model",
        "checkpoint",
        "lora",
        "size",
        "width",
        "height",
        "seed",
        "sampler",
        "scheduler",
        "steps",
        "cfg",
        "reviewState",
        "timestamp",
        "duration",
        "fps",
    ] {
        if let Some(value) = body.get(key)
            && (value.is_string() || value.is_number() || value.is_boolean() || value.is_null())
        {
            out.insert(key.into(), value.clone());
        }
    }

    if let Some(prompt) = body.get("prompt").and_then(Value::as_str) {
        if include_detail {
            out.insert("prompt".into(), json!(prompt));
        } else {
            let preview: String = prompt.chars().take(240).collect();
            out.insert("promptPreview".into(), json!(preview));
        }
    }

    if include_detail {
        if let Some(story) = body.get("story").and_then(Value::as_str) {
            out.insert("story".into(), json!(story));
        }
        if let Some(neg) = body
            .get("negative")
            .or_else(|| body.get("negativePrompt"))
            .and_then(Value::as_str)
        {
            out.insert("negative".into(), json!(neg));
        }
        if let Some((mime, bytes, sha256)) = media_info {
            out.insert("mimeType".into(), json!(mime));
            out.insert("bytes".into(), json!(bytes));
            out.insert("sha256".into(), json!(sha256));
            out.insert("partBytes".into(), json!(PART_BYTES));
        } else {
            out.insert("mimeType".into(), Value::Null);
            out.insert("bytes".into(), Value::Null);
            out.insert("sha256".into(), Value::Null);
        }
    }
    Value::Object(out)
}
