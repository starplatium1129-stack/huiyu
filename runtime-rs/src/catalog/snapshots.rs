use super::*;
use sha2::{Digest, Sha256};
use std::io::{BufWriter, Write};
#[derive(Default)]
pub(super) struct Scope {
    pub characters: Vec<String>,
    pub records: Vec<(String, String)>,
}
#[derive(Serialize)]
struct ExportManifest<'a> {
    version: u8,
    files: &'a [String],
    retired: &'a [Record],
}
fn write_export(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut file = BufWriter::new(std::fs::File::create(path)?);
    serde_json::to_writer_pretty(&mut file, value).map_err(|error| {
        if error.is_io() {
            ApiError::from(std::io::Error::from(error))
        } else {
            ApiError::from(error)
        }
    })?;
    file.write_all(b"\n")?;
    file.flush()?;
    Ok(())
}
fn rename_export(from: &Path, to: &Path) -> Result<()> {
    std::fs::rename(from, to).map_err(|error| {
        ApiError::new(
            503,
            "CATALOG_EXPORT_IO",
            format!(
                "快照目录切换失败 {} → {}：{error}",
                from.display(),
                to.display()
            ),
        )
    })
}
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        // Only our UUID staging directory is removed, never the published target or backup.
        if self.0.exists() {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
fn fingerprint(directory: &Path) -> Result<Vec<u8>> {
    Ok(read_snapshot(directory)?.2)
}
impl Scope {
    fn partial(&self) -> bool {
        !self.characters.is_empty() || !self.records.is_empty()
    }
}
pub(super) fn read(directory: &Path) -> Result<(Vec<Record>, Vec<Record>)> {
    let (records, retired, _) = read_snapshot(directory)?;
    Ok((records, retired))
}
fn read_snapshot(directory: &Path) -> Result<(Vec<Record>, Vec<Record>, Vec<u8>)> {
    let manifest_bytes = std::fs::read(directory.join("manifest.json"))?;
    let mut digest = Sha256::new();
    digest.update(&manifest_bytes);
    let mut manifest: Value = serde_json::from_slice(&manifest_bytes)?;
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
        let bytes = std::fs::read(directory.join(name))?;
        digest.update(&bytes);
        let record: Record = serde_json::from_slice(&bytes)?;
        validation::key(&record.kind, &record.id)?;
        if record.revision < 1 || !seen.insert((record.kind.clone(), record.id.clone())) {
            return Err(ApiError::invalid("快照 ID 重复或修订无效"));
        }
        records.push(record);
    }
    let retired: Vec<Record> = serde_json::from_value(
        manifest
            .get_mut("retired")
            .map(Value::take)
            .unwrap_or(json!([])),
    )?;
    for record in &retired {
        validation::key(&record.kind, &record.id)?;
        if record.revision < 1 || !seen.insert((record.kind.clone(), record.id.clone())) {
            return Err(ApiError::invalid("退役记录 ID 重复或修订无效"));
        }
    }
    Ok((records, retired, digest.finalize().to_vec()))
}
impl Catalog {
    pub fn snapshot(&self) -> Result<Value> {
        self.snapshot_selected(&Scope::default())
    }
    pub(super) fn snapshot_selected(&self, scope: &Scope) -> Result<Value> {
        let (records, retired) = self.snapshot_records(scope)?;
        snapshot_value(records, retired)
    }
    fn snapshot_records(&self, scope: &Scope) -> Result<(Vec<Record>, Vec<Record>)> {
        let transaction = self
            .connection
            .is_autocommit()
            .then(|| self.connection.unchecked_transaction())
            .transpose()?;
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
        if let Some(transaction) = transaction {
            transaction.commit()?;
        }
        Ok((records, retired))
    }
    pub(super) fn export_selected(&self, directory: &Path, scope: &Scope) -> Result<Value> {
        if directory.exists() && !directory.join("manifest.json").exists() {
            return Err(ApiError::invalid("导出目录已被其他内容占用"));
        }
        let parent = directory
            .parent()
            .ok_or_else(|| ApiError::invalid("导出路径无效"))?;
        std::fs::create_dir_all(parent)?;
        let _export_lock = crate::file_lock::try_lock(&parent.join(".catalog-export.lock"))
            .map_err(|error| {
                ApiError::new(
                    409,
                    "CATALOG_EXPORT_BUSY",
                    format!("此目录正在导出或不可写；请等待当前导出完成后重试：{error}"),
                )
            })?;
        if directory.exists() && !scope.partial() {
            return Err(ApiError::new(
                409,
                "CATALOG_EXPORT_SCOPE_REQUIRED",
                "更新已有快照必须使用 --record 或 --character 指定范围；全库备份请导出到新的目录，不能整库覆盖项目",
            ));
        }
        let source_snapshot = self.connection.unchecked_transaction()?;
        let version = self.version()?;
        let staging = parent.join(format!(".catalog-export-{}", uuid::Uuid::new_v4()));
        let (mut records, mut retired) = self.snapshot_records(scope)?;
        let count = records.len();
        let mut original_fingerprint = None;
        let mut changed = std::collections::HashSet::new();
        if scope.partial() && directory.exists() {
            // Merge only the selected records into the project's existing export,
            // never copy unrelated personal database records over that snapshot.
            let (previous, previous_retired, digest) = read_snapshot(directory)?;
            original_fingerprint = Some(digest);
            let mut merged = std::collections::BTreeMap::new();
            for (record, removed) in previous
                .into_iter()
                .map(|r| (r, false))
                .chain(previous_retired.into_iter().map(|r| (r, true)))
            {
                merged.insert((record.kind.clone(), record.id.clone()), (record, removed));
            }
            for (mut record, removed) in records
                .into_iter()
                .map(|r| (r, false))
                .chain(retired.into_iter().map(|r| (r, true)))
            {
                let key = (record.kind.clone(), record.id.clone());
                if let Some((before, was_removed)) = merged.get(&key) {
                    super::provenance::export_ancestor(
                        &self.connection,
                        before,
                        *was_removed,
                        &record,
                        removed,
                    )?;
                    if super::provenance::same(before, &record) && *was_removed == removed {
                        continue;
                    }
                    // The project revision is an upstream publication counter.
                    // A local database imported from it can have a lower edit
                    // counter; ancestry is proved above by content, not numbers.
                    record.revision = record.revision.max(
                        before
                            .revision
                            .checked_add(1)
                            .ok_or_else(|| ApiError::invalid("项目快照修订已用尽"))?,
                    );
                }
                if !removed {
                    let project_policy = parent.join("prompt-pinned-scenes.json");
                    let source_policy = self.options.source.join("data/prompt-pinned-scenes.json");
                    super::provenance::export_pins(
                        &record,
                        if project_policy.is_file() {
                            &project_policy
                        } else {
                            &source_policy
                        },
                    )?;
                }
                changed.insert(key.clone());
                merged.insert(key, (record, removed));
            }
            records = Vec::new();
            retired = Vec::new();
            for (record, removed) in merged.into_values() {
                if removed {
                    retired.push(record);
                } else {
                    records.push(record);
                }
            }
        }
        std::fs::create_dir(&staging)?;
        let _staging_cleanup = Staging(staging.clone());
        let mut files = Vec::new();
        for record in records {
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
            let original = directory.join(&name);
            if original_fingerprint.is_some()
                && !changed.contains(&(record.kind.clone(), record.id.clone()))
                && original.is_file()
            {
                std::fs::copy(original, staging.join(&name))?;
            } else {
                write_export(&staging.join(&name), &record)?;
            }
            files.push(name);
        }
        files.sort();
        let manifest = ExportManifest {
            version: 1,
            files: &files,
            retired: &retired,
        };
        write_export(&staging.join("manifest.json"), &manifest)?;
        if let Some(before) = original_fingerprint {
            if !directory.exists() || fingerprint(directory)? != before {
                return Err(ApiError::new(
                    409,
                    "CATALOG_EXPORT_CONFLICT",
                    "目标快照在导出期间改变，未覆盖目标；请重新读取后导出",
                ));
            }
        } else if directory.exists() {
            return Err(ApiError::new(
                409,
                "CATALOG_EXPORT_CONFLICT",
                "导出目标已由其他操作创建，未覆盖目标；请重新选择目录",
            ));
        }
        let backup = parent.join(format!(".catalog-export-backup-{}", uuid::Uuid::new_v4()));
        if directory.exists() {
            rename_export(directory, &backup)?;
        }
        if let Err(error) = rename_export(&staging, directory) {
            if backup.exists() {
                rename_export(&backup, directory)?;
            }
            return Err(error.into());
        }
        let cleanup_warning = if backup.exists() {
            std::fs::remove_dir_all(&backup).err().map(|error| {
                format!(
                    "快照已导出，旧目录清理失败，备份保留于 {}：{error}",
                    backup.display()
                )
            })
        } else {
            None
        };
        source_snapshot.commit()?;
        Ok(
            json!({"ok":true,"count":count,"total":files.len(),"partial":scope.partial(),"directory":directory,"version":version,"cleanupWarning":cleanup_warning}),
        )
    }
}
fn snapshot_value(records: Vec<Record>, retired: Vec<Record>) -> Result<Value> {
    let mut value = json!({"version":1,"records":null,"retired":null});
    for (field, records) in [("records", records), ("retired", retired)] {
        value[field] = Value::Array(
            records
                .into_iter()
                .map(Record::into_value)
                .collect::<serde_json::Result<Vec<_>>>()?,
        );
    }
    Ok(value)
}
