use super::fs;
use crate::config::Config;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub(super) fn root(config: &Config) -> Option<PathBuf> {
    crate::resources::offline::showcase_root(config)
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
