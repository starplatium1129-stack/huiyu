use super::{Error, Result, codec, context::Context, fs};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

pub(super) struct Entry {
    pub file: PathBuf,
    pub content: Option<PathBuf>,
    pub expected: Value,
}
pub(super) struct Backup {
    pub id: String,
    pub hash: String,
    pub entries: Vec<Entry>,
}
pub(super) fn capture(ctx: &Context, targets: &[PathBuf]) -> Result<Vec<(PathBuf, Value)>> {
    if targets.len() > 20000 {
        return Err(Error::new(409, "MAINTENANCE_ARGUMENT", "备份条目超过上限"));
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for source in targets {
        let file = ctx.target(source)?;
        if seen.insert(fs::key(&file)?) {
            result.push((file.clone(), fs::state(&file)?));
        }
    }
    Ok(result)
}
pub(super) fn save(ctx: &Context, snapshot: &[(PathBuf, Value)], label: &str) -> Result<Backup> {
    if label.is_empty()
        || label.len() > 100
        || !label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || snapshot.len() > 20000
    {
        return Err(Error::new(409, "MAINTENANCE_ARGUMENT", "备份参数无效"));
    }
    ctx.key(false)?;
    fs::ensure(&ctx.backup)?;
    let id = format!(
        "{}-{label}-{}",
        codec::timestamp().replace([':', '.'], "-"),
        uuid::Uuid::new_v4()
    );
    let target = ctx.backup.join(&id);
    let staging = ctx
        .backup
        .join(format!(".pending-{}", uuid::Uuid::new_v4()));
    fs::ensure(&staging.join("files"))?;
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for (index, (source, state)) in snapshot.iter().enumerate() {
        let source = ctx.target(source)?;
        if !seen.insert(fs::key(&source)?) {
            return Err(Error::new(409, "MAINTENANCE_ARGUMENT", "备份目标重复"));
        }
        let bytes = fs::read(&source, true)?;
        let current = if let Some(bytes) = &bytes {
            json!({"exists":true,"sha256":codec::digest(bytes),"size":bytes.len()})
        } else {
            json!({"exists":false,"sha256":null,"size":0})
        };
        if !codec::equal(state, &current) {
            return Err(Error::conflict("快照准备后文件已变化"));
        }
        let name = if bytes.is_some() {
            format!("{index:05}.bin")
        } else {
            String::new()
        };
        if let Some(bytes) = bytes {
            fs::atomic(&staging.join("files").join(&name), &bytes, false)?;
        }
        files.push(json!({"source":source,"existed":state["exists"],"backup":name,"sha256":state["sha256"],"size":state["size"]}));
    }
    let manifest = json!({"schemaVersion":2,"kind":"maintenance-backup","createdAt":codec::timestamp(),"label":label,"files":files,"root":ctx.root_identity,
        "runtimeRoot":ctx.options.runtime,"showcaseRoot":ctx.options.showcase,"runtimeIdentity":fs::directory_identity(&ctx.options.runtime)?,
        "showcaseIdentity":ctx.options.showcase.as_ref().map(|path|fs::directory_identity(path)).transpose()?});
    ctx.write_signed(&staging.join("manifest.json"), manifest)?;
    fs::safe(&ctx.backup, true, false)?;
    std::fs::rename(staging, target)?;
    fs::sync(&ctx.backup)?;
    read(ctx, &id, None)
}
pub(super) fn read(ctx: &Context, id: &str, expected: Option<&str>) -> Result<Backup> {
    if id.is_empty()
        || id.len() > 200
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(Error::path("备份 ID 必须是专用目录内的单个名称"));
    }
    let directory = ctx.backup.join(id);
    fs::safe(&directory, true, false)?;
    let bytes = fs::read(&directory.join("manifest.json"), false)?.unwrap();
    let hash = codec::digest(&bytes);
    if expected.is_some_and(|expected| expected != hash) {
        return Err(invalid("备份 manifest 哈希不匹配"));
    }
    let manifest = codec::unseal(
        serde_json::from_slice(&bytes).map_err(|_| invalid("备份不是有效 JSON"))?,
        &ctx.key(false)?,
    )?;
    let files = manifest["files"]
        .as_array()
        .ok_or_else(|| invalid("备份 files 无效"))?;
    let showcase = serde_json::to_value(&ctx.options.showcase).unwrap();
    if manifest["schemaVersion"] != 2
        || manifest["kind"] != "maintenance-backup"
        || !codec::equal(&manifest["root"], &ctx.root_identity)
        || !manifest["runtimeRoot"]
            .as_str()
            .is_some_and(|path| fs::same(Path::new(path), &ctx.options.runtime))
        || manifest["showcaseRoot"] != showcase
        || !codec::equal(
            &manifest["runtimeIdentity"],
            &fs::directory_identity(&ctx.options.runtime)?,
        )
        || !codec::equal(
            &manifest["showcaseIdentity"],
            &ctx.options
                .showcase
                .as_ref()
                .map(|path| fs::directory_identity(path))
                .transpose()?
                .unwrap_or(Value::Null),
        )
        || files.len() > 20000
    {
        return Err(invalid("拒绝 legacy、未知 schema 或根身份不匹配的备份"));
    }
    if names(&directory)? != HashSet::from(["files".into(), "manifest.json".into()]) {
        return Err(invalid("备份中存在未知文件"));
    }
    fs::safe(&directory.join("files"), true, false)?;
    let mut stored = HashSet::new();
    let mut targets = HashSet::new();
    let mut entries = Vec::new();
    for item in files {
        let source = item["source"]
            .as_str()
            .ok_or_else(|| invalid("备份目标无效"))?;
        let file = ctx.target(Path::new(source))?;
        let existed = item["existed"]
            .as_bool()
            .ok_or_else(|| invalid("备份 existed 无效"))?;
        if !targets.insert(fs::key(&file)?) {
            return Err(invalid("备份目标重复"));
        }
        let content = if existed {
            let name = item["backup"]
                .as_str()
                .ok_or_else(|| invalid("备份文件名无效"))?;
            if name.len() != 9
                || !name.ends_with(".bin")
                || !name[..5].bytes().all(|b| b.is_ascii_digit())
                || !stored.insert(name.to_owned())
            {
                return Err(invalid("备份文件名无效"));
            }
            let path = directory.join("files").join(name);
            let state = fs::state(&path)?;
            if state["exists"] != true
                || state["sha256"] != item["sha256"]
                || state["size"] != item["size"]
            {
                return Err(invalid("备份内容哈希不匹配"));
            }
            Some(path)
        } else {
            if item["backup"] != "" || !item["sha256"].is_null() || item["size"] != 0 {
                return Err(invalid("不存在文件的备份身份无效"));
            }
            None
        };
        entries.push(Entry {
            file,
            content,
            expected: json!({"exists":existed,"sha256":item["sha256"],"size":item["size"]}),
        });
    }
    if names(&directory.join("files"))? != stored {
        return Err(invalid("备份包含未声明的文件"));
    }
    Ok(Backup {
        id: id.into(),
        hash,
        entries,
    })
}
pub(super) fn restore(
    ctx: &Context,
    entries: &[Entry],
    owned: impl Fn() -> Result<()>,
) -> Result<()> {
    for item in entries {
        ctx.target(&item.file)?;
    }
    for item in entries {
        owned()?;
        let file = Context::new(&ctx.options)?.target(&item.file)?;
        if codec::equal(&fs::state(&file)?, &item.expected) {
            continue;
        }
        if let Some(source) = &item.content {
            let bytes = fs::read(source, false)?.unwrap();
            if item.expected["sha256"] != codec::digest(&bytes)
                || item.expected["size"] != bytes.len()
            {
                return Err(invalid("恢复前备份字节发生变化"));
            }
            fs::atomic(&file, &bytes, true)?;
        } else {
            fs::remove(&file)?;
        }
    }
    for item in entries {
        if !codec::equal(&fs::state(&ctx.target(&item.file)?)?, &item.expected) {
            return Err(Error::new(
                409,
                "MAINTENANCE_INCONSISTENT",
                "恢复后字节核验失败",
            ));
        }
    }
    Ok(())
}
pub(super) fn list(ctx: &Context) -> Result<Value> {
    if fs::safe(&ctx.backup, true, true)?.is_none() {
        return Ok(json!({"ok":true,"entries":[]}));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&ctx.backup)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if let Ok(manifest) = fs::json(&entry.path().join("manifest.json")) {
            entries.push(json!({"id":entry.file_name().to_string_lossy(),"label":manifest["label"].as_str().unwrap_or(""),"createdAt":manifest["createdAt"].as_str().unwrap_or(""),"fileCount":manifest["files"].as_array().map(Vec::len).unwrap_or(0)}));
        }
    }
    let time = |item: &Value| {
        chrono::DateTime::parse_from_rfc3339(item["createdAt"].as_str().unwrap_or(""))
            .map(|time| time.timestamp_millis())
            .unwrap_or(0)
    };
    entries.sort_by(|a, b| {
        time(b)
            .cmp(&time(a))
            .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
    });
    entries.truncate(50);
    Ok(json!({"ok":true,"entries":entries}))
}
fn names(path: &Path) -> Result<HashSet<String>> {
    Ok(std::fs::read_dir(path)?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<std::result::Result<_, _>>()?)
}
fn invalid(message: &str) -> Error {
    Error::new(409, "MAINTENANCE_INVALID_BACKUP", message)
}
