mod artwork_index;
mod backup;
mod canonical;
mod garbage;
mod handle;
mod media;
mod migration;
mod operations;
mod organization;
mod profile;
mod project_commands;
mod recent;
mod records;
mod result_commit;
mod saves;
mod schema;
mod tasks;
mod thumbnail;
mod verification;
mod worker;

use crate::error::{ApiError, Result};
use rusqlite::{Connection, Row};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot};

pub use canonical::fingerprint;
pub(crate) use canonical::stringify;
pub use media::Media;

#[derive(Clone)]
pub(crate) enum TaskMediaTarget {
    Input(String),
    Result(u64),
}

pub(crate) struct TaskMediaChunk {
    pub task_id: String,
    pub target: TaskMediaTarget,
    pub offset: u64,
    pub bytes: axum::body::Bytes,
}

#[derive(Clone)]
pub struct Storage {
    sender: mpsc::Sender<Work>,
    workspace_id: Arc<str>,
    runtime_epoch: Arc<str>,
    root: Arc<PathBuf>,
    native_images: Option<Arc<PathBuf>>,
    verification: Arc<verification::Verifier>,
    thumbnails: Arc<thumbnail::Readers>,
    result_writes: Arc<tokio::sync::Semaphore>,
}
enum Work {
    AdmittedResult(Box<Work>, tokio::sync::OwnedSemaphorePermit),
    ResultVerified(String, Result<result_commit::Verified>),
    TaskMediaChunk(
        TaskMediaChunk,
        String,
        Arc<AtomicBool>,
        oneshot::Sender<Result<u64>>,
    ),
    Task(
        crate::task_contract::TaskCommand,
        String,
        Arc<AtomicBool>,
        oneshot::Sender<Result<Value>>,
    ),
    TaskRecord(
        String,
        String,
        Arc<AtomicBool>,
        oneshot::Sender<Result<Option<crate::task_contract::TaskRecord>>>,
    ),
    Request(
        Value,
        String,
        Arc<AtomicBool>,
        oneshot::Sender<Result<Value>>,
    ),
    Media(String, Arc<AtomicBool>, oneshot::Sender<Result<Media>>),
    CopyFinished(
        backup::Completion,
        Result<Value>,
        oneshot::Sender<Result<Value>>,
    ),
    GarbageFinished(
        garbage::Completion,
        Result<garbage::Candidates>,
        oneshot::Sender<Result<Value>>,
    ),
    Close(oneshot::Sender<Result<()>>),
    #[cfg(test)]
    PauseCopy(worker::CopyPause),
    #[cfg(test)]
    PauseGarbage(worker::GarbagePause),
}
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

pub(super) struct Context {
    db: Connection,
    root: PathBuf,
    workspace_id: String,
    epoch: String,
    owner: schema::Owner,
    cancel: Arc<AtomicBool>,
    result_commit: Option<result_commit::Pending>,
}
impl Context {
    fn execute(&mut self, command: &Value, principal: &str) -> Result<Value> {
        self.check_cancel()?;
        if principal.is_empty() {
            return Err(ApiError::new(
                401,
                "UNAUTHORIZED",
                "Desktop principal is required",
            ));
        }
        let kind = string(command, "kind")?;
        if kind.starts_with("task.") {
            if !matches!(
                kind,
                "task.list" | "task.get" | "task.legacy-history" | "task.input.get"
            ) {
                self.writer()?;
            }
            return tasks::execute(self, principal, command);
        }
        if kind.starts_with("migration.") {
            if kind != "migration.status" {
                self.writer()?;
                let id = string(command, "operationId")?;
                if id.is_empty() || id.len() > 200 {
                    return Err(invalid("A stable operation ID is required"));
                }
            }
            return migration::execute(self, principal, command);
        }
        if !matches!(
            kind,
            "status"
                | "listArtworks"
                | "searchArtworks"
                | "readArtworkRecentIndex"
                | "getArtwork"
                | "getArtworks"
                | "listProjects"
                | "getOperation"
                | "patchArtwork"
                | "softDeleteArtwork"
                | "softDeleteArtworks"
                | "hardDeleteArtwork"
                | "restoreArtwork"
                | "saveProject"
                | "deleteSmartAlbum"
                | "purgeExpiredTrash"
                | "purgeTrash"
                | "prepareSave"
                | "uploadChunk"
                | "commitSave"
                | "abortSave"
                | "prepareMedia"
                | "uploadMediaChunk"
                | "commitMedia"
                | "releaseMedia"
                | "appendArtwork"
                | "organizeArtworks"
                | "undoArtworkOrganization"
                | "countMedia"
                | "readMedia"
                | "readThumbnail"
                | "backup"
                | "restoreBackup"
                | "profile.readSettings"
                | "profile.readChat"
                | "profile.readDrafts"
                | "profile.saveSetting"
                | "profile.saveChatRecord"
                | "profile.saveDraft"
                | "profile.resetChat"
        ) {
            return Err(ApiError::new(
                501,
                "COMMAND_NOT_MIGRATED",
                "Workspace command is not implemented by the Rust runtime",
            ));
        }
        if let Some(id) = command.get("operationId")
            && id.as_str().is_none_or(|s| s.is_empty() || s.len() > 200)
        {
            return Err(invalid("A stable operation ID is required"));
        }
        let read = is_read(kind);
        if !read {
            self.writer()?;
            string(command, "operationId")?;
        }
        match kind {
            "status" => Ok(
                json!({"workspaceId": self.workspace_id,"databaseKind":"huiyu-workspace","schemaVersion":3,"writerEpoch":self.epoch,"revision":self.revision()?,"artworkRevision":artwork_index::revision(self)?,"sqliteVersion":rusqlite::version()}),
            ),
            "listArtworks"
            | "searchArtworks"
            | "readArtworkRecentIndex"
            | "getArtwork"
            | "getArtworks"
            | "listProjects" => records::read(self, command),
            "getOperation" => self
                .operation(principal, string(command, "operationId")?)?
                .map(|row| saves::state(self, &row, false))
                .transpose()
                .map(|value| value.unwrap_or(Value::Null)),
            "patchArtwork" | "softDeleteArtwork" | "softDeleteArtworks" | "hardDeleteArtwork"
            | "restoreArtwork" | "saveProject" | "deleteSmartAlbum" | "purgeExpiredTrash"
            | "purgeTrash" => records::mutate(self, principal, command),
            "organizeArtworks" | "undoArtworkOrganization" => {
                organization::execute(self, principal, command)
            }
            "prepareSave" | "uploadChunk" | "commitSave" | "abortSave" | "prepareMedia"
            | "uploadMediaChunk" | "commitMedia" | "releaseMedia" | "appendArtwork"
            | "countMedia" => saves::execute(self, principal, command),
            kind if kind.starts_with("profile.") => profile::execute(self, principal, command),
            _ => Err(ApiError::new(
                501,
                "COMMAND_NOT_MIGRATED",
                "Workspace command is not implemented by the Rust runtime",
            )),
        }
    }
    fn check_cancel(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(ApiError::new(
                499,
                "CANCELLED",
                "Workspace request was cancelled",
            ))
        } else {
            Ok(())
        }
    }
    fn writer(&self) -> Result<()> {
        let epoch: String =
            self.db
                .query_row("SELECT value FROM meta WHERE key='writerEpoch'", [], |r| {
                    r.get(0)
                })?;
        if epoch == self.epoch {
            Ok(())
        } else {
            Err(conflict("WRITER_EPOCH", "Workspace writer epoch is stale"))
        }
    }
    fn transaction<T>(&mut self, work: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        let result = self
            .writer()
            .and_then(|_| self.check_cancel())
            .and_then(|_| work(self))
            .and_then(|v| {
                self.check_cancel()?;
                self.db
                    .execute_batch("COMMIT")
                    .map_err(|_| commit_unknown())?;
                Ok(v)
            });
        if result.is_err() {
            let _ = self.db.execute_batch("ROLLBACK");
        }
        result
    }
    fn revision(&self) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key='revision'",
            [],
            |r| r.get(0),
        )?)
    }
    fn next_revision(&self) -> Result<i64> {
        self.db.execute(
            "UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'",
            [],
        )?;
        self.revision()
    }
    fn shutdown(&mut self) -> Result<()> {
        self.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        self.owner.release()
    }
}
fn unavailable() -> ApiError {
    ApiError::new(503, "STORAGE_UNAVAILABLE", "Workspace storage is closed")
}
fn commit_unknown() -> ApiError {
    ApiError::new(
        503,
        "COMMIT_UNKNOWN",
        "Workspace mutation outcome is unknown; reconcile the stable operation ID",
    )
}
fn is_read(kind: &str) -> bool {
    matches!(
        kind,
        "status"
            | "listArtworks"
            | "searchArtworks"
            | "readArtworkRecentIndex"
            | "getArtwork"
            | "getArtworks"
            | "listProjects"
            | "getOperation"
            | "readMedia"
            | "readThumbnail"
            | "countMedia"
            | "profile.readSettings"
            | "profile.readChat"
            | "profile.readDrafts"
            | "task.list"
            | "task.get"
            | "task.legacy-history"
            | "task.input.get"
            | "migration.status"
    )
}
fn invalid(message: &str) -> ApiError {
    ApiError::new(400, "INVALID_COMMAND", message)
}
fn conflict(code: &str, message: &str) -> ApiError {
    ApiError::new(409, code, message)
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(&format!("{key} must be a string")))
}
// Borrow SQLite text without changing the errors produced by Row::get::<String>.
fn text_column<'row>(row: &'row Row<'_>, column: usize) -> rusqlite::Result<&'row str> {
    match row.get_ref(column)? {
        rusqlite::types::ValueRef::Text(bytes) => {
            std::str::from_utf8(bytes).map_err(|error| rusqlite::Error::Utf8Error(column, error))
        }
        value => Err(rusqlite::Error::InvalidColumnType(
            column,
            row.as_ref().column_name(column)?.into(),
            value.data_type(),
        )),
    }
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
