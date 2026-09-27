use super::{Result, io, unavailable};
use serde_json::{Map, Value};
use std::{collections::HashSet, path::Path};

fn source_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        && !["con", "prn", "aux", "nul"].contains(&id)
        && !((id.starts_with("com") || id.starts_with("lpt"))
            && id.len() == 4
            && matches!(id.as_bytes()[3], b'1'..=b'9'))
}

fn ids(value: &Value) -> Result<Vec<&str>> {
    let array = value.as_array().ok_or_else(unavailable)?;
    let mut seen = HashSet::new();
    array
        .iter()
        .map(|v| {
            let id = v.as_str().ok_or_else(unavailable)?;
            if !source_id(id) || !seen.insert(id) {
                return Err(unavailable());
            }
            Ok(id)
        })
        .collect()
}

fn manifest(directory: &Path) -> Result<Value> {
    let value = io::json(&directory.join("manifest.json"))?;
    if value["version"] != 1
        || !value["standards"].is_object()
        || value["standards"].get("characters").is_some()
        || !value["standards"]["perspectives"].is_array()
    {
        return Err(unavailable());
    }
    let characters = ids(&value["characterIds"])?;
    let order = ids(&value["viewOrder"])?;
    if characters.len() != order.len() || order.iter().any(|id| !characters.contains(id)) {
        return Err(unavailable());
    }
    Ok(value)
}

fn shard(directory: &Path, id: &str) -> Result<Value> {
    let value = io::json(&directory.join(format!("{id}.json")))?;
    if value["standard"]["id"] != id
        || value["view"]["characterId"] != id
        || !value["standard"]["outfits"].is_array()
        || !value["view"]["outfits"].is_array()
    {
        return Err(unavailable());
    }
    Ok(value)
}

pub(super) fn profile(root: &Path, id: &str) -> Result<Option<Value>> {
    let directory = root.join("data/references");
    if directory
        .join("manifest.json")
        .try_exists()
        .map_err(|_| unavailable())?
    {
        let manifest = manifest(&directory)?;
        if !ids(&manifest["characterIds"])?.contains(&id) {
            return Ok(None);
        }
        // The authoritative per-character shard is read lazily; no aggregate is
        // written and unrelated character profiles are not parsed for this request.
        return Ok(shard(&directory, id)?.get("view").cloned());
    }
    let view = io::json(&root.join("data/character-reference-view.json"))?;
    if !view.is_object() {
        return Err(unavailable());
    }
    Ok(view
        .get(id)
        .cloned()
        .filter(|value| !value.is_null() && value != &Value::Bool(false)))
}

pub(super) fn view(root: &Path) -> Result<Value> {
    let directory = root.join("data/references");
    if !directory
        .join("manifest.json")
        .try_exists()
        .map_err(|_| unavailable())?
    {
        let view = io::json(&root.join("data/character-reference-view.json"))?;
        if !view.is_object() {
            return Err(unavailable());
        }
        return Ok(view);
    }
    let manifest = manifest(&directory)?;
    let mut profiles = Map::new();
    for id in ids(&manifest["viewOrder"])? {
        profiles.insert(id.into(), shard(&directory, id)?["view"].clone());
    }
    Ok(Value::Object(profiles))
}

pub(super) fn check_products(root: &Path, standards: &[u8], view: &[u8]) -> Result<()> {
    let directory = root.join("data/references");
    if !directory
        .join("manifest.json")
        .try_exists()
        .map_err(|_| unavailable())?
    {
        return Ok(());
    }
    let (expected, profiles) = source_products(root)?;
    let actual_standards: Value = serde_json::from_slice(standards).map_err(|_| unavailable())?;
    let actual_view: Value = serde_json::from_slice(view).map_err(|_| unavailable())?;
    if actual_standards != expected || actual_view != profiles {
        return Err(unavailable());
    }
    Ok(())
}
pub(crate) fn source_products(root: &Path) -> Result<(Value, Value)> {
    let directory = root.join("data/references");
    let manifest = manifest(&directory)?;
    let character_ids = ids(&manifest["characterIds"])?;
    let mut characters = Vec::new();
    let mut profiles = Map::new();
    for id in &character_ids {
        let item = shard(&directory, id)?;
        characters.push(item["standard"].clone());
        profiles.insert((*id).into(), item["view"].clone());
    }
    for entry in std::fs::read_dir(&directory).map_err(|_| unavailable())? {
        let entry = entry.map_err(|_| unavailable())?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(unavailable)?;
        if let Some(id) = name.strip_suffix(".json")
            && id != "manifest"
            && !character_ids.contains(&id)
        {
            return Err(unavailable());
        }
    }
    let mut expected = manifest["standards"].clone();
    expected["characters"] = characters.into();
    let mut ordered = Map::new();
    for id in ids(&manifest["viewOrder"])? {
        ordered.insert(id.into(), profiles.remove(id).ok_or_else(unavailable)?);
    }
    Ok((expected, Value::Object(ordered)))
}
