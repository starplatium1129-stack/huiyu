use super::*;
use sha2::{Digest, Sha256};
#[derive(Default)]
pub(super) struct Scope {
    pub characters: Vec<String>,
    pub records: Vec<(String, String)>,
}
impl Scope {
    fn partial(&self) -> bool {
        !self.characters.is_empty() || !self.records.is_empty()
    }
}
pub(super) fn read(directory: &Path) -> Result<(Vec<Record>, Vec<Record>)> {
    let manifest: Value = serde_json::from_slice(&std::fs::read(directory.join("manifest.json"))?)?;
    if manifest["version"] != 1 {
        return Err(ApiError::invalid("快照格式版本无效"));
    }
    let mut records = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in manifest["files"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("快照清单缺少 files"))?
    {
        let name = entry
            .as_str()
            .ok_or_else(|| ApiError::invalid("快照文件名无效"))?;
        if !name.ends_with(".json")
            || name.contains(['\\', ':'])
            || name.split('/').any(|p| p.is_empty() || p.starts_with('.'))
        {
            return Err(ApiError::invalid("快照路径无效"));
        }
        let record: Record = serde_json::from_slice(&std::fs::read(directory.join(name))?)?;
        validation::key(&record.kind, &record.id)?;
        if record.revision < 1 || !seen.insert((record.kind.clone(), record.id.clone())) {
            return Err(ApiError::invalid("快照 ID 重复或修订无效"));
        }
        records.push(record);
    }
    let retired: Vec<Record> =
        serde_json::from_value(manifest.get("retired").cloned().unwrap_or(json!([])))?;
    for record in &retired {
        validation::key(&record.kind, &record.id)?;
        if record.revision < 1 || !seen.insert((record.kind.clone(), record.id.clone())) {
            return Err(ApiError::invalid("退役记录 ID 重复或修订无效"));
        }
    }
    Ok((records, retired))
}
impl Catalog {
    pub fn snapshot(&self) -> Result<Value> {
        self.snapshot_selected(&Scope::default())
    }
    pub(super) fn snapshot_selected(&self, scope: &Scope) -> Result<Value> {
        let transaction = self.connection.unchecked_transaction()?;
        let mut filters = Vec::new();
        let mut values = Vec::<String>::new();
        for id in &scope.characters {
            validation::key("character", id)?;
            let exists: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM content_records WHERE kind='character' AND id=?1)",
                [id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(ApiError::invalid(format!("人物不存在：{id}")));
            }
            values.push(id.clone());
            filters.push(format!("character_id=?{}", values.len()));
        }
        for (kind, id) in &scope.records {
            validation::key(kind, id)?;
            let exists: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM content_records WHERE kind=?1 AND id=?2)",
                params![kind, id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(ApiError::invalid(format!("记录不存在：{kind}:{id}")));
            }
            values.extend([kind.clone(), id.clone()]);
            filters.push(format!(
                "(kind=?{} AND id=?{})",
                values.len() - 1,
                values.len()
            ));
        }
        let filter = if filters.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", filters.join(" OR "))
        };
        let mut statement = self.connection.prepare(&format!(
            "SELECT {COLUMNS},deleted FROM content_records{filter} ORDER BY kind,sort_order,id"
        ))?;
        let mut records = Vec::new();
        let mut retired = Vec::new();
        for result in statement.query_map(rusqlite::params_from_iter(values), |r| {
            Ok((row(r)?, r.get::<_, bool>(7)?))
        })? {
            let (record, removed) = result?;
            if removed {
                retired.push(record);
            } else {
                records.push(record);
            }
        }
        let value = json!({"version":1,"records":records,"retired":retired});
        transaction.commit()?;
        Ok(value)
    }
    pub fn export(&self, directory: &Path) -> Result<Value> {
        self.export_selected(directory, &Scope::default())
    }
    pub(super) fn export_selected(&self, directory: &Path, scope: &Scope) -> Result<Value> {
        if directory.exists() && !directory.join("manifest.json").exists() {
            return Err(ApiError::invalid("导出目录已被其他内容占用"));
        }
        let parent = directory
            .parent()
            .ok_or_else(|| ApiError::invalid("导出路径无效"))?;
        std::fs::create_dir_all(parent)?;
        let staging = parent.join(format!(".catalog-export-{}", uuid::Uuid::new_v4()));
        let mut snapshot = self.snapshot_selected(scope)?;
        let count = snapshot["records"].as_array().unwrap().len();
        if scope.partial() && directory.exists() {
            // Merge only the selected records into the project's existing export,
            // never copy unrelated personal database records over that snapshot.
            let (records, retired) = read(directory)?;
            let mut merged = std::collections::BTreeMap::new();
            for (record, removed) in records
                .into_iter()
                .map(|r| (r, false))
                .chain(retired.into_iter().map(|r| (r, true)))
            {
                merged.insert((record.kind.clone(), record.id.clone()), (record, removed));
            }
            for (field, removed) in [("records", false), ("retired", true)] {
                for value in snapshot[field].as_array().unwrap() {
                    let record: Record = serde_json::from_value(value.clone())?;
                    merged.insert((record.kind.clone(), record.id.clone()), (record, removed));
                }
            }
            let mut records = Vec::new();
            let mut retired = Vec::new();
            for (record, removed) in merged.into_values() {
                if removed {
                    retired.push(record);
                } else {
                    records.push(record);
                }
            }
            snapshot = json!({"version":1,"records":records,"retired":retired});
        }
        std::fs::create_dir(&staging)?;
        let mut files = Vec::new();
        for value in snapshot["records"].as_array().unwrap() {
            let record: Record = serde_json::from_value(value.clone())?;
            let digest = hex::encode(Sha256::digest(record.id.as_bytes()));
            // Readable stable names, including Windows-safe outfit keys. Hash
            // suffix prevents sanitization/case collisions on Windows.
            let label = record
                .id
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                        c
                    } else {
                        '-'
                    }
                })
                .take(120)
                .collect::<String>();
            let name = format!("{}/{}-{}.json", record.kind, label, &digest[..12]);
            std::fs::create_dir_all(staging.join(&record.kind))?;
            std::fs::write(
                staging.join(&name),
                format!("{}\n", serde_json::to_string_pretty(&record)?),
            )?;
            files.push(name);
        }
        files.sort();
        std::fs::write(
            staging.join("manifest.json"),
            format!(
                "{}\n",
                serde_json::to_string_pretty(
                    &json!({"version":1,"files":files,"retired":snapshot["retired"]})
                )?
            ),
        )?;
        let backup = parent.join(format!(".catalog-export-backup-{}", uuid::Uuid::new_v4()));
        if directory.exists() {
            std::fs::rename(directory, &backup)?;
        }
        if let Err(error) = std::fs::rename(&staging, directory) {
            if backup.exists() {
                std::fs::rename(&backup, directory)?;
            }
            return Err(error.into());
        }
        if backup.exists() {
            std::fs::remove_dir_all(&backup)?;
        }
        Ok(
            json!({"ok":true,"count":count,"total":files.len(),"partial":scope.partial(),"directory":directory,"version":self.version()?}),
        )
    }
}
