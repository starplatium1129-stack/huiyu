use super::*;
mod discovery;
pub(super) use discovery::{Candidates, Completion, Discovery};

use crate::file_identity;
use rusqlite::{OptionalExtension, params};
use std::{collections::HashMap, fs, time::UNIX_EPOCH};

pub(super) enum Prepared {
    Complete(Value),
    Discover(Box<Discovery>),
}
fn validate(c: &Context, principal: &str, command: &Value) -> Result<()> {
    c.check_cancel()?;
    if principal.is_empty() {
        return Err(ApiError::new(
            401,
            "UNAUTHORIZED",
            "Desktop principal is required",
        ));
    }
    if command["kind"] != "collectGarbage" {
        return Err(invalid("Unknown garbage collection command"));
    }
    let id = string(command, "operationId")?;
    if id.is_empty() || id.len() > 200 {
        return Err(invalid("A stable operation ID is required"));
    }
    c.writer()?;
    c.owner.check()
}
pub(super) fn receipt(c: &Context, principal: &str, command: &Value) -> Result<Option<Value>> {
    validate(c, principal, command)?;
    if let Some(operation) = c.operation(principal, string(command, "operationId")?)? {
        operation.check("collectGarbage", command)?;
        return Ok(operation.receipt);
    }
    Ok(None)
}
pub(super) fn prepare(c: &mut Context, principal: &str, command: &Value) -> Result<Prepared> {
    validate(c, principal, command)?;
    let (key, previous) = c.transaction(|c| c.start_operation(principal, command))?;
    if let Some(receipt) = previous {
        return Ok(Prepared::Complete(receipt));
    }
    Ok(Prepared::Discover(Box::new(Discovery::new(
        c,
        key,
        command["operationId"].clone(),
    )?)))
}
pub(super) fn finish(
    c: &mut Context,
    completion: Completion,
    candidates: Result<Candidates>,
) -> Result<Value> {
    c.cancel = completion.cancel.clone();
    c.check_cancel()?;
    let candidates = candidates?;
    completion.check(c)?;
    c.transaction(|c| {
        let mut removed = 0;
        for candidate in candidates.expired {
            c.check_cancel()?;
            if protected(c, &candidate.hash)? { continue; }
            if let Some(file) = candidate.current(&c.root)? {
                completion.check(c)?;
                if c.media_verified.as_ref().is_some_and(|proof| proof.hash() == candidate.hash) {
                    c.media_verified = None;
                }
                fs::remove_file(file)?;
                remove_metadata(c, &candidate.hash)?;
                removed += 1;
            }
        }
        for hash in candidates.missing {
            c.check_cancel()?;
            let recorded: bool = c.db.prepare_cached("SELECT EXISTS(SELECT 1 FROM media_objects WHERE hash=?)")?.query_row([&hash], |row| row.get(0))?;
            if !recorded || protected(c, &hash)? || !discovery::missing(&media::object_path(&c.root, &hash)?)? { continue; }
            completion.check(c)?;
            if c.media_verified.as_ref().is_some_and(|proof| proof.hash() == hash) {
                c.media_verified = None;
            }
            remove_metadata(c, &hash)?;
            removed += 1;
        }
        for candidate in candidates.staging {
            c.check_cancel()?;
            if candidate.protected(c)? || !candidate.eligible(&c.db)? { continue; }
            if let Some(file) = candidate.current(&c.root)? {
                completion.check(c)?;
                if c.media_verified.as_ref().is_some_and(|proof| proof.path == file) {
                    c.media_verified = None;
                }
                if candidate.empty() { fs::remove_dir(file)?; }
                else {
                    fs::remove_file(&file)?;
                    let folder = file.parent().unwrap();
                    if fs::read_dir(folder)?.next().is_none() { fs::remove_dir(folder)?; }
                }
            }
        }
        completion.check(c)?;
        let receipt=json!({"operationId":completion.operation_id,"kind":"collectGarbage","revision":c.next_revision()?,"removed":removed});
        c.commit_operation(&completion.key,&receipt)?;Ok(receipt)
    })
}
fn protected(c: &Context, hash: &str) -> Result<bool> {
    if c.migration_verification
        .as_ref()
        .is_some_and(|pending| pending.protects(hash))
    {
        return Ok(true);
    }
    if c.upload
        .as_ref()
        .is_some_and(|pending| pending.hash() == hash)
    {
        return Ok(true);
    }
    if c.result_commit
        .as_ref()
        .is_some_and(|job| job.hash() == hash)
    {
        return Ok(true);
    }
    if c.restore_commit
        .as_ref()
        .is_some_and(|pending| pending.protects(hash))
    {
        return Ok(true);
    }
    Ok(c.db.prepare_cached("SELECT EXISTS(SELECT 1 FROM media_refs WHERE hash=?1) OR EXISTS(SELECT 1 FROM leases WHERE hash=?1)")?
        .query_row([hash], |row| row.get(0))?)
}
fn expired(stat: &fs::Metadata) -> Result<bool> {
    Ok(stat
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
        <= now() - records::RETENTION)
}
fn remove_metadata(c: &Context, hash: &str) -> Result<()> {
    for version in [
        "thumbnails-v1",
        "thumbnails-rust-v1",
        "thumbnails-rust-vips-v1",
    ] {
        let thumbnail = schema::safe(&c.root, format!("cache/{version}/{hash}.jpg"))?;
        if thumbnail.exists() {
            fs::remove_file(thumbnail)?;
        }
    }
    c.db.execute("DELETE FROM media_aliases WHERE hash=?", [hash])?;
    c.db.execute("DELETE FROM media_objects WHERE hash=?", [hash])?;
    Ok(())
}

pub(super) struct Staging {
    key: String,
    alias_hash: Option<String>,
    native: file_identity::Identity,
    proof: Option<discovery::Proof>,
    origin: Option<Origin>,
}
#[derive(Clone)]
enum Origin {
    Operation,
    Result(String, i64, String),
    Input(String, String, String),
    Migration(String, String, bool),
    Retained,
}

// Only Discovery calls this streaming classification on its background reader.
fn match_staging(
    completion: &Completion,
    db: &Connection,
    mut window: Vec<Staging>,
) -> Result<Vec<Staging>> {
    if window.is_empty() {
        return Ok(window);
    }
    let mut by_key = HashMap::new();
    for (index, candidate) in window.iter_mut().enumerate() {
        completion.cancelled()?;
        by_key.insert(candidate.key.clone(), index);
        let state: Option<String> = db
            .prepare_cached("SELECT state FROM operations WHERE op_key=?")?
            .query_row([&candidate.key], |row| row.get(0))
            .optional()?;
        if let Some(state) = state {
            candidate.origin = Some(if matches!(state.as_str(), "committed" | "aborted") {
                Origin::Operation
            } else {
                Origin::Retained
            });
        }
    }
    if window.iter().any(|candidate| candidate.origin.is_none()) {
        let mut statement = db.prepare("SELECT o.task_id,o.output_index,json_extract(o.media_json,'$.alias'),'output' FROM task_outputs o WHERE o.committed=1 OR EXISTS(SELECT 1 FROM tasks t WHERE t.task_id=o.task_id AND json_extract(t.record_json,'$.deliveryState')='discarded') UNION ALL SELECT task_id,name,json_extract(media_json,'$.alias'),'input' FROM task_inputs WHERE committed=1")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            completion.cancelled()?;
            let task: String = row.get(0)?;
            let alias: String = row.get(2)?;
            let kind: String = row.get(3)?;
            let (key, origin) = if kind == "output" {
                let index: i64 = row.get(1)?;
                (
                    canonical::digest(format!("task:{task}:{index}")),
                    Origin::Result(task, index, alias),
                )
            } else {
                let name: String = row.get(1)?;
                (
                    canonical::digest(format!("input:{task}:{name}")),
                    Origin::Input(task, name, alias),
                )
            };
            assign(&mut window, &by_key, key, origin);
        }
    }
    if window.iter().any(|candidate| candidate.origin.is_none()) {
        let mut statement = db.prepare("SELECT m.migration_id,m.alias,0 FROM migration_media m JOIN migration_sessions s ON s.migration_id=m.migration_id WHERE s.state='activated' UNION ALL SELECT i.migration_id,i.item_id,1 FROM migration_items i JOIN migration_sessions s ON s.migration_id=i.migration_id WHERE s.state='activated'")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            completion.cancelled()?;
            let id: String = row.get(0)?;
            let alias: String = row.get(1)?;
            let record: bool = row.get(2)?;
            let name = if record {
                format!("record:{alias}")
            } else {
                alias.clone()
            };
            assign(
                &mut window,
                &by_key,
                migration::key(&id, &name),
                Origin::Migration(id, alias, record),
            );
        }
    }
    let mut selected = Vec::new();
    for candidate in window {
        completion.cancelled()?;
        // The reader snapshot already matched these immutable identities and
        // completed states. The writer will repeat the indexed check before unlink.
        if candidate
            .origin
            .as_ref()
            .is_some_and(|origin| !matches!(origin, Origin::Retained))
            && !candidate.leased(db)?
        {
            selected.push(candidate);
        }
    }
    Ok(selected)
}

fn assign(window: &mut [Staging], by_key: &HashMap<String, usize>, key: String, origin: Origin) {
    if let Some(index) = by_key.get(&key) {
        let candidate = &mut window[*index];
        if candidate.origin.is_none() {
            candidate.origin = Some(origin);
        }
    }
}

impl Staging {
    fn accepts_alias(&self, hash: &str) -> bool {
        match &self.origin {
            Some(Origin::Operation) => true,
            Some(
                Origin::Result(_, _, alias)
                | Origin::Input(_, _, alias)
                | Origin::Migration(_, alias, _),
            ) => hash == canonical::digest(alias),
            _ => false,
        }
    }
    fn leased(&self, db: &Connection) -> Result<bool> {
        Ok(db
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM leases WHERE id=?1 OR operation_key=?1)")?
            .query_row([&self.key], |row| row.get(0))?)
    }
    pub fn protected(&self, c: &Context) -> Result<bool> {
        Ok(c.result_commit
            .as_ref()
            .is_some_and(|job| job.key() == self.key)
            || c.upload.as_ref().is_some_and(|job| job.key() == self.key)
            || self.leased(&c.db)?)
    }
    pub fn eligible(&self, db: &Connection) -> Result<bool> {
        let alias: Option<String> = match &self.origin {
            Some(Origin::Operation) => return Ok(db.prepare_cached("SELECT EXISTS(SELECT 1 FROM operations WHERE op_key=? AND state IN ('committed','aborted'))")?
                .query_row([&self.key], |row| row.get(0))?),
            Some(Origin::Result(task, index, alias)) => {
                let stored: Option<String> = db.prepare_cached("SELECT json_extract(o.media_json,'$.alias') FROM task_outputs o WHERE o.task_id=? AND o.output_index=? AND (o.committed=1 OR EXISTS(SELECT 1 FROM tasks t WHERE t.task_id=o.task_id AND json_extract(t.record_json,'$.deliveryState')='discarded'))")?
                    .query_row(params![task,index], |row| row.get(0)).optional()?;
                stored.filter(|stored| stored == alias)
            }
            Some(Origin::Input(task, name, alias)) => {
                let stored: Option<String> = db.prepare_cached("SELECT json_extract(media_json,'$.alias') FROM task_inputs WHERE task_id=? AND name=? AND committed=1")?
                    .query_row(params![task,name], |row| row.get(0)).optional()?;
                stored.filter(|stored| stored == alias)
            }
            Some(Origin::Migration(id, alias, record)) => {
                let query = if *record {
                    "SELECT i.item_id FROM migration_items i JOIN migration_sessions s ON s.migration_id=i.migration_id WHERE i.migration_id=? AND i.item_id=? AND s.state='activated'"
                } else {
                    "SELECT m.alias FROM migration_media m JOIN migration_sessions s ON s.migration_id=m.migration_id WHERE m.migration_id=? AND m.alias=? AND s.state='activated'"
                };
                db.prepare_cached(query)?.query_row(params![id,alias], |row| row.get(0)).optional()?
            }
            _ => None,
        };
        Ok(alias.is_some_and(|alias| {
            self.alias_hash
                .as_ref()
                .is_none_or(|hash| *hash == canonical::digest(alias))
        }))
    }
    pub fn empty(&self) -> bool {
        self.alias_hash.is_none()
    }
    pub fn current(&self, root: &std::path::Path) -> Result<Option<PathBuf>> {
        let folder = schema::safe(root, format!("media/staging/{}", self.key))?;
        if discovery::missing(&folder)? || file_identity::path(&folder, true)? != self.native {
            return Ok(None);
        }
        match (&self.alias_hash, &self.proof) {
            (Some(alias), Some(proof)) => {
                let path = schema::safe(&folder, alias)?;
                Ok(proof.current(&path)?.then_some(path))
            }
            (None, None) => Ok(fs::read_dir(&folder)?.next().is_none().then_some(folder)),
            _ => Ok(None),
        }
    }
}
