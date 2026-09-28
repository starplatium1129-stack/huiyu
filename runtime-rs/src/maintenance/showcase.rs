use super::{Error, Result, fs};
use crate::config::Config;
use icu_collator::{Collator, options::CollatorOptions};
use icu_locale::Locale;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn collections(root: &Path) -> Result<Vec<PathBuf>> {
    fs::safe(root, true, false)?;
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir()
            && !entry.file_name().to_string_lossy().starts_with('.')
            && entry.path().join("manifest.json").exists()
        {
            paths.push(entry.path());
        }
    }
    let locale: Locale = "zh-CN".parse().unwrap();
    let collator = Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|_| Error::path("样张排序不可用"))?;
    paths.sort_by(|a, b| {
        collator.compare(
            &b.file_name().unwrap().to_string_lossy(),
            &a.file_name().unwrap().to_string_lossy(),
        )
    });
    Ok(paths)
}
pub(super) fn root(config: &Config) -> Option<PathBuf> {
    let saved = fs::json(&config.runtime_root.join("config.json")).unwrap_or(Value::Null);
    let explicit = std::env::var_os("SCENE_SHOWCASE_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            saved["sceneShowcaseDir"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
        });
    let mut roots = Vec::new();
    if let Some(path) = explicit {
        roots.push(path);
    }
    roots.push(config.ai_workspace_root.join("SceneShowcase"));
    roots.push(
        config
            .app_root
            .parent()
            .unwrap_or(&config.app_root)
            .join("AI/SceneShowcase"),
    );
    for root in roots {
        let Ok(root) = fs::absolute(&root) else {
            continue;
        };
        if root.join("manifest.json").exists() {
            return Some(root);
        }
        if let Ok(paths) = collections(&root)
            && let Some(path) = paths.first()
        {
            return Some(path.clone());
        }
    }
    None
}
pub(super) fn hero(root: Option<&Path>) -> Value {
    // Historical showcase editions shipped their own home art. Only an explicit
    // upload in the active edition may override the currently bundled covers.
    public(raw_hero(root), root)
}
pub(super) fn raw_hero(root: Option<&Path>) -> Value {
    root.and_then(|root| fs::json(&root.join("home-hero.json")).ok())
        .filter(|value| value["entries"].is_object())
        .unwrap_or(json!({"version":1,"entries":{}}))
}
fn public(manifest: Value, root: Option<&Path>) -> Value {
    let mut entries = serde_json::Map::new();
    let version = manifest
        .get("version")
        .filter(|value| {
            !value.is_null()
                && *value != &json!(0)
                && *value != &json!(false)
                && *value != &json!("")
        })
        .cloned()
        .unwrap_or(json!(1));
    for character in ["nene", "natsume"] {
        let entry = &manifest["entries"][character];
        let image = format!("home/{character}.jpg");
        if entry["source"] != "upload"
            || entry["image"] != image
            || !root.is_some_and(|root| root.join(&image).is_file())
        {
            continue;
        }
        let updated = entry
            .get("updatedAt")
            .filter(|value| {
                !value.is_null()
                    && *value != &json!(0)
                    && *value != &json!(false)
                    && *value != &json!("")
            })
            .cloned();
        let stamp = updated.as_ref().unwrap_or(&version);
        let stamp = stamp
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| crate::storage::stringify(stamp));
        let encoded = url::form_urlencoded::byte_serialize(stamp.as_bytes())
            .collect::<String>()
            .replace('+', "%20");
        entries.insert(character.into(),json!({"image":format!("/scene-showcase/home/{character}.jpg?v={encoded}"),"updatedAt":updated,"source":"upload"}));
    }
    json!({"ok":true,"version":version,"entries":entries})
}
