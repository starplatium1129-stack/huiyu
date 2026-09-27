use super::*;
use canonical::digest;
use std::{
    collections::{HashMap, HashSet},
    fs,
    time::UNIX_EPOCH,
};

pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let (key, previous) = c.transaction(|c| c.start_operation(principal, command))?;
    if let Some(receipt) = previous {
        return Ok(receipt);
    }
    c.transaction(|c| {
        let protected=c.db.prepare("SELECT hash FROM media_refs UNION SELECT hash FROM leases WHERE hash IS NOT NULL")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;
        let directory=schema::safe(&c.root,"media/objects")?;let mut removed=0;
        if directory.exists() {for prefix in fs::read_dir(&directory)? {
            let prefix=prefix?;let name=prefix.file_name().to_string_lossy().into_owned();
            if name.len()!=2||!name.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c)) {continue}
            let folder=schema::safe(&directory,&name)?;if !folder.is_dir() {continue}
            for item in fs::read_dir(folder)? {
                c.check_cancel()?;let item=item?;let hash=item.file_name().to_string_lossy().into_owned();
                if !media::valid_hash(&hash)||!hash.starts_with(&name)||protected.contains(&hash) {continue}
                let file=media::object_path(&c.root,&hash)?;let stat=fs::metadata(&file)?;
                if !stat.is_file()||!expired(&stat)? {continue}
                fs::remove_file(file)?;remove_metadata(c,&hash)?;removed+=1;
            }
        }}
        let hashes=c.db.prepare("SELECT hash FROM media_objects")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for hash in hashes {c.check_cancel()?;if protected.contains(&hash)||media::object_path(&c.root,&hash)?.exists() {continue}remove_metadata(c,&hash)?;removed+=1;}
        clean_staging(c)?;
        let receipt=json!({"operationId":command["operationId"],"kind":"collectGarbage","revision":c.next_revision()?,"removed":removed});
        c.commit_operation(&key,&receipt)?;Ok(receipt)
    })
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
    let mut completed =
        c.db.prepare("SELECT op_key FROM operations WHERE state IN ('committed','aborted')")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, None::<String>)))?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    let rows=c.db.prepare("SELECT task_id,output_index AS identity,json_extract(media_json,'$.alias') AS alias,'output' AS kind FROM task_outputs WHERE committed=1 UNION ALL SELECT task_id,name AS identity,json_extract(media_json,'$.alias') AS alias,'input' AS kind FROM task_inputs WHERE committed=1")?
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
    for item in fs::read_dir(&staging)? {
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
