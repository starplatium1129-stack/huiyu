use super::*;
use canonical::{entity_key, stringify};
use operations::Operation;
use rusqlite::{OptionalExtension, params};
pub(super) mod commit;
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
    if matches!(kind, "uploadChunk" | "abortSave" | "uploadMediaChunk") {
        let library = kind == "uploadMediaChunk";
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
        // Keep the library-media retry behavior, while save chunks verify exact bytes.
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
    c.transaction(|c| {
        let (key, previous) = c.start_operation(principal, command)?;
        if let Some(receipt) = previous {
            return Ok(receipt);
        }
        let revision = c.next_revision()?;
        let receipt = json!({"operationId":id,"kind":kind,"revision":revision});
        c.db.execute(
            "DELETE FROM media_refs WHERE owner_kind='temporary' AND owner_id=?",
            [string(command, "alias")?],
        )?;
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
