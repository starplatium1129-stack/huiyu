use super::settings::Settings;
use serde_json::Value;
use std::path::{Path, PathBuf};

async fn model_file(root: &Path, reference: &str) -> Option<PathBuf> {
    if reference.is_empty()
        || reference.contains([':', '%', '?', '#', '\0'])
        || Path::new(reference).is_absolute()
        || reference.replace('\\', "/").split('/').any(|p| p == "..")
    {
        return None;
    }
    let root = tokio::fs::canonicalize(root).await.ok()?;
    let file = tokio::fs::canonicalize(root.join(reference)).await.ok()?;
    (file.starts_with(&root) && file != root && tokio::fs::metadata(&file).await.ok()?.is_file())
        .then_some(file)
}
async fn json(root: &Path, reference: &str) -> Option<Value> {
    serde_json::from_slice(
        &tokio::fs::read(model_file(root, reference).await?)
            .await
            .ok()?,
    )
    .ok()
}

pub(super) async fn read(settings: &Settings, app: &Path, id: &str) -> Option<String> {
    if ["nene", "natsume", "raiden_shogun"].contains(&id)
        || id.is_empty()
        || id.len() > 80
        || !id.as_bytes()[0].is_ascii_lowercase() && !id.as_bytes()[0].is_ascii_digit()
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"_-".contains(&c))
    {
        return None;
    }
    let base = if std::env::var("AICS_DESKTOP_PACKAGED").as_deref() == Ok("1") {
        settings.runtime.clone()
    } else {
        app.join("runtime")
    };
    let directory = base.join("live2d-imports").join(id);
    // Canonical comparison rejects a completed-import directory replaced by a link.
    let actual = tokio::fs::canonicalize(&directory).await.ok()?;
    let expected = std::path::absolute(&directory).ok()?;
    #[cfg(windows)]
    let same = actual
        .to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .eq_ignore_ascii_case(expected.to_string_lossy().trim_start_matches("\\\\?\\"));
    #[cfg(not(windows))]
    let same = actual == expected;
    if !same {
        return None;
    }
    let data = json(&directory, "companion.json").await?;
    if data["disabled"] == true || data["character"]["id"] != id || !data["files"].is_array() {
        return None;
    }
    let persona = data["character"]["personaPrompt"].as_str()?.to_owned();
    let model = json(&directory, data["manifest"].as_str()?).await?;
    let modern = model["Version"] == 3
        && model["FileReferences"]["Moc"].is_string()
        && model["FileReferences"]["Textures"]
            .as_array()
            .is_some_and(|v| !v.is_empty());
    if !modern
        && !(model["model"].is_string()
            && model["textures"].as_array().is_some_and(|v| !v.is_empty()))
    {
        return None;
    }
    let refs = if modern {
        &model["FileReferences"]
    } else {
        &model
    };
    let mut files = Vec::new();
    for key in if modern {
        vec!["Moc", "Physics", "Pose", "DisplayInfo", "UserData"]
    } else {
        vec!["model", "physics", "pose"]
    } {
        if let Some(value) = refs.get(key).filter(|v| truthy(v)) {
            files.push(value.as_str()?);
        }
    }
    for value in refs[if modern { "Textures" } else { "textures" }].as_array()? {
        files.push(value.as_str()?);
    }
    if let Some(expressions) = refs.get(if modern { "Expressions" } else { "expressions" }) {
        for item in expressions.as_array()? {
            files.push(item[if modern { "File" } else { "file" }].as_str()?);
        }
    }
    if let Some(motions) = refs.get(if modern { "Motions" } else { "motions" }) {
        for motion in motions.as_object()?.values() {
            for item in motion.as_array()? {
                for key in if modern {
                    ["File", "Sound"]
                } else {
                    ["file", "sound"]
                } {
                    if let Some(value) = item.get(key).filter(|value| truthy(value)) {
                        files.push(value.as_str()?);
                    }
                }
            }
        }
    }
    for reference in files {
        model_file(&directory, reference).await?;
    }
    Some(persona)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64() != Some(0.0),
        _ => true,
    }
}
