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
fn export_io_error(from: &Path, to: &Path, error: std::io::Error) -> ApiError {
    ApiError::new(
        503,
        "CATALOG_EXPORT_IO",
        format!(
            "快照目录切换失败 {} → {}：{error}",
            from.display(),
            to.display()
        ),
    )
}
fn rename_export_raw(from: &Path, to: &Path) -> std::io::Result<()> {
    const RETRY_DELAYS_MS: [u64; 6] = [50, 100, 200, 300, 400, 500];
    for delay_ms in RETRY_DELAYS_MS {
        match std::fs::rename(from, to) {
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            }
            result => return result,
        }
    }
    std::fs::rename(from, to)
}
fn rename_export(from: &Path, to: &Path) -> Result<()> {
    rename_export_raw(from, to).map_err(|error| export_io_error(from, to, error))
}
#[cfg(windows)]
fn sync_export_in_place(
    staging: &Path,
    directory: &Path,
    files: &[String],
    changed: &std::collections::HashSet<String>,
    before: &SnapshotIdentity,
) -> Result<()> {
    let new_files: std::collections::HashSet<&str> = files.iter().map(String::as_str).collect();
    for name in files {
        let dst = directory.join(name);
        if changed.contains(name) || !dst.exists() {
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            rename_export(&staging.join(name), &dst)?;
        }
    }
    rename_export(
        &staging.join("manifest.json"),
        &directory.join("manifest.json"),
    )?;
    for (output_name, (original, _)) in &before.files {
        if !new_files.contains(output_name.as_str()) || original != output_name {
            match std::fs::remove_file(directory.join(original)) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
                _ => {}
            }
        }
    }
    Ok(())
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
#[derive(Default)]
struct SnapshotIdentity {
    manifest: [u8; 32],
    // Index by the output name, retaining the actual name listed in the input manifest.
    files: std::collections::HashMap<String, (String, [u8; 32])>,
}

impl SnapshotIdentity {
    fn matches(&self, directory: &Path) -> Result<bool> {
        let digest = |name: &str| -> Result<[u8; 32]> {
            let mut file = std::fs::File::open(directory.join(name))?;
            let mut hash = Sha256::new();
            std::io::copy(&mut file, &mut hash)?;
            Ok(hash.finalize().into())
        };
        if self.manifest != digest("manifest.json")? {
            return Ok(false);
        }
        for (name, expected) in self.files.values() {
            if *expected != digest(name)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn export_conflict() -> ApiError {
    ApiError::new(
        409,
        "CATALOG_EXPORT_CONFLICT",
        "目标快照在导出期间改变，未覆盖目标；请重新读取后导出",
    )
}
impl Scope {
    fn partial(&self) -> bool {
        !self.characters.is_empty() || !self.records.is_empty()
    }
}
pub(super) fn read(directory: &Path) -> Result<(Vec<Record>, Vec<Record>)> {
    read_snapshot(directory, None)
}
fn read_snapshot(
    directory: &Path,
    mut identity: Option<&mut SnapshotIdentity>,
) -> Result<(Vec<Record>, Vec<Record>)> {
    let manifest_bytes = std::fs::read(directory.join("manifest.json"))?;
    if let Some(identity) = identity.as_deref_mut() {
        identity.manifest = Sha256::digest(&manifest_bytes).into();
    }
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
        let record: Record = serde_json::from_slice(&bytes)?;
        validation::key(&record.kind, &record.id)?;
        if record.revision < 1 || !seen.insert((record.kind.clone(), record.id.clone())) {
            return Err(ApiError::invalid("快照 ID 重复或修订无效"));
        }
        if let Some(identity) = identity.as_deref_mut() {
            let key = snapshot_name(&record.kind, &record.id);
            if identity
                .files
                .insert(key, (name.to_owned(), Sha256::digest(&bytes).into()))
                .is_some()
            {
                return Err(ApiError::invalid("导出文件名冲突"));
            }
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
    Ok((records, retired))
}
impl Catalog {
    pub(crate) fn matches_bundled_records(
        &self,
        directory: &Path,
        keys: &[[String; 2]],
    ) -> Result<bool> {
        let transaction = self.connection.unchecked_transaction()?;
        for [kind, id] in keys {
            validation::key(kind, id)?;
            let path = directory.join(snapshot_name(kind, id));
            let expected: Record = serde_json::from_reader(std::fs::File::open(path)?)?;
            if expected.kind != *kind
                || expected.id != *id
                || self.get(kind, id)?.data != expected.data
            {
                return Ok(false);
            }
        }
        transaction.commit()?;
        Ok(true)
    }

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
            let mut identity = SnapshotIdentity::default();
            let (previous, previous_retired) = read_snapshot(directory, Some(&mut identity))?;
            original_fingerprint = Some(identity);
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
                    // An unknown creation date may be backfilled independently of content.
                    // Keep the project's established creation date on later content edits.
                    if before.created_at.is_some() {
                        record.created_at.clone_from(&before.created_at);
                    }
                    if super::provenance::same(before, &record)
                        && *was_removed == removed
                        && before.created_at == record.created_at
                    {
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
                changed.insert(snapshot_name(&record.kind, &record.id));
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
        source_snapshot.commit()?;
        std::fs::create_dir(&staging)?;
        let _staging_cleanup = Staging(staging.clone());
        let mut files = Vec::new();
        for record in records {
            let name = snapshot_name(&record.kind, &record.id);
            std::fs::create_dir_all(staging.join(&record.kind))?;
            if !changed.contains(&name)
                && let Some((original, expected)) = original_fingerprint
                    .as_ref()
                    .and_then(|source| source.files.get(&name))
            {
                let source = directory.join(original);
                let bytes = std::fs::read(&source)?;
                if <[u8; 32]>::from(Sha256::digest(&bytes)) != *expected {
                    return Err(export_conflict());
                }
                let destination = staging.join(&name);
                std::fs::write(&destination, bytes)?;
                std::fs::set_permissions(destination, source.metadata()?.permissions())?;
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
        if let Some(before) = original_fingerprint.as_ref() {
            if !directory.exists() || !before.matches(directory)? {
                return Err(export_conflict());
            }
        } else if directory.exists() {
            return Err(ApiError::new(
                409,
                "CATALOG_EXPORT_CONFLICT",
                "导出目标已由其他操作创建，未覆盖目标；请重新选择目录",
            ));
        }
        let backup = parent.join(format!(".catalog-export-backup-{}", uuid::Uuid::new_v4()));
        let mut fallback_in_place = false;
        if directory.exists() {
            match rename_export_raw(directory, &backup) {
                Ok(()) => {}
                #[cfg(windows)]
                Err(error)
                    if error.kind() == std::io::ErrorKind::PermissionDenied
                        && original_fingerprint.is_some() =>
                {
                    sync_export_in_place(
                        &staging,
                        directory,
                        &files,
                        &changed,
                        original_fingerprint.as_ref().unwrap(),
                    )?;
                    fallback_in_place = true;
                }
                Err(error) => return Err(export_io_error(directory, &backup, error)),
            }
        }
        if !fallback_in_place && let Err(error) = rename_export(&staging, directory) {
            if backup.exists() {
                rename_export(&backup, directory)?;
            }
            return Err(error.into());
        }
        let cleanup_warning = if !fallback_in_place && backup.exists() {
            std::fs::remove_dir_all(&backup).err().map(|error| {
                format!(
                    "快照已导出，旧目录清理失败，备份保留于 {}：{error}",
                    backup.display()
                )
            })
        } else {
            None
        };
        Ok(
            json!({"ok":true,"count":count,"total":files.len(),"partial":scope.partial(),"directory":directory,"version":version,"cleanupWarning":cleanup_warning}),
        )
    }
}

fn snapshot_name(kind: &str, id: &str) -> String {
    let digest = hex::encode(Sha256::digest(id.as_bytes()));
    let label: String = id
        .chars()
        .take(120)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("{kind}/{label}-{}.json", &digest[..12])
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
