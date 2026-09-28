use crate::error::{ApiError, Result};
use serde_json::Value;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;

pub(super) fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "LIVE2D_INVALID", message)
}
pub(super) fn identity(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && (id.as_bytes()[0].is_ascii_lowercase() || id.as_bytes()[0].is_ascii_digit())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
        && !["nene", "natsume", "raiden_shogun"].contains(&id)
}
pub(super) fn relative(path: &str) -> Result<&str> {
    let invalid_part = |part: &str| {
        let name = part.split('.').next().unwrap_or("").to_ascii_lowercase();
        part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with(['.', ' '])
            || ["con", "prn", "aux", "nul"].contains(&name.as_str())
            || ((name.starts_with("com") || name.starts_with("lpt"))
                && name.len() == 4
                && matches!(name.as_bytes()[3], b'1'..=b'9'))
    };
    if path.encode_utf16().count() > 512
        || path.nfc().collect::<String>() != path
        || path
            .chars()
            .any(|c| c.is_ascii_control() || "\\:%?#<>|\"*".contains(c))
        || path.split('/').any(invalid_part)
    {
        return Err(invalid("Invalid model file path"));
    }
    Ok(path)
}
pub(super) fn model_file(root: &Path, reference: &str) -> Result<PathBuf> {
    if reference.is_empty() || reference.contains([':', '%', '?', '#', '\0']) {
        return Err(invalid("Invalid model reference"));
    }
    let normalized = reference.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err(invalid("Invalid model reference"));
    }
    let root = root.canonicalize()?;
    let target = root.join(path).canonicalize()?;
    if !target.starts_with(&root) || target == root || !target.is_file() {
        return Err(invalid("Model reference escapes its directory"));
    }
    Ok(target)
}
pub(super) fn no_links(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(invalid("Import root must be absolute"));
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir) {
            return Err(invalid("Import root cannot contain parent traversal"));
        }
        current.push(part);
        // A canonical Windows path starts with a verbatim drive/UNC prefix.
        // The prefix alone (e.g. \\?\C:) is not a queryable absolute path.
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(invalid("Imported assets cannot be links"));
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err(invalid("Imported assets cannot be reparse points"));
                    }
                }
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    Ok(())
}
pub(super) fn format(model: &Value) -> Result<&'static str> {
    if model["Version"] == 3
        && model["FileReferences"]["Moc"].is_string()
        && model["FileReferences"]["Textures"]
            .as_array()
            .is_some_and(|files| !files.is_empty())
    {
        return Ok("cubism3");
    }
    if model["model"].is_string()
        && model["textures"]
            .as_array()
            .is_some_and(|files| !files.is_empty())
    {
        return Ok("cubism2");
    }
    Err(invalid("Model requires a core and at least one texture"))
}
pub(super) fn map_references(
    model: &mut Value,
    mut map: impl FnMut(&str) -> Result<String>,
) -> Result<()> {
    let modern = format(model)? == "cubism3";
    let refs = if modern {
        &mut model["FileReferences"]
    } else {
        model
    };
    let mut rewrite = |value: &mut Value| -> Result<()> {
        let path = value
            .as_str()
            .ok_or_else(|| invalid("Model reference must be a string"))?;
        *value = Value::String(map(path)?);
        Ok(())
    };
    for key in if modern {
        &["Moc", "Physics", "Pose", "DisplayInfo", "UserData"][..]
    } else {
        &["model", "physics", "pose"][..]
    } {
        if let Some(value) = refs.get_mut(*key)
            && !value.is_null()
        {
            rewrite(value)?;
        }
    }
    let textures = refs[if modern { "Textures" } else { "textures" }]
        .as_array_mut()
        .ok_or_else(|| invalid("Invalid textures"))?;
    for texture in textures {
        rewrite(texture)?;
    }
    if let Some(expressions) = refs.get_mut(if modern { "Expressions" } else { "expressions" }) {
        for item in expressions
            .as_array_mut()
            .ok_or_else(|| invalid("Invalid expressions"))?
        {
            let file = item
                .as_object_mut()
                .and_then(|item| item.get_mut(if modern { "File" } else { "file" }))
                .ok_or_else(|| invalid("Invalid expression reference"))?;
            rewrite(file)?;
        }
    }
    if let Some(motions) = refs.get_mut(if modern { "Motions" } else { "motions" }) {
        for group in motions
            .as_object_mut()
            .ok_or_else(|| invalid("Invalid motions"))?
            .values_mut()
        {
            for item in group
                .as_array_mut()
                .ok_or_else(|| invalid("Invalid motion group"))?
            {
                for key in if modern {
                    ["File", "Sound"]
                } else {
                    ["file", "sound"]
                } {
                    if let Some(value) = item.get_mut(key) {
                        rewrite(value)?;
                    }
                }
            }
        }
    }
    Ok(())
}
pub(super) fn references(model: &Value) -> Result<Vec<String>> {
    let mut result = Vec::new();
    map_references(&mut model.clone(), |reference| {
        result.push(reference.into());
        Ok(reference.into())
    })?;
    Ok(result)
}
pub(super) fn read_json(path: &Path) -> Result<Value> {
    if fs::metadata(path)?.len() > 4 * 1024 * 1024 {
        return Err(invalid("Model JSON exceeds 4 MiB"));
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
