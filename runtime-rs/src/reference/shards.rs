use super::{Result, check_cancel, io, unavailable};
use serde_json::{Map, Value};
use std::{collections::HashSet, path::Path};
use tokio_util::sync::CancellationToken;

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

struct Ids<'a> {
    ordered: Vec<&'a str>,
    members: HashSet<&'a str>,
}

fn ids(value: &Value) -> Result<Ids<'_>> {
    let array = value.as_array().ok_or_else(unavailable)?;
    let mut seen = HashSet::new();
    let ordered = array
        .iter()
        .map(|v| {
            let id = v.as_str().ok_or_else(unavailable)?;
            if !source_id(id) || !seen.insert(id) {
                return Err(unavailable());
            }
            Ok(id)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Ids { ordered, members: seen })
}

fn manifest(directory: &Path, cancel: &CancellationToken) -> Result<Value> {
    let value = io::json(&directory.join("manifest.json"), cancel)?;
    if value["version"] != 1
        || !value["standards"].is_object()
        || value["standards"].get("characters").is_some()
        || !value["standards"]["perspectives"].is_array()
    {
        return Err(unavailable());
    }
    let characters = ids(&value["characterIds"])?;
    let order = ids(&value["viewOrder"])?;
    if characters.ordered.len() != order.ordered.len()
        || order.members.iter().any(|id| !characters.members.contains(id))
    {
        return Err(unavailable());
    }
    Ok(value)
}

fn shard(directory: &Path, id: &str, cancel: &CancellationToken) -> Result<Value> {
    let value = io::json(&directory.join(format!("{id}.json")), cancel)?;
    if value["standard"]["id"] != id
        || value["view"]["characterId"] != id
        || !value["standard"]["outfits"].is_array()
        || !value["view"]["outfits"].is_array()
    {
        return Err(unavailable());
    }
    Ok(value)
}

pub(super) fn profile(root: &Path, id: &str, cancel: &CancellationToken) -> Result<Option<Value>> {
    check_cancel(cancel)?;
    let directory = root.join("data/references");
    if directory
        .join("manifest.json")
        .try_exists()
        .map_err(|_| unavailable())?
    {
        let manifest = manifest(&directory, cancel)?;
        if !ids(&manifest["characterIds"])?.members.contains(id) {
            return Ok(None);
        }
        // The authoritative per-character shard is read lazily; no aggregate is
        // written and unrelated character profiles are not parsed for this request.
        return Ok(Some(shard(&directory, id, cancel)?["view"].take()));
    }
    let mut view = io::json(&root.join("data/character-reference-view.json"), cancel)?;
    Ok(view
        .as_object_mut()
        .ok_or_else(unavailable)?
        .remove(id)
        .filter(|value| !value.is_null() && value != &Value::Bool(false)))
}

pub(super) fn view(root: &Path, cancel: &CancellationToken) -> Result<Value> {
    check_cancel(cancel)?;
    let directory = root.join("data/references");
    if !directory
        .join("manifest.json")
        .try_exists()
        .map_err(|_| unavailable())?
    {
        let view = io::json(&root.join("data/character-reference-view.json"), cancel)?;
        if !view.is_object() {
            return Err(unavailable());
        }
        return Ok(view);
    }
    let manifest = manifest(&directory, cancel)?;
    let mut profiles = Map::new();
    for id in ids(&manifest["viewOrder"])?.ordered {
        profiles.insert(id.into(), shard(&directory, id, cancel)?["view"].take());
    }
    Ok(Value::Object(profiles))
}

pub(super) fn check_products(
    root: &Path,
    standards: &[u8],
    view: &[u8],
    cancel: &CancellationToken,
) -> Result<()> {
    check_cancel(cancel)?;
    let directory = root.join("data/references");
    if !directory
        .join("manifest.json")
        .try_exists()
        .map_err(|_| unavailable())?
    {
        return Ok(());
    }
    let (expected, profiles) = source_products_with_cancel(root, cancel)?;
    let actual_standards: Value = serde_json::from_slice(standards).map_err(|_| unavailable())?;
    let actual_view: Value = serde_json::from_slice(view).map_err(|_| unavailable())?;
    if actual_standards != expected || actual_view != profiles {
        return Err(unavailable());
    }
    Ok(())
}
pub(crate) fn source_products(root: &Path) -> Result<(Value, Value)> {
    source_products_with_cancel(root, &CancellationToken::new())
}
fn source_products_with_cancel(root: &Path, cancel: &CancellationToken) -> Result<(Value, Value)> {
    let directory = root.join("data/references");
    let mut manifest = manifest(&directory, cancel)?;
    let character_ids = ids(&manifest["characterIds"])?;
    let mut characters = Vec::new();
    let mut profiles = Map::new();
    for id in &character_ids.ordered {
        let mut item = shard(&directory, id, cancel)?;
        characters.push(item["standard"].take());
        profiles.insert((*id).into(), item["view"].take());
    }
    for entry in std::fs::read_dir(&directory).map_err(|_| unavailable())? {
        check_cancel(cancel)?;
        let entry = entry.map_err(|_| unavailable())?;
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(unavailable)?;
        if let Some(id) = name.strip_suffix(".json")
            && id != "manifest"
            && !character_ids.members.contains(id)
        {
            return Err(unavailable());
        }
    }
    let mut expected = manifest["standards"].take();
    expected["characters"] = characters.into();
    let mut ordered = Map::new();
    for id in ids(&manifest["viewOrder"])?.ordered {
        check_cancel(cancel)?;
        ordered.insert(id.into(), profiles.remove(id).ok_or_else(unavailable)?);
    }
    check_cancel(cancel)?;
    Ok((expected, Value::Object(ordered)))
}
