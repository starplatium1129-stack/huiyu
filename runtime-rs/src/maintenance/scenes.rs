mod products;
mod side_effects;
#[cfg(test)]
mod tests;
use super::{Error, Options, Result, blueprints, fs, prompt, state, transaction::Transaction};
pub(crate) use products::build as scene_products;
pub(super) use products::{aggregate, compressed_targets, refresh_compressed, sync_version};
use serde_json::{Value, json};
pub(super) use side_effects::{clean_refs, retire};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
};

pub(super) struct Plan {
    pub changes: Value,
    files: BTreeMap<String, Vec<Value>>,
    touched: BTreeSet<String>,
}
fn sorted(mut values: Vec<Value>) -> Vec<Value> {
    values.sort_by_key(|value| {
        state::scene_number(value["id"].as_str().unwrap_or("")).unwrap_or(u64::MAX)
    });
    values
}
fn target(scene: &Value) -> Result<String> {
    match scene["char"].as_str() {
        Some("triad") => Ok("shared.json".into()),
        Some(character @ ("nene" | "natsume")) => Ok(format!(
            "{character}-{}.json",
            if prompt::text(&scene["category"])
                .to_lowercase()
                .contains("after_story")
            {
                "after-story"
            } else {
                "core"
            }
        )),
        _ => Err(Error::invalid(format!(
            "{}: cannot choose shard for char",
            prompt::text(&scene["id"])
        ))),
    }
}
fn limit(manifest: &Value, entry: &Value) -> f64 {
    for item in [&entry["batchSize"], &manifest["batchSize"]] {
        let value = item
            .as_f64()
            .or_else(|| item.as_str().and_then(|item| item.parse::<f64>().ok()));
        if let Some(value) = value.filter(|value| value.is_finite() && *value > 0.0) {
            return value;
        }
    }
    50.0
}
fn append(
    manifest: &Value,
    scene: &Value,
    files: &mut BTreeMap<String, Vec<Value>>,
    entry_of: &mut HashMap<String, Value>,
    locations: &mut HashMap<String, (String, Value)>,
    touched: &mut BTreeSet<String>,
) -> Result<()> {
    let target = target(scene)?;
    let entry = manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["file"] == target)
        .ok_or_else(|| {
            Error::invalid(format!(
                "manifest does not declare a shard for scene {}",
                scene["id"]
            ))
        })?;
    let base = target.trim_end_matches(".json");
    let mut order = files
        .keys()
        .filter_map(|name| {
            name.strip_prefix(&format!("{base}."))
                .and_then(|suffix| suffix.strip_suffix(".json"))
                .and_then(|number| number.parse::<u64>().ok())
                .map(|number| (number, name.clone()))
        })
        .collect::<Vec<_>>();
    order.sort_by_key(|(number, _)| *number);
    let last = order
        .last()
        .map(|(_, name)| name.clone())
        .or_else(|| files.contains_key(&target).then(|| target.clone()));
    let Some(last) = last else {
        files.insert(target.clone(), vec![scene.clone()]);
        entry_of.insert(target.clone(), entry.clone());
        touched.insert(target);
        return Ok(());
    };
    if files[&last].len() as f64 >= limit(manifest, entry) {
        if last == target {
            let renamed = format!("{base}.1.json");
            let current = files.remove(&last).unwrap();
            for item in &current {
                if let Some(location) = locations.get_mut(item["id"].as_str().unwrap())
                    && location.0 == last
                {
                    location.0 = renamed.clone();
                }
            }
            files.insert(renamed.clone(), current);
            entry_of.remove(&last);
            entry_of.insert(renamed.clone(), entry.clone());
            touched.insert(last.clone());
            touched.insert(renamed);
        }
        let number = order.last().map(|(number, _)| number + 1).unwrap_or(2);
        let next = format!("{base}.{number}.json");
        files.insert(next.clone(), vec![scene.clone()]);
        entry_of.insert(next.clone(), entry.clone());
        touched.insert(next);
    } else {
        files.get_mut(&last).unwrap().push(scene.clone());
        touched.insert(last);
    }
    Ok(())
}
pub(super) fn plan(state: &state::State, incoming: &[Value]) -> Result<Plan> {
    let mut files = BTreeMap::new();
    let mut entry_of = HashMap::new();
    let mut locations = HashMap::new();
    let mut order = Vec::new();
    for source in &state.sources {
        files.insert(source.file.clone(), source.scenes.clone());
        entry_of.insert(source.file.clone(), source.entry.clone());
        for scene in &source.scenes {
            let id = scene["id"].as_str().unwrap().to_owned();
            locations.insert(id.clone(), (source.file.clone(), scene.clone()));
            order.push(id);
        }
    }
    let mut touched = BTreeSet::new();
    let (mut added, mut updated, mut removed) = (Vec::new(), Vec::new(), Vec::new());
    let mut incoming_ids = HashSet::new();
    for scene in incoming {
        let id = scene["id"]
            .as_str()
            .ok_or_else(|| Error::invalid("场景 ID 无效"))?;
        if !incoming_ids.insert(id) {
            return Err(Error::invalid("场景 ID 重复"));
        }
        let previous = locations.get(id).cloned();
        match previous {
            None => {
                if state.retired.contains(id) {
                    return Err(Error::invalid(format!("{id} 已退役，不能复用已退役身份")));
                }
                append(
                    &state.manifest,
                    scene,
                    &mut files,
                    &mut entry_of,
                    &mut locations,
                    &mut touched,
                )?;
                added.push(id.to_owned());
            }
            Some((file, before)) => {
                if crate::storage::stringify(&before) != crate::storage::stringify(scene) {
                    let expected = &entry_of[&file]["character"];
                    if prompt::truthy(expected) && scene["char"] != *expected {
                        files
                            .get_mut(&file)
                            .unwrap()
                            .retain(|item| item["id"] != id);
                        touched.insert(file);
                        append(
                            &state.manifest,
                            scene,
                            &mut files,
                            &mut entry_of,
                            &mut locations,
                            &mut touched,
                        )?;
                    } else {
                        let items = files.get_mut(&file).unwrap();
                        let index = items.iter().position(|item| item["id"] == id).unwrap();
                        items[index] = scene.clone();
                        touched.insert(file);
                    }
                    updated.push(id.to_owned());
                }
            }
        }
    }
    for id in order {
        if !incoming_ids.contains(id.as_str()) {
            let file = &locations[&id].0;
            files.get_mut(file).unwrap().retain(|item| item["id"] != id);
            touched.insert(file.clone());
            removed.push(id);
        }
    }
    added.sort();
    updated.sort();
    removed.sort();
    let changes =
        json!({"addedIds":added,"updatedIds":updated,"removedIds":removed,"touchedFiles":touched});
    Ok(Plan {
        changes,
        files,
        touched,
    })
}
impl Plan {
    pub(super) fn staged(&self, before: &state::State) -> state::State {
        let mut state = before.clone();
        state.sources.clear();
        for entry in state.manifest["files"].as_array().unwrap() {
            let base = entry["file"].as_str().unwrap().trim_end_matches(".json");
            let mut files = self
                .files
                .iter()
                .filter(|(name, _)| {
                    *name == entry["file"].as_str().unwrap()
                        || name
                            .strip_prefix(&format!("{base}."))
                            .and_then(|suffix| suffix.strip_suffix(".json"))
                            .is_some_and(|number| number.parse::<u64>().is_ok())
                })
                .collect::<Vec<_>>();
            files.sort_by_key(|(name, _)| {
                name.strip_prefix(&format!("{base}."))
                    .and_then(|suffix| suffix.strip_suffix(".json"))
                    .and_then(|number| number.parse::<u64>().ok())
                    .unwrap_or(0)
            });
            for (file, scenes) in files {
                state.sources.push(state::Source {
                    file: file.clone(),
                    entry: entry.clone(),
                    scenes: sorted(scenes.clone()),
                });
            }
        }
        state.value["snapshot"]["scenes"] = json!(sorted(
            state
                .sources
                .iter()
                .flat_map(|source| source.scenes.clone())
                .collect()
        ));
        state
    }
    pub(super) fn targets(&self, root: &Path) -> Vec<PathBuf> {
        self.touched
            .iter()
            .map(|file| root.join("data/scenes").join(file))
            .collect()
    }
    pub(super) fn apply(&self, root: &Path, tx: &Transaction) -> Result<()> {
        for file in &self.touched {
            let target = root.join("data/scenes").join(file);
            if let Some(scenes) = self.files.get(file) {
                tx.write(
                    &target,
                    blueprints::json_text(&json!(sorted(scenes.clone()))).as_bytes(),
                )?;
            } else {
                tx.remove(&target)?;
            }
        }
        Ok(())
    }
}
pub(super) fn snapshot_targets(
    options: &Options,
    plan: &Plan,
    removed: &[String],
) -> Result<Vec<PathBuf>> {
    let mut files = super::context::VERSIONED_FILES
        .iter()
        .flat_map(|file| {
            ["", ".gz", ".br"]
                .into_iter()
                .map(move |suffix| options.root.join("data").join(format!("{file}{suffix}")))
        })
        .collect::<Vec<_>>();
    files.push(options.root.join("data/retired-scenes.json"));
    files.push(options.root.join("src/stores/sceneStore.ts"));
    for entry in std::fs::read_dir(options.root.join("data/scenes"))? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().ends_with(".json") {
            files.push(entry.path());
        }
    }
    files.extend(plan.targets(&options.root));
    if let Some(showcase) = &options.showcase {
        files.push(showcase.join("manifest.json"));
        for id in removed {
            for folder in ["images", "thumbs"] {
                for ext in ["jpg", "png", "webp"] {
                    files.push(showcase.join(folder).join(format!("{id}.{ext}")));
                }
            }
        }
    }
    Ok(files)
}
