use super::{Error, Result, Value, json, manifest::Manifest, number};
use std::collections::{HashMap, HashSet};
fn invalid() -> Error {
    Error::new(
        "BASELINE_MISMATCH",
        "Delta is incompatible with installed baseline",
    )
}
fn identity(record: &Value, manifest: &Manifest) -> bool {
    record["path"].as_str().is_some_and(|path| !path.is_empty())
        && record["contentIdentity"]
            .as_str()
            .is_some_and(|value| value.to_lowercase() == manifest.identity())
        && number(&record["entryCount"]) == Some(manifest.entries.len() as u64)
        && number(&record["totalBytes"]) == Some(manifest.bytes())
}
pub(super) fn reconstruct(base: &Manifest, pack: &Manifest, delta: &Value) -> Result<Manifest> {
    if delta["schemaVersion"] != 1
        || delta["kind"] != "resource-pack-delta"
        || !identity(&delta["baseManifest"], base)
    {
        return Err(invalid());
    }
    let removed = delta["removed"].as_array().ok_or_else(invalid)?;
    let by_path = base
        .entries
        .iter()
        .map(|entry| (&entry.path, entry))
        .collect::<HashMap<_, _>>();
    let candidate = pack
        .entries
        .iter()
        .map(|entry| (&entry.path, entry))
        .collect::<HashMap<_, _>>();
    let mut removed_paths = HashSet::new();
    for entry in removed {
        let path = entry["path"].as_str().ok_or_else(invalid)?;
        let previous = by_path.get(&path.to_owned()).ok_or_else(invalid)?;
        if !removed_paths.insert(path)
            || candidate.contains_key(&path.to_owned())
            || number(&entry["bytes"]) != Some(previous.bytes)
            || entry["sha256"]
                .as_str()
                .is_none_or(|value| value.to_lowercase() != previous.sha256)
        {
            return Err(invalid());
        }
    }
    for entry in &pack.entries {
        if by_path
            .get(&entry.path)
            .is_some_and(|before| before.bytes == entry.bytes && before.sha256 == entry.sha256)
        {
            return Err(invalid());
        }
    }
    let mut target = base
        .entries
        .iter()
        .filter(|entry| !removed_paths.contains(entry.path.as_str()))
        .map(|entry| candidate.get(&entry.path).copied().unwrap_or(entry).clone())
        .collect::<Vec<_>>();
    target.extend(
        pack.entries
            .iter()
            .filter(|entry| !by_path.contains_key(&entry.path))
            .cloned(),
    );
    let target =
        Manifest::parse(&json!({"schemaVersion":1,"entries":target})).map_err(|_| invalid())?;
    if !identity(&delta["newManifest"], &target) {
        return Err(invalid());
    }
    let added = pack
        .entries
        .iter()
        .filter(|entry| !by_path.contains_key(&entry.path))
        .count();
    let changed = pack.entries.len() - added;
    let removed = removed_paths.len();
    let unchanged = base.entries.len() - removed - changed;
    for (key, count) in [
        ("added", added),
        ("changed", changed),
        ("removed", removed),
        ("unchanged", unchanged),
    ] {
        if number(&delta["totals"][key]) != Some(count as u64) {
            return Err(invalid());
        }
    }
    if number(&delta["candidate"]["files"]) != Some(pack.entries.len() as u64)
        || number(&delta["candidate"]["bytes"]) != Some(pack.bytes())
        || delta["candidate"]["zeroAssets"] != pack.entries.is_empty()
    {
        return Err(invalid());
    }
    Ok(target)
}
