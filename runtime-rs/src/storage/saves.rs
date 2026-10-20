use super::*;
use canonical::{entity_key, stringify};
use operations::Operation;
use rusqlite::{OptionalExtension, params};
pub(super) mod commit;
pub(super) fn state(c: &Context, mut row: Operation, library: bool) -> Result<Value> {
    let media = if row.kind == "saveArtwork" || (library && row.kind == "prepareMedia") {
        let mut input = row.input.get_mut("media").map(Value::take).unwrap_or_default();
        input["writtenBytes"] = if row.state == "committed" {
            input["bytes"].clone()
        } else {
            json!(media::uploaded(c, &row.key, &input)?)
        };
        Some(input)
    } else {
        None
    };
    let mut state = row.into_state();
    if let Some(media) = media {
        state["media"] = media;
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
struct UploadOperation {
    key: String,
    state: String,
    media: Value,
}
fn upload_operation(c: &Context, principal: &str, id: &str, kind: &str) -> Result<UploadOperation> {
    let projected = (|| -> Result<_> {
        let mut statement = c.db.prepare_cached(
            "SELECT op_key,kind,state,input_json->'$.media',
             receipt_json IS NULL OR json_valid(receipt_json)
             FROM operations WHERE principal_id=? AND operation_id=?",
        )?;
        let mut rows = statement.query(params![principal, id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        if !row.get::<_, bool>(4)? {
            return Err(invalid("Invalid stored operation receipt"));
        }
        let media = if matches!(row.get_ref(3)?, rusqlite::types::ValueRef::Null) {
            Value::Null
        } else {
            serde_json::from_str(text_column(row, 3)?)?
        };
        Ok(Some((
            row.get::<_, String>(1)?,
            UploadOperation {
                key: row.get(0)?,
                state: row.get(2)?,
                media,
            },
        )))
    })();
    let (stored_kind, operation) = match projected {
        Ok(Some(operation)) => operation,
        Ok(None) => {
            return Err(ApiError::new(404, "NOT_FOUND", "Save operation does not exist"));
        }
        Err(_) => {
            // Preserve the full reader's persisted JSON/type errors. Normal
            // chunk reads never allocate the artwork recipe or old receipt.
            let mut row = prepared(c, principal, id, kind)?;
            return Ok(UploadOperation {
                key: row.key,
                state: row.state,
                media: row.input.get_mut("media").map(Value::take).unwrap_or_default(),
            });
        }
    };
    if stored_kind != kind {
        return Err(conflict(
            "OPERATION_CONFLICT",
            "Operation ID belongs to a different command",
        ));
    }
    Ok(operation)
}
pub(super) fn prepare_chunk(
    c: &Context,
    principal: &str,
    command: &Value,
) -> Result<upload::Prepared> {
    let id = string(command, "operationId")?;
    let library = command["kind"] == "uploadMediaChunk";
    let row = upload_operation(
        c,
        principal,
        id,
        if library {
            "prepareMedia"
        } else {
            "saveArtwork"
        },
    )?;
    if row.state == "aborted" {
        return Err(conflict("OPERATION_CONFLICT", "Save operation was aborted"));
    }
    if library && row.state == "committed" {
        return Ok(upload::Prepared::Complete(
            json!({"operationId":id,"offset":row.media["bytes"]}),
        ));
    }
    Ok(upload::Chunk::new(
        row.key,
        row.media,
        row.state == "committed",
        json!({"operationId":id}),
    ))
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
    if kind == "abortSave" {
        let row = prepared(c, principal, id, "saveArtwork")?;
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
        return state(c, prepared(c, principal, id, "saveArtwork")?, false);
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
    let row = c.transaction(|c| {
        if let Some(row) = c.operation(principal, id)? {
            // A matching aborted artwork save is a terminal recovery read, not
            // a reopened preparation. Return it without creating a staging lease.
            // Other kinds/inputs still take the ordinary conflict path below.
            if !library
                && row.state == "aborted"
                && row.kind == op_kind
                && row.fingerprint == canonical::fingerprint(command)
            {
                return Ok(Some(row));
            }
            row.check(op_kind, command)?;
            return Ok(Some(row));
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
        Ok(None)
    })?;
    let row = match row {
        Some(row) => row,
        None => prepared(c, principal, id, op_kind)?,
    };
    state(c, row, library)
}
