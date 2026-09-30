use super::*;
mod discovery;
pub(super) use discovery::{Candidates, Completion, Discovery};
#[cfg(test)]
mod lifecycle_tests;
#[cfg(test)]
mod tests;
use canonical::digest;
use std::{
    collections::{HashMap, HashSet},
    fs,
    time::UNIX_EPOCH,
};

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
            remove_metadata(c, &hash)?;
            removed += 1;
        }
        clean_staging(c)?;
        completion.check(c)?;
        let receipt=json!({"operationId":completion.operation_id,"kind":"collectGarbage","revision":c.next_revision()?,"removed":removed});
        c.commit_operation(&completion.key,&receipt)?;Ok(receipt)
    })
}
fn protected(c: &Context, hash: &str) -> Result<bool> {
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
    for version in ["thumbnails-v1", "thumbnails-rust-v1"] {
        let thumbnail = schema::safe(&c.root, format!("cache/{version}/{hash}.jpg"))?;
        if thumbnail.exists() {
            fs::remove_file(thumbnail)?;
        }
    }
    c.db.execute("DELETE FROM media_aliases WHERE hash=?", [hash])?;
    c.db.execute("DELETE FROM media_objects WHERE hash=?", [hash])?;
    Ok(())
}
fn clean_staging(c: &Context) -> Result<()> {
    let staging = schema::safe(&c.root, "media/staging")?;
    if !staging.exists() {
        return Ok(());
    }
    let mut entries = fs::read_dir(&staging)?;
    let Some(first) = entries.next().transpose()? else {
        return Ok(());
    };
    let mut completed =
        c.db.prepare("SELECT op_key FROM operations WHERE state IN ('committed','aborted')")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, None::<String>)))?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    let rows=c.db.prepare("SELECT task_id,output_index AS identity,json_extract(media_json,'$.alias') AS alias,'output' AS kind FROM task_outputs WHERE committed=1 OR task_id IN (SELECT task_id FROM tasks WHERE json_extract(record_json,'$.deliveryState')='discarded') UNION ALL SELECT task_id,name AS identity,json_extract(media_json,'$.alias') AS alias,'input' AS kind FROM task_inputs WHERE committed=1")?
        .query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,rusqlite::types::Value>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for (task, identity, alias, kind) in rows {
        let identity = match identity {
            rusqlite::types::Value::Integer(v) => v.to_string(),
            rusqlite::types::Value::Text(v) => v,
            _ => continue,
        };
        let tag = if kind == "output" { "task" } else { "input" };
        completed.insert(
            digest(format!("{tag}:{task}:{identity}")),
            Some(digest(alias)),
        );
    }
    let leased=c.db.prepare("SELECT id FROM leases UNION SELECT operation_key FROM leases WHERE operation_key IS NOT NULL")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;
    for item in std::iter::once(Ok(first)).chain(entries) {
        c.check_cancel()?;
        let item = item?;
        let key = item.file_name().to_string_lossy().into_owned();
        if !media::valid_hash(&key) || leased.contains(&key) {
            continue;
        }
        let Some(alias_hash) = completed.get(&key) else {
            continue;
        };
        let folder = schema::safe(&staging, &key)?;
        for entry in fs::read_dir(&folder)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !media::valid_hash(&name) || alias_hash.as_ref().is_some_and(|a| a != &name) {
                continue;
            }
            let file = schema::safe(&folder, name)?;
            let stat = fs::metadata(&file)?;
            if stat.is_file() && expired(&stat)? {
                fs::remove_file(file)?;
            }
        }
        if fs::read_dir(&folder)?.next().is_none() {
            fs::remove_dir(folder)?;
        }
    }
    Ok(())
}
