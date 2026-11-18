mod copy_job;
mod files;
pub(super) mod portable;

mod verify;
use super::*;
use files::*;
use rusqlite::params;
use std::{fs, fs::OpenOptions, path::Path};
use verify::*;

// The live writer stays on its actor. Copy jobs own filesystem state and may
// carry one pinned, read-only SQLite snapshot into the copy worker.
struct Files {
    root: PathBuf,
    workspace_id: String,
    cancel: Arc<AtomicBool>,
    job: Option<Arc<crate::workspace_jobs::Job>>,
}
impl Files {
    fn from_context(c: &Context) -> Self {
        Self {
            root: c.root.clone(),
            workspace_id: c.workspace_id.clone(),
            cancel: c.cancel.clone(),
            job: c.job.clone(),
        }
    }
    fn check_cancel(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(ApiError::new(
                499,
                "CANCELLED",
                "Workspace copy was cancelled",
            ))
        } else {
            Ok(())
        }
    }
    fn progress(&self, phase: &'static str, completed: u64, total: u64) {
        if let Some(job) = &self.job {
            job.progress(phase, completed, total);
        }
    }
}

pub(super) enum Prepared {
    Complete(Value),
    Copy(Box<CopyJob>),
}
pub(super) struct Completion {
    key: String,
    operation_id: Value,
    kind: Value,
    pub(super) backup_id: Option<String>,
    pub cancel: Arc<AtomicBool>,
}
pub(super) struct CopyJob {
    files: Files,
    pub completion: Completion,
    kind: CopyKind,
}
enum CopyKind {
    Backup {
        id: String,
        source: Option<(Connection, i64)>,
    },
    Restore {
        backup_id: String,
        candidate_id: String,
    },
}
impl CopyJob {
    pub(super) fn run(&mut self) -> Result<Value> {
        // Own the reader locally before any early return. Even a pre-cancelled
        // copy must release its read transaction before queuing completion.
        match &mut self.kind {
            CopyKind::Backup { id, source } => copy_job::backup(&self.files, id, source.take()),
            CopyKind::Restore {
                backup_id,
                candidate_id,
            } => copy_job::restore_backup(&self.files, backup_id, candidate_id),
        }
    }
}

fn invalid_backup(message: &str) -> ApiError {
    conflict("BACKUP_INVALID", message)
}
fn valid_id(id: &str) -> Result<()> {
    if uuid::Uuid::parse_str(id).is_err() || id.len() != 36 || id != id.to_ascii_lowercase() {
        return Err(invalid_backup("Invalid backup identity"));
    }
    Ok(())
}
fn object_relative(hash: &str) -> Result<String> {
    if !media::valid_hash(hash) {
        return Err(invalid_backup("Invalid backup media digest"));
    }
    Ok(format!("media/objects/{}/{}", &hash[..2], hash))
}
fn media_rows(files: &Files, db: &Connection) -> Result<Vec<Value>> {
    let mut media = Vec::new();
    visit_media_rows(files, db, |row| media.push(row))?;
    Ok(media)
}
fn visit_media_rows(files: &Files, db: &Connection, mut consume: impl FnMut(Value)) -> Result<()> {
    let mut statement = db.prepare("SELECT hash,bytes,mime FROM media_objects ORDER BY hash")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        files.check_cancel()?;
        consume(json!({
            "hash": text_column(row, 0)?,
            "bytes": row.get::<_, i64>(1)?,
            "mime": text_column(row, 2)?,
        }));
    }
    Ok(())
}

pub(super) fn prepare(c: &mut Context, principal: &str, command: &Value) -> Result<Prepared> {
    c.check_cancel()?;
    if principal.is_empty() {
        return Err(ApiError::new(
            401,
            "UNAUTHORIZED",
            "Desktop principal is required",
        ));
    }
    let operation_id = string(command, "operationId")?;
    if operation_id.is_empty() || operation_id.encode_utf16().count() > 200 {
        return Err(invalid("A stable operation ID is required"));
    }
    let (key, previous) = c.transaction(|c| c.start_operation(principal, command))?;
    let restore = command["kind"] == "restoreBackup";
    if let Some(receipt) = previous {
        return Ok(Prepared::Complete(if restore {
            json!({"candidateId":receipt["candidateId"],"revision":receipt["revision"],"mediaCount":receipt["mediaCount"]})
        } else {
            json!({"backupId":receipt["backupId"],"revision":receipt["revision"],"mediaCount":receipt["mediaCount"]})
        }));
    }
    let id = format!(
        "{}-{}-{}-{}-{}",
        &key[..8],
        &key[8..12],
        &key[12..16],
        &key[16..20],
        &key[20..32]
    );
    let files = Files::from_context(c);
    let kind = if restore {
        let backup_id = string(command, "backupId")?;
        valid_id(backup_id)?;
        CopyKind::Restore {
            backup_id: backup_id.into(),
            candidate_id: id.clone(),
        }
    } else {
        CopyKind::Backup {
            source: pin_snapshot(c, &id)?,
            id: id.clone(),
        }
    };
    Ok(Prepared::Copy(Box::new(CopyJob {
        files,
        completion: Completion {
            key,
            operation_id: command["operationId"].clone(),
            kind: command["kind"].clone(),
            backup_id: (!restore).then_some(id),
            cancel: c.cancel.clone(),
        },
        kind,
    })))
}

fn has_snapshot(c: &Context, id: &str) -> Result<bool> {
    let directory = schema::safe(&c.root, format!("backups/{id}"))?;
    Ok(schema::safe(&directory, "manifest.json")?.try_exists()?
        || schema::safe(&directory, "snapshot.json")?.try_exists()?)
}

fn pin_snapshot(c: &mut Context, id: &str) -> Result<Option<(Connection, i64)>> {
    if has_snapshot(c, id)? {
        return Ok(None);
    }
    let source = Connection::open_with_flags(
        schema::safe(&c.root, "huiyu.sqlite3")?,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    source.busy_timeout(std::time::Duration::from_secs(10))?;
    source.execute_batch("BEGIN DEFERRED")?;
    // Pin the read revision before returning to the actor queue. New writes can
    // proceed in WAL mode; leases protect exactly this snapshot's media objects.
    let (source_revision, workspace, epoch): (i64, String, String) = source.query_row(
        "SELECT (SELECT CAST(value AS INTEGER) FROM meta WHERE key='revision'),
                (SELECT value FROM meta WHERE key='workspaceId'),
                (SELECT value FROM meta WHERE key='writerEpoch')",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    c.transaction(|c| {
        if source_revision != c.revision()? || workspace != c.workspace_id || epoch != c.epoch {
            return Err(conflict(
                "WORKSPACE_IDENTITY",
                "Backup source no longer matches the workspace",
            ));
        }
        c.db.execute(
            "INSERT OR IGNORE INTO leases
             SELECT ?1 || ':' || hash,'backup',hash,NULL,?2 FROM media_objects",
            params![id, now()],
        )?;
        Ok(())
    })?;
    Ok(Some((source, source_revision)))
}

// Before snapshot.json is published, a retry takes a new SQLite snapshot.
// After publication its media must stay leased even when copying was cancelled.
pub(super) fn release_unsealed(c: &Context, id: Option<&str>) {
    let Some(id) = id else { return };
    let cleanup = || -> Result<()> {
        if !has_snapshot(c, id)? {
            c.db.execute(
                "DELETE FROM leases WHERE kind='backup' AND id LIKE ?1
                AND (SELECT value FROM meta WHERE key='writerEpoch')=?2",
                params![format!("{id}:%"), c.epoch],
            )?;
        }
        Ok(())
    };
    if let Err(error) = cleanup() {
        eprintln!("workspace backup lease cleanup: {error}");
    }
}

fn copy_database(files: &Files, source: Connection, directory: &Path, id: &str) -> Result<()> {
    let database = schema::safe(directory, "huiyu.sqlite3")?;
    let mut snapshot = Connection::open(&database)?;
    {
        let backup = rusqlite::backup::Backup::new(&source, &mut snapshot)?;
        loop {
            files.check_cancel()?;
            let progress = backup.progress();
            files.progress(
                "snapshot",
                (progress.pagecount - progress.remaining) as u64,
                progress.pagecount as u64,
            );
            match backup.step(256)? {
                rusqlite::backup::StepResult::Done => break,
                rusqlite::backup::StepResult::Busy | rusqlite::backup::StepResult::Locked => {
                    return Err(ApiError::new(
                        503,
                        "STORAGE_UNAVAILABLE",
                        "SQLite backup snapshot is busy",
                    ));
                }
                _ => {}
            }
        }
    }
    snapshot.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")?;
    snapshot.execute(
        "DELETE FROM leases WHERE kind='backup' AND id LIKE ?",
        [format!("{id}:%")],
    )?;
    drop(snapshot);
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&database)?
        .sync_all()?;
    Ok(())
}

pub(super) fn finish(
    c: &mut Context,
    completion: Completion,
    result: Result<Value>,
) -> Result<Value> {
    let result = result.inspect_err(|_| release_unsealed(c, completion.backup_id.as_deref()))?;
    c.cancel = completion.cancel;
    // Publish receipt and release leases together; cancelled copies remain prepared
    // even when their immutable manifest was completed just before cancellation.
    c.transaction(|c| {
        let mut receipt = result.clone();
        receipt["operationId"] = completion.operation_id;
        receipt["kind"] = completion.kind;
        c.commit_operation(&completion.key, &receipt)?;
        if let Some(id) = completion.backup_id {
            c.db.execute(
                "DELETE FROM leases WHERE kind='backup' AND id LIKE ?",
                [format!("{id}:%")],
            )?;
        }
        Ok(())
    })?;
    Ok(result)
}
