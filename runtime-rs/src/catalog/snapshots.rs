mod publication;

use super::*;
use sha2::{Digest, Sha256};
#[derive(Default)]
pub(super) struct Scope {
    pub characters: Vec<String>,
    pub records: Vec<(String, String)>,
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
