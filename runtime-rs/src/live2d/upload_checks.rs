use super::manifest::{invalid, relative};
use crate::error::Result;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::Path,
};
use tokio_util::sync::CancellationToken;

fn json_depth(value: &Value, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    match value {
        Value::Object(values) => values.iter().all(|(key, value)| {
            !["__proto__", "prototype", "constructor"].contains(&key.as_str())
                && json_depth(value, depth + 1)
        }),
        Value::Array(values) => values.iter().all(|value| json_depth(value, depth + 1)),
        _ => true,
    }
}
pub(super) fn inspect(
    directory: &Path,
    paths: &[String],
    cancel: &CancellationToken,
) -> Result<HashMap<String, Value>> {
    let mut json = HashMap::new();
    for name in paths {
        super::editor::check_cancel(cancel)?;
        let path = directory.join(name);
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match extension.as_str() {
            "json" => {
                let value = super::manifest::read_json(&path)?;
                if !value.is_object() || !json_depth(&value, 0) {
                    return Err(invalid("Invalid JSON shape, depth or key"));
                }
                json.insert(name.clone(), value);
            }
            "png" | "jpg" | "jpeg" | "webp" => {
                // Header inspection only: do not decode or recolor uploaded atlases.
                let reader = image::ImageReader::open(path)?.with_guessed_format()?;
                if !matches!(
                    reader.format(),
                    Some(
                        image::ImageFormat::Png
                            | image::ImageFormat::Jpeg
                            | image::ImageFormat::WebP
                    )
                ) {
                    return Err(invalid("Invalid texture header"));
                }
                let (width, height) = reader
                    .into_dimensions()
                    .map_err(|_| invalid("Invalid texture dimensions"))?;
                if width == 0
                    || height == 0
                    || width > 8192
                    || height > 8192
                    || u64::from(width) * u64::from(height) > 32 * 1024 * 1024
                {
                    return Err(invalid("Invalid texture dimensions"));
                }
            }
            "moc3" => {
                let mut header = [0; 8];
                fs::File::open(path)?
                    .read_exact(&mut header)
                    .map_err(|_| invalid("Invalid moc3 header"))?;
                if &header[..4] != b"MOC3" {
                    return Err(invalid("Invalid moc3 header"));
                }
            }
            _ => {}
        }
    }
    Ok(json)
}
pub(super) fn references(model: &Value, entry: &str, paths: &HashSet<String>) -> Result<()> {
    let refs = model["FileReferences"]
        .as_object()
        .ok_or_else(|| invalid("FileReferences required"))?;
    let prefix = entry
        .rsplit_once('/')
        .map(|(prefix, _)| format!("{prefix}/"))
        .unwrap_or_default();
    let reference = |value: &Value, extensions: &[&str]| -> Result<()> {
        let name = value
            .as_str()
            .ok_or_else(|| invalid("Invalid model reference"))?;
        relative(name)?;
        if !extensions
            .iter()
            .any(|extension| name.to_ascii_lowercase().ends_with(extension))
            || !paths.contains(&format!("{prefix}{name}"))
        {
            return Err(invalid("Missing or unsupported model reference"));
        }
        Ok(())
    };
    reference(&model["FileReferences"]["Moc"], &[".moc3"])?;
    let textures = model["FileReferences"]["Textures"]
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or_else(|| invalid("Textures required"))?;
    for file in textures {
        reference(file, &[".png", ".jpg", ".jpeg", ".webp"])?;
    }
    for field in ["Physics", "Pose", "DisplayInfo", "UserData"] {
        if let Some(file) = refs.get(field) {
            reference(file, &[".json"])?;
        }
    }
    let identifier = |value: &str| {
        !value.is_empty()
            && value.encode_utf16().count() <= 256
            && !value.chars().any(|c| c <= '\u{1f}')
    };
    if let Some(expressions) = refs.get("Expressions") {
        let mut names = HashSet::new();
        for item in expressions
            .as_array()
            .ok_or_else(|| invalid("Invalid expression list"))?
        {
            let name = item["Name"]
                .as_str()
                .filter(|name| identifier(name))
                .ok_or_else(|| invalid("Invalid expression name"))?;
            if !names.insert(name) {
                return Err(invalid("Duplicate expression name"));
            }
            reference(&item["File"], &[".exp3.json"])?;
        }
    }
    if let Some(motions) = refs.get("Motions") {
        for (group, motions) in motions
            .as_object()
            .ok_or_else(|| invalid("Invalid motion groups"))?
        {
            if !identifier(group) {
                return Err(invalid("Invalid motion group"));
            }
            for motion in motions
                .as_array()
                .ok_or_else(|| invalid("Invalid motion group"))?
            {
                reference(&motion["File"], &[".motion3.json"])?;
                if let Some(sound) = motion.get("Sound") {
                    reference(sound, &[".wav", ".ogg", ".mp3"])?;
                }
            }
        }
    }
    for field in ["Groups", "HitAreas"] {
        if model.get(field).is_some_and(|value| !value.is_array()) {
            return Err(invalid("Invalid model groups"));
        }
    }
    Ok(())
}
