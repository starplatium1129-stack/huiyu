use std::path::{Component, Path, PathBuf};

pub struct ModelFiles {
    pub directory: PathBuf,
    pub manifest: PathBuf,
    pub moc: PathBuf,
}

pub fn checked_file(root: &Path, reference: &str) -> Result<PathBuf, String> {
    let relative = Path::new(reference);
    if reference.is_empty() || reference.contains([':', '%', '?', '#', '\0'])
        || relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err("invalid Live2D reference".into());
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let file = root.join(relative).canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(&canonical_root) || !file.is_file() {
        return Err("Live2D reference leaves its model directory".into());
    }
    Ok(file)
}

/// The model URL from WebView never becomes a filesystem path. Only a known
/// builtin or a completed local import with matching identities can be loaded.
pub fn resolve_model(assets: &Path, local_root: Option<&Path>, character: &str, profile_id: &str) -> Result<ModelFiles, String> {
    if character.is_empty() || character.len() > 80
        || !character.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-') {
        return Err("invalid Live2D character".into());
    }
    let builtin = matches!(character, "nene" | "natsume");
    let fallback = assets.parent().unwrap_or(assets).join("runtime/live2d-imports");
    let base = if builtin { assets.join("live2d") } else { local_root.unwrap_or(&fallback).to_path_buf() };
    let directory = base.join(character).canonicalize().map_err(|e| e.to_string())?;
    if !directory.starts_with(base.canonicalize().map_err(|e| e.to_string())?) {
        return Err("model directory leaves allowed root".into());
    }
    let manifest_name = if builtin {
        format!("{character}.model3.json")
    } else {
        let receipt: serde_json::Value = serde_json::from_slice(&std::fs::read(checked_file(&directory, "companion.json")?).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if receipt["character"]["id"].as_str() != Some(character)
            || receipt["avatar"]["characterId"].as_str() != Some(character)
            || receipt["profile"]["profileId"].as_str() != Some(profile_id)
            || receipt["avatar"]["profileId"].as_str() != Some(profile_id)
            || receipt["avatar"]["id"] != receipt["profile"]["avatarId"]
            || !receipt["profile"]["backendCompatibility"].as_array().is_some_and(|v| v.iter().any(|b| b == "native")) {
            return Err("local model identity or backend mismatch".into());
        }
        receipt["manifest"].as_str().ok_or("missing local manifest")?.to_string()
    };
    let manifest = checked_file(&directory, &manifest_name)?;
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if json["Version"] != 3 { return Err("native requires a Cubism 3 manifest".into()); }
    let refs = &json["FileReferences"];
    let moc = checked_file(&directory, refs["Moc"].as_str().ok_or("missing moc")?)?;
    for key in ["Physics", "Pose", "DisplayInfo"] {
        if let Some(file) = refs[key].as_str() { checked_file(&directory, file)?; }
    }
    for texture in refs["Textures"].as_array().filter(|v| !v.is_empty()).ok_or("missing textures")? {
        checked_file(&directory, texture.as_str().ok_or("invalid texture")?)?;
    }
    for expression in refs["Expressions"].as_array().into_iter().flatten() {
        checked_file(&directory, expression["File"].as_str().ok_or("invalid expression")?)?;
    }
    for group in refs["Motions"].as_object().into_iter().flat_map(|groups| groups.values()) {
        for motion in group.as_array().ok_or("invalid motion group")? {
            checked_file(&directory, motion["File"].as_str().ok_or("invalid motion")?)?;
        }
    }
    Ok(ModelFiles { directory, manifest, moc })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_model_resolves_explicit_manifest_not_moc_stem_and_rejects_escape() {
        let root = std::env::temp_dir().join(format!("aics-native-import-{}", std::process::id()));
        let dir = root.join("imports/fixture");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("renamed.moc3"), b"MOC3").unwrap();
        std::fs::write(dir.join("t.png"), b"png").unwrap();
        std::fs::write(dir.join("fixture.model3.json"), r#"{"Version":3,"FileReferences":{"Moc":"renamed.moc3","Textures":["t.png"]}}"#).unwrap();
        std::fs::write(dir.join("companion.json"), r#"{"character":{"id":"fixture"},"avatar":{"id":"avatar","characterId":"fixture","profileId":"profile"},"profile":{"profileId":"profile","avatarId":"avatar","backendCompatibility":["native"]},"manifest":"fixture.model3.json"}"#).unwrap();
        let imports = root.join("imports");
        assert!(resolve_model(&root, Some(&imports), "fixture", "profile").is_ok());
        assert!(resolve_model(&root, Some(&imports), "fixture", "wrong").is_err());
        assert!(resolve_model(&root, Some(&imports), "../fixture", "profile").is_err());
        assert!(checked_file(&dir, "../fixture/t.png").is_err());
        std::fs::remove_file(dir.join("t.png")).unwrap();
        assert!(resolve_model(&root, Some(&imports), "fixture", "profile").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
