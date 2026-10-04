use super::*;
use sha2::{Digest, Sha256};
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
        let transaction = self.connection.unchecked_transaction()?;
        let mut records = Vec::new();
        for kind in KINDS {
            records.extend(self.records(kind)?);
        }
        let mut retired = self.connection.prepare(&format!(
            "SELECT {COLUMNS} FROM content_records WHERE deleted=1 ORDER BY kind,id"
        ))?;
        let retired = retired
            .query_map([], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let value = json!({"version":1,"records":records,"retired":retired});
        transaction.commit()?;
        Ok(value)
    }
    pub fn export(&self, directory: &Path) -> Result<Value> {
        if directory.exists() && !directory.join("manifest.json").exists() {
            return Err(ApiError::invalid("导出目录已被其他内容占用"));
        }
        let parent = directory
            .parent()
            .ok_or_else(|| ApiError::invalid("导出路径无效"))?;
        std::fs::create_dir_all(parent)?;
        let staging = parent.join(format!(".catalog-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&staging)?;
        let snapshot = self.snapshot()?;
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
        Ok(json!({"ok":true,"count":files.len(),"directory":directory,"version":self.version()?}))
    }
}
