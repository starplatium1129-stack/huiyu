use super::*;
const FORMAT: &str = "huiyu-chat-archive-chunks-v1";

pub(in crate::storage) fn decode(db: &Connection, value: Value) -> Result<Value> {
    if value["storageFormat"] != FORMAT {
        return Ok(value);
    }
    let value = manifest(db, &value)?;
    let branches = value["archived"]
        .as_object()
        .ok_or_else(|| invalid("Invalid archive chunk manifest"))?;
    let mut archived = serde_json::Map::new();
    let mut lookup = db.prepare_cached("SELECT body FROM profile_archive_chunks WHERE hash=?")?;
    for (id, groups) in branches {
        let mut messages = Vec::new();
        for chunks in groups
            .as_array()
            .ok_or_else(|| invalid("Invalid archive groups"))?
        {
            let text = join(&mut lookup, chunks)?;
            let Value::Array(mut group) = serde_json::from_str(&text)? else {
                return Err(invalid("Invalid archive messages"));
            };
            messages.append(&mut group);
        }
        archived.insert(id.clone(), Value::Array(messages));
    }
    Ok(json!({"version":value["version"],"archived":archived,"revisions":value["revisions"]}))
}
fn join(lookup: &mut rusqlite::CachedStatement<'_>, chunks: &Value) -> Result<String> {
    let mut text = String::new();
    for hash in chunks
        .as_array()
        .ok_or_else(|| invalid("Invalid archive chunks"))?
    {
        let hash = hash
            .as_str()
            .filter(|hash| media::valid_hash(hash))
            .ok_or_else(|| invalid("Invalid archive chunk digest"))?;
        let data: String = lookup
            .query_row([hash], |row| row.get(0))
            .optional()?
            .ok_or_else(|| {
                conflict(
                    "ARCHIVE_CHUNK_MISSING",
                    "Chat archive chunk is missing; retry the save",
                )
            })?;
        if canonical::digest(data.as_bytes()) != hash {
            return Err(invalid("Chat archive chunk digest mismatch"));
        }
        text.push_str(&data);
    }
    Ok(text)
}
fn manifest(db: &Connection, value: &Value) -> Result<Value> {
    let mut lookup = db.prepare_cached("SELECT body FROM profile_archive_chunks WHERE hash=?")?;
    Ok(serde_json::from_str(&join(
        &mut lookup,
        &value["manifest"],
    )?)?)
}

pub(super) fn execute(c: &mut Context, command: &Value) -> Result<Value> {
    if command["expectedReset"] != reset(c)? {
        return Err(conflict(
            "PROFILE_RESET_CONFLICT",
            "Chat was reset in another window",
        ));
    }
    c.transaction(|c| {
        if command["kind"] == "profile.archiveMissing" {
            let hashes = command["hashes"].as_array().ok_or_else(|| invalid("Invalid archive chunk list"))?;
            if hashes.len() > 1000 { return Err(invalid("Too many archive chunks")); }
            let mut missing = Vec::new();
            let mut touch = c.db.prepare_cached("UPDATE profile_archive_chunks SET touched=? WHERE hash=?")?;
            for hash in hashes {
                c.check_cancel()?;
                let hash = hash.as_str().filter(|hash| media::valid_hash(hash)).ok_or_else(|| invalid("Invalid archive chunk digest"))?;
                // Pin retained chunks during a multi-request save. Concurrent commits
                // may collect only old, unreferenced uploads.
                if touch.execute(params![now(),hash])? == 0 { missing.push(hash); }
            }
            Ok(json!(missing))
        } else {
            let hash = string(command,"hash")?;
            let data = string(command,"data")?;
            if data.len() > 384 * 1024 || !media::valid_hash(hash) || canonical::digest(data.as_bytes()) != hash {
                return Err(invalid("Invalid archive chunk bytes or digest"));
            }
            c.db.execute("INSERT INTO profile_archive_chunks VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET touched=excluded.touched",params![hash,data,now()])?;
            Ok(json!({"hash":hash}))
        }
    })
}

pub(super) fn collect(c: &Context, manifest: &Value) -> Result<()> {
    let mut retained = std::collections::HashSet::new();
    if manifest["storageFormat"] == FORMAT {
        for hash in manifest["manifest"]
            .as_array()
            .ok_or_else(|| invalid("Invalid archive manifest chunks"))?
        {
            retained.insert(
                hash.as_str()
                    .ok_or_else(|| invalid("Invalid archive hash"))?
                    .to_owned(),
            );
        }
        let decoded = self::manifest(&c.db, manifest)?;
        for groups in decoded["archived"]
            .as_object()
            .ok_or_else(|| invalid("Invalid archive manifest"))?
            .values()
        {
            for chunks in groups
                .as_array()
                .ok_or_else(|| invalid("Invalid archive groups"))?
            {
                for hash in chunks
                    .as_array()
                    .ok_or_else(|| invalid("Invalid archive chunks"))?
                {
                    retained.insert(
                        hash.as_str()
                            .ok_or_else(|| invalid("Invalid archive hash"))?
                            .to_owned(),
                    );
                }
            }
        }
    }
    let old =
        c.db.prepare("SELECT hash FROM profile_archive_chunks WHERE touched<?")?
            .query_map([now() - 24 * 60 * 60 * 1000], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut delete =
        c.db.prepare_cached("DELETE FROM profile_archive_chunks WHERE hash=?")?;
    for hash in old {
        c.check_cancel()?;
        if !retained.contains(&hash) {
            delete.execute([hash])?;
        }
    }
    Ok(())
}
