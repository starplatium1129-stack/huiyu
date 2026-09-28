mod copy_job;
mod files;
#[cfg(test)]
mod tests;
mod verify;
use super::*;
use files::*;
use rusqlite::params;
use std::{fs, fs::OpenOptions, path::Path};
use verify::*;

// This value owns filesystem state only. The live Connection stays on the writer.
struct Files {
    root: PathBuf,
    workspace_id: String,
    cancel: Arc<AtomicBool>,
}
impl Files {
    fn from_context(c: &Context) -> Self {
        Self {
            root: c.root.clone(),
            workspace_id: c.workspace_id.clone(),
            cancel: c.cancel.clone(),
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
}

pub(super) enum Prepared {
    Complete(Value),
    Copy(Box<CopyJob>),
}
pub(super) struct Completion {
    key: String,
    operation_id: Value,
    kind: Value,
    backup_id: Option<String>,
    pub cancel: Arc<AtomicBool>,
}
pub(super) struct CopyJob {
    files: Files,
    pub completion: Completion,
    kind: CopyKind,
}
enum CopyKind {
    Backup {
        directory: PathBuf,
        manifest: Value,
        existing: bool,
    },
    Restore {
        backup_id: String,
        candidate_id: String,
    },
}
impl CopyJob {
    pub(super) fn run(&self) -> Result<Value> {
        self.files.check_cancel()?;
        copy_job::run(&self.files, &self.kind)
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
fn media_rows(db: &Connection) -> Result<Vec<Value>> {
    Ok(db.prepare("SELECT hash,bytes,mime FROM media_objects ORDER BY hash")?.query_map([],|r|Ok(json!({"hash":r.get::<_,String>(0)?,"bytes":r.get::<_,i64>(1)?,"mime":r.get::<_,String>(2)?})))?.collect::<rusqlite::Result<_>>()?)
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
        prepare_snapshot(c, &files, &id)?
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

fn prepare_snapshot(c: &mut Context, files: &Files, id: &str) -> Result<CopyKind> {
    let directory = schema::safe(&c.root, format!("backups/{id}"))?;
    if schema::safe(&directory, "manifest.json")?.exists() {
        let manifest = manifest(files, &directory, id)?;
        return Ok(CopyKind::Backup {
            directory,
            manifest,
            existing: true,
        });
    }
    let directory = prepare_directory(files, &format!("backups/{id}"), id)?;
    let media = media_rows(&c.db)?;
    let revision = c.transaction(|c| {
        for item in &media {
            c.db.execute(
                "INSERT OR IGNORE INTO leases VALUES(?,'backup',?,NULL,?)",
                params![
                    format!("{id}:{}", string(item, "hash")?),
                    string(item, "hash")?,
                    now()
                ],
            )?;
        }
        c.revision()
    })?;
    let database = directory.join("huiyu.sqlite3");
    let mut snapshot = Connection::open(&database)?;
    {
        let backup = rusqlite::backup::Backup::new(&c.db, &mut snapshot)?;
        loop {
            c.check_cancel()?;
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
    let manifest = json!({"formatVersion":1,"kind":"huiyu-workspace-backup","backupId":id,"workspaceId":c.workspace_id,"schemaVersion":3,"revision":revision,"media":media});
    Ok(CopyKind::Backup {
        directory,
        manifest,
        existing: false,
    })
}

pub(super) fn finish(
    c: &mut Context,
    completion: Completion,
    result: Result<Value>,
) -> Result<Value> {
    let result = result?;
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
