use super::*;
use std::collections::BTreeMap;
fn read(root: &Path, file: &str) -> Result<Value> {
    Ok(serde_json::from_slice(&std::fs::read(
        root.join("data").join(file),
    )?)?)
}
fn legacy_rows(root: &Path, folder: &str, field: &str) -> Result<Vec<Value>> {
    let manifest = read(root, &format!("{folder}/manifest.json"))?;
    let files = manifest["files"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("旧分片清单无效"))?;
    let mut result = Vec::new();
    for entry in files {
        let name = entry["file"]
            .as_str()
            .ok_or_else(|| ApiError::invalid("旧分片文件无效"))?;
        if name.contains(['/', '\\']) || name.starts_with('.') {
            return Err(ApiError::invalid("旧分片路径无效"));
        }
        let value = read(root, &format!("{folder}/{name}"))?;
        result.extend(
            value[field]
                .as_array()
                .ok_or_else(|| ApiError::invalid("旧分片内容无效"))?
                .iter()
                .cloned(),
        );
    }
    Ok(result)
}
fn record(kind: &str, id: String, data: Value, order: usize) -> Record {
    Record {
        kind: kind.into(),
        id,
        revision: 1,
        sort_order: order as i64,
        created_at: None,
        updated_at: None,
        data,
    }
}
pub(super) fn legacy(root: &Path) -> Result<Vec<Record>> {
    let profiles = read(root, "characters.json")?;
    let profiles = profiles
        .as_array()
        .ok_or_else(|| ApiError::invalid("人物档案无效"))?;
    let mut characters = BTreeMap::<String, Value>::new();
    let mut order = Vec::new();
    for profile in profiles {
        let id = profile["id"]
            .as_str()
            .ok_or_else(|| ApiError::invalid("人物 ID 无效"))?
            .to_owned();
        if characters
            .insert(id.clone(), json!({"id":id,"profile":profile}))
            .is_some()
        {
            return Err(ApiError::invalid("人物 ID 重复"));
        }
        order.push(id);
    }
    let mut outfits = Vec::new();
    for mut popular in legacy_rows(root, "popular", "characters")? {
        let id = popular["id"]
            .as_str()
            .ok_or_else(|| ApiError::invalid("热门角色 ID 无效"))?
            .to_owned();
        let values = popular
            .as_object_mut()
            .unwrap()
            .remove("outfits")
            .ok_or_else(|| ApiError::invalid("角色服装缺失"))?;
        for outfit in values
            .as_array()
            .ok_or_else(|| ApiError::invalid("服装数组无效"))?
        {
            let outfit_id = outfit["id"]
                .as_str()
                .ok_or_else(|| ApiError::invalid("服装 ID 无效"))?;
            outfits.push(record(
                "outfit",
                format!("{id}/{outfit_id}"),
                json!({"characterId":id,"outfit":outfit}),
                outfits.len(),
            ));
        }
        if !characters.contains_key(&id) {
            order.push(id.clone());
        }
        characters
            .entry(id.clone())
            .or_insert_with(|| json!({"id":id}))["popular"] = popular;
    }
    let mut records = order
        .iter()
        .enumerate()
        .map(|(index, id)| {
            record(
                "character",
                id.clone(),
                characters.remove(id).unwrap(),
                index,
            )
        })
        .collect::<Vec<_>>();
    records.extend(outfits);
    let (_, scenes) = crate::maintenance::state::load_scenes(root)
        .map_err(|e| ApiError::new(e.status.as_u16(), e.code, e.message))?;
    for (kind, rows) in [
        ("scene", scenes),
        ("blueprint", legacy_rows(root, "blueprints", "blueprints")?),
    ] {
        for (index, value) in rows.into_iter().enumerate() {
            records.push(record(
                kind,
                value["id"]
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("场景 ID 无效"))?
                    .into(),
                value,
                index,
            ));
        }
    }
    for name in ["curation", "tags", "prompt-pinned-scenes", "retired-scenes"] {
        let path = root.join("data").join(format!("{name}.json"));
        let value = if path.exists() {
            read(root, &format!("{name}.json"))?
        } else if name == "retired-scenes" {
            json!({"version":1,"records":[]})
        } else {
            return Err(ApiError::invalid(format!("缺少 {name}")));
        };
        records.push(record("document", name.into(), value, 0));
    }
    if root.join("data/loras.json").is_file() {
        records.push(record(
            "document",
            "loras".into(),
            read(root, "loras.json")?,
            0,
        ));
    }
    if root.join("data/tags/manifest.json").is_file() {
        records.push(record(
            "document",
            "tag-dictionary-policy".into(),
            read(root, "tags/manifest.json")?
                .get("dictionary")
                .cloned()
                .unwrap_or(json!({})),
            0,
        ));
    }
    Ok(records)
}
impl Catalog {
    pub(super) fn initialize(&mut self) -> Result<()> {
        let snapshot = self.options.source.join("data/catalog");
        let (records, retired) = if snapshot.join("manifest.json").exists() {
            snapshots::read(&snapshot)?
        } else {
            (legacy(&self.options.source)?, Vec::new())
        };
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if transaction.query_row(
            "SELECT count(*) FROM catalog_meta WHERE key='schema'",
            [],
            |r| r.get::<_, i64>(0),
        )? > 0
        {
            return Ok(());
        }
        let batch = "migration";
        let at = now();
        for (record, removed) in records
            .iter()
            .map(|r| (r, false))
            .chain(retired.iter().map(|r| (r, true)))
        {
            validation::key(&record.kind, &record.id)?;
            write::put(&transaction, record, removed)?;
            write::history(&transaction, record, removed, batch, &at)?;
            transaction.execute(
                "INSERT INTO content_seed(kind,id,record,deleted) VALUES(?1,?2,?3,?4)",
                params![
                    record.kind,
                    record.id,
                    serde_json::to_string(record)?,
                    removed
                ],
            )?;
        }
        transaction.execute("INSERT INTO catalog_meta(key,value) VALUES('schema','1'),('version','1'),('importedAt',?1)",[at])?;
        // Initial import preserves legacy content exactly. Editing subsequently
        // validates the affected relationships; no normalizer rewrites the seed.
        transaction.commit()?;
        Ok(())
    }
}
