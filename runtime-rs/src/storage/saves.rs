use super::*;
use canonical::{entity_key, stringify};
use operations::Operation;
use rusqlite::{OptionalExtension, params};
pub(super) fn state(c: &Context, row: &Operation, library: bool) -> Result<Value> {
    let mut state = row.state();
    if row.kind == "saveArtwork" || (library && row.kind == "prepareMedia") {
        let mut input = row.input["media"].clone();
        input["writtenBytes"] = if row.state == "committed" {
            input["bytes"].clone()
        } else {
            json!(media::uploaded(c, &row.key, &input)?)
        };
        state["media"] = input;
    }
    Ok(state)
}
fn alias_check(c: &Context, media: &Value) -> Result<()> {
    let old: Option<String> =
        c.db.query_row(
            "SELECT hash FROM media_aliases WHERE alias=?",
            [string(media, "alias")?],
            |r| r.get(0),
        )
        .optional()?;
    if old
        .as_deref()
        .is_some_and(|old| Some(old) != media["sha256"].as_str())
    {
        return Err(conflict(
            "OPERATION_CONFLICT",
            "Media alias already identifies different bytes",
        ));
    }
    Ok(())
}
fn prepared(c: &Context, principal: &str, id: &str, kind: &str) -> Result<Operation> {
    let row = c
        .operation(principal, id)?
        .ok_or_else(|| ApiError::new(404, "NOT_FOUND", "Save operation does not exist"))?;
    if row.kind != kind {
        return Err(conflict(
            "OPERATION_CONFLICT",
            "Operation ID belongs to a different command",
        ));
    }
    Ok(row)
}
pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let kind = string(command, "kind")?;
    if kind == "countMedia" {
        return Ok(json!(c.db.query_row(
            "SELECT count(*) FROM media_aliases",
            [],
            |r| r.get::<_, i64>(0)
        )?));
    }
    let id = string(command, "operationId")?;
    if matches!(kind, "prepareSave" | "prepareMedia") {
        return prepare(c, principal, command);
    }
    if matches!(
        kind,
        "uploadChunk" | "commitSave" | "abortSave" | "uploadMediaChunk" | "commitMedia"
    ) {
        let library = matches!(kind, "uploadMediaChunk" | "commitMedia");
        let row = prepared(
            c,
            principal,
            id,
            if library {
                "prepareMedia"
            } else {
                "saveArtwork"
            },
        )?;
        if kind == "abortSave" {
            if row.state != "committed" {
                c.transaction(|c| {
                    c.db.execute(
                        "UPDATE operations SET state='aborted' WHERE op_key=?",
                        [&row.key],
                    )?;
                    c.db.execute("DELETE FROM leases WHERE operation_key=?", [&row.key])?;
                    Ok(())
                })?;
            }
            return state(c, &prepared(c, principal, id, "saveArtwork")?, false);
        }
        if row.state == "aborted" {
            return Err(conflict("OPERATION_CONFLICT", "Save operation was aborted"));
        }
        if matches!(kind, "uploadChunk" | "uploadMediaChunk") {
            // Keep the legacy library-media retry behavior, while save chunks verify exact bytes.
            let offset = if library && row.state == "committed" {
                row.input["media"]["bytes"].as_u64().unwrap()
            } else {
                media::upload(
                    c,
                    &row.key,
                    &row.input["media"],
                    command,
                    row.state == "committed",
                )?
            };
            return Ok(json!({"operationId":id,"offset":offset}));
        }
        return commit(c, &row, library);
    }
    if kind == "appendArtwork"
        && c.operation(principal, id)?
            .is_none_or(|row| row.receipt.is_none())
    {
        c.resolve_media(string(&command["artwork"], "image_id")?)?;
    }
    c.transaction(|c| {
        let (key, previous) = c.start_operation(principal, command)?;
        if let Some(receipt) = previous {
            return Ok(receipt);
        }
        let revision = c.next_revision()?;
        let mut receipt = json!({"operationId":id,"kind":kind,"revision":revision});
        if kind == "releaseMedia" {
            c.db.execute(
                "DELETE FROM media_refs WHERE owner_kind='temporary' AND owner_id=?",
                [string(command, "alias")?],
            )?;
        } else {
            let art = &command["artwork"];
            let artwork_key = entity_key(&art["id"])?;
            if records::artwork(c, &artwork_key)?.is_some() {
                return Err(conflict("OPERATION_CONFLICT", "Artwork already exists"));
            }
            let alias = string(art, "image_id")?;
            let hash: String =
                c.db.query_row(
                    "SELECT hash FROM media_aliases WHERE alias=?",
                    [alias],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| conflict("MEDIA_INVALID", "Artwork media is unavailable"))?;
            c.db.execute(
                "INSERT INTO artworks VALUES(?,?,?,?,NULL)",
                params![artwork_key, stringify(&art["id"]), stringify(art), revision],
            )?;
            c.db.execute(
                "INSERT INTO media_refs VALUES('artwork',?,?)",
                params![artwork_key, hash],
            )?;
            c.db.execute(
                "DELETE FROM media_refs WHERE owner_kind='temporary' AND owner_id=?",
                [alias],
            )?;
            receipt["artwork"] = records::artwork(c, &artwork_key)?.unwrap();
        }
        c.commit_operation(&key, &receipt)?;
        Ok(receipt)
    })
}
fn prepare(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let library = command["kind"] == "prepareMedia";
    let media = &command["media"];
    media::validate(media)?;
    let id = string(command, "operationId")?;
    let op_kind = if library {
        "prepareMedia"
    } else {
        "saveArtwork"
    };
    if !library {
        entity_key(&command["artwork"]["id"])?;
        if command["artwork"]
            .get("image_id")
            .is_some_and(|id| id != &media["alias"])
        {
            return Err(conflict("MEDIA_INVALID", "Artwork media alias differs"));
        }
    }
    c.transaction(|c| {
        if let Some(row) = c.operation(principal, id)? {
            row.check(op_kind, command)?;
            return Ok(());
        }
        if !library && records::artwork(c, &entity_key(&command["artwork"]["id"])?)?.is_some() {
            return Err(conflict("OPERATION_CONFLICT", "Artwork ID already exists"));
        }
        alias_check(c, media)?;
        let key = c.insert_operation(principal, id, op_kind, command)?;
        c.db.execute(
            "INSERT INTO leases VALUES(?,'staging',?,?,?)",
            params![key, string(media, "sha256")?, key, now()],
        )?;
        Ok(())
    })?;
    state(c, &prepared(c, principal, id, op_kind)?, library)
}
fn commit(c: &mut Context, row: &Operation, library: bool) -> Result<Value> {
    if let Some(receipt) = &row.receipt {
        return Ok(receipt.clone());
    }
    let media = &row.input["media"];
    media::publish(c, &row.key, media)?;
    c.check_cancel()?;
    let receipt=c.transaction(|c| {
        alias_check(c,media)?;
        let hash=string(media,"sha256")?;let alias=string(media,"alias")?;
        let revision=c.next_revision()?;
        c.db.execute("INSERT OR IGNORE INTO media_objects VALUES(?,?,?)",params![hash,media["bytes"].as_i64(),string(media,"mime")?])?;
        c.db.execute("INSERT OR IGNORE INTO media_aliases VALUES(?,?)",params![alias,hash])?;
        let mut receipt=json!({"operationId":row.id,"kind":if library {"commitMedia"} else {"saveArtwork"},"revision":revision});
        if library {c.db.execute("INSERT OR IGNORE INTO media_refs VALUES('temporary',?,?)",params![alias,hash])?;} else {
            let mut body=row.input["artwork"].clone();let key=entity_key(&body["id"])?;
            if records::artwork(c,&key)?.is_some() {return Err(conflict("OPERATION_CONFLICT","Artwork ID already exists"))}
            body["image_id"]=json!(alias);
            c.db.execute("INSERT INTO artworks VALUES(?,?,?,?,NULL)",params![key,stringify(&body["id"]),stringify(&body),revision])?;
            c.db.execute("INSERT INTO media_refs VALUES('artwork',?,?)",params![key,hash])?;
            receipt["artwork"]=records::artwork(c,&key)?.unwrap();
        }
        c.commit_operation(&row.key,&receipt)?;c.db.execute("DELETE FROM leases WHERE operation_key=?",[&row.key])?;Ok(receipt)
    })?;
    media::cleanup(c, &row.key, media);
    Ok(receipt)
}
