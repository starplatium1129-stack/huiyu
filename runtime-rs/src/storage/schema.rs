use super::*;
use rusqlite::params;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path},
};

pub(super) fn safe(root: &Path, relative: impl AsRef<Path>) -> Result<PathBuf> {
    let relative = relative.as_ref();
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(conflict("MEDIA_INVALID", "Workspace path escapes its root"));
    }
    #[cfg(windows)]
    if relative.components().any(|part| match part {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            name.contains(':') || name.ends_with(['.', ' '])
        }
        _ => false,
    }) {
        return Err(conflict(
            "MEDIA_INVALID",
            "Workspace path has an unsupported Windows component",
        ));
    }
    let target = root.join(relative);
    let mut current = PathBuf::new();
    for part in target.components() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(stat) if reparse(&stat) => {
                return Err(conflict(
                    "MEDIA_INVALID",
                    "Workspace symlinks and reparse points are not supported",
                ));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    Ok(target)
}
fn reparse(stat: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        stat.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        stat.file_type().is_symlink()
    }
}
pub(super) fn sync_dir(directory: &Path) -> Result<()> {
    #[cfg(not(windows))]
    {
        fs::File::open(directory)?.sync_all()?;
    }
    #[cfg(windows)]
    {
        let _ = directory;
    }
    Ok(())
}
pub(super) fn write_new(file: &Path, value: &Value) -> Result<()> {
    let mut output = OpenOptions::new().write(true).create_new(true).open(file)?;
    output.write_all(canonical::stringify(value).as_bytes())?;
    output.sync_all()?;
    sync_dir(file.parent().unwrap())
}
fn atomic_json(root: &Path, name: &str, value: &Value) -> Result<()> {
    let pending = safe(root, format!("{name}.{}.pending", uuid::Uuid::new_v4()))?;
    write_new(&pending, value)?;
    fs::rename(pending, safe(root, name)?)?;
    sync_dir(root)
}
pub(super) struct Owner {
    file: PathBuf,
    identity: Value,
    released: bool,
}
impl Owner {
    fn acquire(root: &Path, workspace_id: &str) -> Result<Self> {
        let file = safe(root, ".workspace-owner.json")?;
        let identity = json!({"workspaceId":workspace_id,"nonce":uuid::Uuid::new_v4().to_string(),"pid":std::process::id(),"startedAt":now()});
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    ApiError::new(
                        423,
                        "WORKSPACE_LOCKED",
                        "Workspace already has an owner; exited owners require host recovery",
                    )
                } else {
                    e.into()
                }
            })?;
        output.write_all(canonical::stringify(&identity).as_bytes())?;
        output.sync_all()?;
        sync_dir(root)?;
        Ok(Self {
            file,
            identity,
            released: false,
        })
    }
    pub(super) fn check(&self) -> Result<()> {
        safe(self.file.parent().unwrap(), ".workspace-owner.json")?;
        let current: Value = serde_json::from_slice(&fs::read(&self.file)?)?;
        if self.released || current != self.identity {
            return Err(conflict(
                "WORKSPACE_LOCK_CHANGED",
                "Workspace ownership changed; lock retained",
            ));
        }
        Ok(())
    }
    pub(super) fn release(&mut self) -> Result<()> {
        if self.released {
            return Ok(());
        }
        let current: Value = serde_json::from_slice(&fs::read(&self.file)?)?;
        if current != self.identity {
            return Err(conflict(
                "WORKSPACE_LOCK_CHANGED",
                "Workspace ownership changed; lock retained",
            ));
        }
        fs::remove_file(&self.file)?;
        sync_dir(self.file.parent().unwrap())?;
        self.released = true;
        Ok(())
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if !self.released
            && let Err(error) = self.release()
        {
            eprintln!("workspace owner: {error}");
        }
    }
}

fn supported(version: i64) -> bool {
    (1..=3).contains(&version)
}
pub(super) fn open(
    root: PathBuf,
    workspace_id: String,
    epoch: String,
    create: bool,
) -> Result<Context> {
    let root = normalize_root(root)?;
    if !root.is_absolute()
        || root.parent().is_none()
        || root.to_string_lossy().starts_with("\\\\")
        || root.to_string_lossy().starts_with("//")
        || workspace_id.is_empty()
        || workspace_id.len() > 128
        || !workspace_id.as_bytes()[0].is_ascii_alphanumeric()
        || !workspace_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(conflict(
            "WORKSPACE_IDENTITY",
            "A named workspace on an explicit local directory is required",
        ));
    }
    safe(&root, "")?;
    if !root.exists() && create {
        fs::create_dir_all(&root)?;
    }
    if !root.is_dir() {
        return Err(conflict(
            "WORKSPACE_IDENTITY",
            "Workspace directory is unavailable",
        ));
    }
    let owner = Owner::acquire(&root, &workspace_id)?;
    let identity_file = safe(&root, "workspace.json")?;
    let database_file = safe(&root, "huiyu.sqlite3")?;
    let exists = database_file.exists();
    if exists != identity_file.exists() || (!exists && !create) {
        return Err(conflict(
            "WORKSPACE_IDENTITY",
            "Workspace identity or database is missing; repair required",
        ));
    }
    let mut identity = if exists {
        serde_json::from_slice::<Value>(&fs::read(&identity_file)?)?
    } else {
        let value =
            json!({"workspaceId":workspace_id,"databaseKind":"huiyu-workspace","schemaVersion":1});
        write_new(&identity_file, &value)?;
        value
    };
    if identity["workspaceId"] != workspace_id
        || identity["databaseKind"] != "huiyu-workspace"
        || !identity["schemaVersion"].as_i64().is_some_and(supported)
    {
        return Err(conflict(
            "WORKSPACE_IDENTITY",
            "Workspace identity or format is unsupported",
        ));
    }
    for suffix in ["-wal", "-shm"] {
        safe(&root, format!("huiyu.sqlite3{suffix}"))?;
    }
    let db = Connection::open(database_file)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    db.set_prepared_statement_cache_capacity(64);
    let mut version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if (exists && !supported(version)) || (!exists && version != 0) {
        return Err(conflict(
            "WORKSPACE_SCHEMA",
            "Unsupported workspace schema; repair required",
        ));
    }
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;")?;
    if !exists {
        db.execute_batch(include_str!("schema.sql"))?;
        for (key, value) in [
            ("workspaceId", workspace_id.as_str()),
            ("databaseKind", "huiyu-workspace"),
            ("schemaVersion", "1"),
            ("revision", "0"),
            ("writerEpoch", epoch.as_str()),
        ] {
            db.execute("INSERT INTO meta VALUES(?,?)", params![key, value])?;
        }
        db.execute("INSERT INTO schema_migrations VALUES(1,?)", [now()])?;
        version = 1;
    } else {
        verify_identity(&db, &workspace_id, version)?;
        db.execute("UPDATE meta SET value=? WHERE key='writerEpoch'", [&epoch])?;
    }
    db.execute_batch("COMMIT")?;
    let intent_file = safe(&root, "schema-upgrade.json")?;
    if intent_file.exists() {
        let intent: Value = serde_json::from_slice(&fs::read(&intent_file)?)?;
        let from = intent["from"].as_i64().unwrap_or(0);
        let to = intent["to"].as_i64().unwrap_or(0);
        if intent["workspaceId"] != workspace_id
            || !supported(from)
            || !supported(to)
            || to <= from
            || ![from, to].contains(&version)
            || ![json!(from), json!(to)].contains(&identity["schemaVersion"])
        {
            return Err(conflict(
                "WORKSPACE_SCHEMA",
                "Unrecognized interrupted schema migration",
            ));
        }
        if version == from {
            upgrade(&db, from, to)?;
            version = to;
        }
        identity["schemaVersion"] = json!(version);
        atomic_json(&root, "workspace.json", &identity)?;
        fs::remove_file(&intent_file)?;
        sync_dir(&root)?;
    }
    if identity["schemaVersion"] != version {
        return Err(conflict(
            "WORKSPACE_IDENTITY",
            "Workspace identity and database versions differ",
        ));
    }
    if version < 3 {
        atomic_json(
            &root,
            "schema-upgrade.json",
            &json!({"workspaceId":workspace_id,"from":version,"to":3}),
        )?;
        upgrade(&db, version, 3)?;
        identity["schemaVersion"] = json!(3);
        atomic_json(&root, "workspace.json", &identity)?;
        fs::remove_file(intent_file)?;
        sync_dir(&root)?;
    }
    verify_identity(&db, &workspace_id, 3)?;
    // Additive access-path optimization: keep the v3 data/backup protocol intact.
    // Reapply on open so existing v3 workspaces and restored older snapshots
    // receive the reverse lookup used by artwork deletion and FK checks.
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS project_artworks_artwork ON project_artworks(artwork_key);
         CREATE INDEX IF NOT EXISTS media_aliases_hash ON media_aliases(hash);
         CREATE INDEX IF NOT EXISTS media_refs_hash ON media_refs(hash);
         CREATE INDEX IF NOT EXISTS tasks_revision ON tasks(principal_id,json_extract(record_json,'$.revision'));
         CREATE INDEX IF NOT EXISTS tasks_recovery_scan ON tasks(principal_id) WHERE json_extract(record_json,'$.deliveryState') != 'discarded' AND (upstream_settled=0 OR (json_extract(record_json,'$.status')='succeeded' AND json_extract(record_json,'$.resultState')!='available'));",
    )?;
    Ok(Context {
        db,
        root,
        workspace_id,
        epoch,
        owner,
        cancel: Arc::new(AtomicBool::new(false)),
    })
}
fn normalize_root(root: PathBuf) -> Result<PathBuf> {
    if !root.is_absolute() {
        return Err(conflict(
            "WORKSPACE_IDENTITY",
            "An explicit absolute workspace directory is required",
        ));
    }
    let mut normalized = PathBuf::new();
    for component in root.components() {
        match component {
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(conflict(
                        "WORKSPACE_IDENTITY",
                        "Workspace path escapes its root",
                    ));
                }
            }
            Component::CurDir => {}
            component => normalized.push(component),
        }
    }
    Ok(normalized)
}
fn verify_identity(db: &Connection, id: &str, version: i64) -> Result<()> {
    for (key, expected) in [
        ("workspaceId", id.to_string()),
        ("databaseKind", "huiyu-workspace".into()),
        ("schemaVersion", version.to_string()),
    ] {
        let actual: String =
            db.query_row("SELECT value FROM meta WHERE key=?", [key], |r| r.get(0))?;
        if actual != expected {
            return Err(conflict(
                "WORKSPACE_IDENTITY",
                "Workspace database identity mismatch",
            ));
        }
    }
    let history: i64 = db.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
        r.get(0)
    })?;
    if history != version {
        return Err(conflict(
            "WORKSPACE_SCHEMA",
            "Workspace migration history is inconsistent",
        ));
    }
    Ok(())
}
fn upgrade(db: &Connection, from: i64, to: i64) -> Result<()> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    for version in from + 1..=to {
        db.execute_batch(match version {
            2 => include_str!("migration-schema.sql"),
            3 => include_str!("task-schema.sql"),
            _ => unreachable!(),
        })?;
        db.execute(
            "INSERT INTO schema_migrations VALUES(?,?)",
            params![version, now()],
        )?;
    }
    db.execute(
        "UPDATE meta SET value=? WHERE key='schemaVersion'",
        [to.to_string()],
    )?;
    db.pragma_update(None, "user_version", to)?;
    db.execute_batch("COMMIT")?;
    Ok(())
}
