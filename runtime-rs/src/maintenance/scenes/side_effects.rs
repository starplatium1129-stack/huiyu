use super::*;
fn write(tx: &Transaction, file: &Path, value: &Value) -> Result<()> {
    tx.write(file, blueprints::json_text(value).as_bytes())
}
pub(in crate::maintenance) fn clean_refs(
    root: &Path,
    scenes: &[Value],
    tx: &Transaction,
) -> Result<()> {
    let ids = scenes
        .iter()
        .filter_map(|scene| scene["id"].as_str())
        .collect::<HashSet<_>>();
    let file = root.join("data/characters.json");
    let mut characters = fs::json(&file)?;
    let mut changed = false;
    for character in characters
        .as_array_mut()
        .ok_or_else(|| Error::invalid("characters.json 必须为数组"))?
    {
        if let Some(recommended) = character["lora"]["recommended_scene"].as_array_mut() {
            let before = recommended.len();
            recommended.retain(|id| id.as_str().is_some_and(|id| ids.contains(id)));
            changed |= before != recommended.len();
        }
    }
    if changed {
        write(tx, &file, &characters)?;
    }
    let file = root.join("data/loras.json");
    let mut loras = fs::json(&file)?;
    let mut changed = false;
    for lora in loras
        .as_array_mut()
        .ok_or_else(|| Error::invalid("loras.json 必须为数组"))?
    {
        let related = if prompt::truthy(&lora["related_scenes"]) {
            &lora["related_scenes"]
        } else {
            &lora["scenes"]
        };
        if let Some(related) = related.as_array() {
            let filtered = related
                .iter()
                .filter(|id| id.as_str().is_some_and(|id| ids.contains(id)))
                .cloned()
                .collect::<Vec<_>>();
            if filtered.len() != related.len() {
                if prompt::truthy(&lora["related_scenes"]) {
                    lora["related_scenes"] = json!(filtered);
                }
                if prompt::truthy(&lora["scenes"]) {
                    lora["scenes"] = json!(filtered);
                }
                changed = true;
            }
        }
    }
    if changed {
        write(tx, &file, &loras)?;
    }
    let file = root.join("data/curation.json");
    let curation = super::super::validation::curation(&fs::json(&file)?, &ids, &Value::Null)?;
    write(tx, &file, &curation)
}
pub(in crate::maintenance) fn retire(
    options: &Options,
    before: &[Value],
    after: &[Value],
    tx: &Transaction,
) -> Result<Vec<String>> {
    let active = after
        .iter()
        .filter_map(|scene| scene["id"].as_str())
        .collect::<HashSet<_>>();
    let file = options.root.join("data/retired-scenes.json");
    let mut data = fs::json(&file)?;
    let mut records = data["records"].as_array().cloned().unwrap_or_default();
    let retired = records
        .iter()
        .filter_map(|record| record["id"].as_str())
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    let mut added = Vec::new();
    for scene in before {
        let id = scene["id"].as_str().unwrap();
        if !active.contains(id) && !retired.contains(id) {
            records.push(json!({"id":id,"retiredAt":super::super::codec::timestamp().split('T').next().unwrap(),"reason":"在场景管理中下架"}));
            added.push(id.to_owned());
        }
    }
    if added.is_empty() {
        return Ok(added);
    }
    data["records"] = json!(records);
    write(tx, &file, &data)?;
    if let Some(showcase) = &options.showcase {
        for id in &added {
            for folder in ["images", "thumbs"] {
                for extension in ["jpg", "png", "webp"] {
                    let path = showcase.join(folder).join(format!("{id}.{extension}"));
                    if fs::safe(&path, false, true)?.is_some() {
                        tx.remove(&path)?;
                    }
                }
            }
        }
        let file = showcase.join("manifest.json");
        if fs::safe(&file, false, true)?.is_some() {
            let mut manifest = fs::json(&file)?;
            if let Some(entries) = manifest["entries"].as_array_mut() {
                entries.retain(|entry| {
                    !entry["id"]
                        .as_str()
                        .is_some_and(|id| added.iter().any(|removed| removed == id))
                });
                let count = entries.len();
                manifest["entryCount"] = count.into();
                manifest["sceneCount"] = count.into();
                write(tx, &file, &manifest)?;
            }
        }
    }
    Ok(added)
}
