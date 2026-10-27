use super::{request_body::Admission, settings::Settings};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

fn check_cancel(cancel: &CancellationToken) -> Option<()> {
    (!cancel.is_cancelled()).then_some(())
}

// read has already checked this canonical root against the import directory.
fn model_file(
    canonical_root: &Path,
    reference: &str,
    cancel: &CancellationToken,
) -> Option<PathBuf> {
    check_cancel(cancel)?;
    if reference.is_empty()
        || reference.contains([':', '%', '?', '#', '\0'])
        || Path::new(reference).is_absolute()
        || reference.replace('\\', "/").split('/').any(|p| p == "..")
    {
        return None;
    }
    let file = std::fs::canonicalize(canonical_root.join(reference)).ok()?;
    check_cancel(cancel)?;
    if !file.starts_with(canonical_root) || file.as_path() == canonical_root {
        return None;
    }
    let metadata = std::fs::metadata(&file).ok()?;
    check_cancel(cancel)?;
    metadata.is_file().then_some(file)
}
fn json(canonical_root: &Path, reference: &str, cancel: &CancellationToken) -> Option<Value> {
    let file = model_file(canonical_root, reference, cancel)?;
    check_cancel(cancel)?;
    let bytes = std::fs::read(file).ok()?;
    check_cancel(cancel)?;
    let value = serde_json::from_slice(&bytes).ok()?;
    check_cancel(cancel)?;
    Some(value)
}

pub(super) async fn read(
    settings: &Settings,
    app: &Path,
    id: &str,
    admission: &Admission,
    cancel: &CancellationToken,
) -> Option<String> {
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
    let id = id.to_owned();
    let admission = admission.clone();
    let scope = cancel.child_token();
    let _guard = scope.clone().drop_guard();
    check_cancel(&scope)?;
    // Batch filesystem checks without retaining a CPU-worker slot. The job and
    // its unpolled result retain admission even when the request goes away.
    let work = tokio::task::spawn_blocking(move || {
        let persona = read_blocking(&directory, &id, &scope);
        (persona, admission)
    });
    tokio::select! {
        biased;
        _ = cancel.cancelled() => None,
        result = work => result.ok()?.0,
    }
}

fn read_blocking(directory: &Path, id: &str, cancel: &CancellationToken) -> Option<String> {
    check_cancel(cancel)?;
    // Canonical comparison rejects a completed-import directory replaced by a link.
    let actual = std::fs::canonicalize(directory).ok()?;
    check_cancel(cancel)?;
    let expected = std::path::absolute(directory).ok()?;
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
    let data = json(&actual, "companion.json", cancel)?;
    if data["disabled"] == true || data["character"]["id"] != id || !data["files"].is_array() {
        return None;
    }
    let persona = data["character"]["personaPrompt"].as_str()?.to_owned();
    let model = json(&actual, data["manifest"].as_str()?, cancel)?;
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
        check_cancel(cancel)?;
        if let Some(value) = refs.get(key).filter(|v| truthy(v)) {
            files.push(value.as_str()?);
        }
    }
    for value in refs[if modern { "Textures" } else { "textures" }].as_array()? {
        check_cancel(cancel)?;
        files.push(value.as_str()?);
    }
    if let Some(expressions) = refs.get(if modern { "Expressions" } else { "expressions" }) {
        for item in expressions.as_array()? {
            check_cancel(cancel)?;
            files.push(item[if modern { "File" } else { "file" }].as_str()?);
        }
    }
    if let Some(motions) = refs.get(if modern { "Motions" } else { "motions" }) {
        for motion in motions.as_object()?.values() {
            check_cancel(cancel)?;
            for item in motion.as_array()? {
                check_cancel(cancel)?;
                for key in if modern {
                    ["File", "Sound"]
                } else {
                    ["file", "sound"]
                } {
                    check_cancel(cancel)?;
                    if let Some(value) = item.get(key).filter(|value| truthy(value)) {
                        files.push(value.as_str()?);
                    }
                }
            }
        }
    }
    for reference in files {
        model_file(&actual, reference, cancel)?;
    }
    check_cancel(cancel)?;
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
