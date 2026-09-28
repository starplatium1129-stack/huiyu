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
    public(raw_hero(root))
}
pub(super) fn raw_hero(root: Option<&Path>) -> Value {
    let fallback = json!({"version":1,"entries":{}});
    let Some(root) = root else {
        return fallback;
    };
    let Some(parent) = root.parent() else {
        return fallback;
    };
    let Ok(paths) = collections(parent) else {
        return fallback;
    };
    let start = paths
        .iter()
        .position(|path| path.file_name() == root.file_name())
        .unwrap_or(0);
    for path in paths.into_iter().skip(start) {
        if let Ok(value) = fs::json(&path.join("home-hero.json"))
            && value["entries"].is_object()
        {
            return value;
        }
    }
    fallback
}
fn public(manifest: Value) -> Value {
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
        if entry["image"] != format!("home/{character}.jpg") {
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
        entries.insert(character.into(),json!({"image":format!("/scene-showcase/home/{character}.jpg?v={encoded}"),"updatedAt":updated}));
    }
    json!({"ok":true,"version":version,"entries":entries})
}
