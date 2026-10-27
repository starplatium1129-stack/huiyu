mod records;
pub(super) mod verification;
use super::*;
use canonical::{digest, fingerprint, fingerprint_object, stringify};
use rusqlite::{OptionalExtension, params};
use std::collections::HashSet;

struct Session {
    envelope: Value,
    state: String,
    report: Value,
    revision: i64,
}
fn session(c: &Context, id: &str, principal: &str) -> Result<Session> {
    // Keep JSON failures outside rusqlite so column errors retain their priority.
    let row = c.db.query_row(
        "SELECT envelope,state,report,revision FROM migration_sessions WHERE migration_id=? AND principal_id=?",
        params![id, principal],
        |row| Ok((
            serde_json::from_str::<Value>(text_column(row, 0)?),
            row.get::<_, String>(1)?,
            serde_json::from_str::<Value>(text_column(row, 2)?),
            row.get::<_, i64>(3)?,
        )),
    ).optional()?.ok_or_else(|| ApiError::new(404, "NOT_FOUND", "Migration session does not exist"))?;
    Ok(Session {
        envelope: row.0?,
        state: row.1,
        report: row.2?,
        revision: row.3,
    })
}
fn status(c: &Context, id: &str, principal: &str) -> Result<Value> {
    let session = session(c, id, principal)?;
    let envelope = session.envelope;
    let mut result = json!({"migrationId":id,"workspaceId":c.workspace_id,"fingerprint":envelope["fingerprint"],"source":envelope["source"],"state":session.state,"revision":session.revision,"totalRecords":envelope["records"].as_array().unwrap().len(),"totalMedia":envelope["media"].as_array().unwrap().len(),"importedRecords":c.db.query_row("SELECT COUNT(*) FROM migration_items WHERE migration_id=?",[id],|r|r.get::<_,i64>(0))?,"importedMedia":c.db.query_row("SELECT COUNT(*) FROM migration_media WHERE migration_id=? AND complete=1",[id],|r|r.get::<_,i64>(0))?,"blockers":null,"domains":["artwork","settings","chat","draft"]});
    result["blockers"] = session.report;
    Ok(result)
}
fn format_error(message: &str) -> ApiError {
    conflict("MIGRATION_FORMAT", message)
}
fn validate(envelope: &Value) -> Result<()> {
    if envelope["format"] != "huiyu-migration"
        || envelope["version"] != 1
        || envelope["source"]["sourceProfileId"]
            .as_str()
            .is_none_or(str::is_empty)
        || envelope["source"]["origin"]
            .as_str()
            .is_none_or(str::is_empty)
        || !envelope["source"]["windowIds"].is_array()
        || !envelope["records"].is_array()
        || !envelope["media"].is_array()
        || !envelope["blockers"].is_array()
        || envelope["credentials"]["verified"] != true
    {
        return Err(format_error(
            "Migration source identity or classification is incomplete",
        ));
    }
    string(envelope, "migrationId")?;
    let unsigned = envelope
        .as_object()
        .unwrap()
        .iter()
        .filter(|(field, _)| field.as_str() != "fingerprint");
    if fingerprint_object(unsigned) != envelope["fingerprint"] {
        return Err(format_error(
            "Migration manifest fingerprint does not match",
        ));
    }
    let records = envelope["records"].as_array().unwrap();
    let media = envelope["media"].as_array().unwrap();
    if !envelope["blockers"].as_array().unwrap().is_empty()
        || records.iter().any(|r| {
            matches!(
                r["domain"].as_str(),
                Some("credential" | "unknown" | "transient")
            )
        })
    {
        return Err(conflict(
            "MIGRATION_BLOCKED",
            "Source contains unclassified records or credentials",
        ));
    }
    let mut seen = HashSet::new();
    for record in records {
        let key = string(record, "key")?;
        let source = string(record, "source")?;
        if !seen.insert(string(record, "id")?) {
            return Err(format_error("Duplicate migration item identity"));
        }
        if !matches!(source, "kv" | "local" | "session")
            || key.is_empty()
            || !record["sha256"].as_str().is_some_and(media::valid_hash)
            || record.get("bytes").is_some_and(|v| {
                v.as_u64()
                    .is_none_or(|n| n == 0 || n > 9_007_199_254_740_991)
            })
            || (source == "session"
                && (record["windowId"].as_str().is_none_or(str::is_empty)
                    || !envelope["source"]["windowIds"]
                        .as_array()
                        .unwrap()
                        .contains(&record["windowId"])))
        {
            return Err(format_error(
                "Record classification does not match a supported source",
            ));
        }
        if matches!(
            record["domain"].as_str(),
            Some("settings" | "chat" | "draft")
        ) && profile::domain(if key == "chat_archive_v1" {
            "aics_chat_archive_v1"
        } else {
            key
        }) != record["domain"].as_str()
        {
            return Err(format_error(
                "Record classification does not match a supported source",
            ));
        }
    }
    seen.clear();
    for entry in media {
        if !seen.insert(string(entry, "alias")?) {
            return Err(format_error("Duplicate migration item identity"));
        }
        if media::validate(entry).is_err() || profile::credential(&entry["metadata"]) {
            return Err(format_error("Invalid media manifest"));
        }
    }
    Ok(())
}
pub(super) fn key(id: &str, alias: &str) -> String {
    digest(stringify(&json!(["migration", id, alias])))
}
pub(super) fn prepare_chunk(
    c: &Context,
    principal: &str,
    command: &Value,
) -> Result<upload::Prepared> {
    let id = string(command, "migrationId")?;
    let record = command["kind"] == "migration.recordChunk";
    let (name, media, receipt) = if record {
        let session = session(c, id, principal)?;
        let item = string(command, "itemId")?;
        let expected = session.envelope["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == item)
            .ok_or_else(|| format_error("Record chunk is outside an importing manifest"))?;
        if expected["bytes"].as_u64().is_none_or(|bytes| bytes == 0) || session.state != "importing"
        {
            return Err(format_error(
                "Record chunk is outside an importing manifest",
            ));
        }
        (
            format!("record:{item}"),
            json!({"alias":item,"bytes":expected["bytes"],
            "sha256":expected["sha256"],"mime":"application/json"}),
            json!({"itemId":item}),
        )
    } else {
        let state =
            c.db.prepare_cached(
                "SELECT state FROM migration_sessions WHERE migration_id=? AND principal_id=?",
            )?
            .query_row(params![id, principal], |row| row.get::<_, String>(0))
            .optional()?
            .ok_or_else(|| ApiError::new(404, "NOT_FOUND", "Migration session does not exist"))?;
        if state != "importing" {
            return Err(conflict(
                "MIGRATION_CONFLICT",
                "Verified migration is immutable",
            ));
        }
        let alias = string(command, "alias")?;
        // begin stores these immutable fields with the envelope in one
        // transaction. Each chunk still rechecks ownership and state before
        // and after writing, without decoding/scanning the entire manifest.
        let media =
            c.db.prepare_cached(
                "SELECT sha256,bytes,mime FROM migration_media WHERE migration_id=? AND alias=?",
            )?
            .query_row(params![id, alias], |row| {
                Ok(json!({
                    "alias": alias,
                    "sha256": row.get::<_, String>(0)?,
                    "bytes": row.get::<_, i64>(1)?,
                    "mime": row.get::<_, String>(2)?,
                }))
            })
            .optional()?
            .ok_or_else(|| format_error("Media is not in the manifest"))?;
        (alias.to_owned(), media, json!({"alias":alias}))
    };
    Ok(upload::Prepared::Write(upload::Chunk {
        key: key(id, &name),
        media,
        committed: false,
        record,
        receipt,
    }))
}
pub(super) fn complete_record_chunk(
    c: &mut Context,
    principal: &str,
    command: &Value,
    record: Value,
) -> Result<()> {
    let id = string(command, "migrationId")?;
    let session = session(c, id, principal)?;
    import_record(c, id, &session, string(command, "itemId")?, &record).map(|_| ())
}
pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let kind = string(command, "kind")?;
    c.check_cancel()?;
    if kind == "migration.begin" {
        return begin(c, principal, &command["envelope"]);
    }
    let id = string(command, "migrationId")?;
    if kind == "migration.status" {
        return status(c, id, principal);
    }
    let session = session(c, id, principal)?;
    let envelope = &session.envelope;
    match kind {
        "migration.activate" => {
            if !matches!(session.state.as_str(), "verified" | "activated") {
                return Err(conflict("MIGRATION_BLOCKED", "Candidate is not verified"));
            }
            if command["expectedFingerprint"] != envelope["fingerprint"] {
                return Err(conflict(
                    "MIGRATION_CONFLICT",
                    "Activation source fingerprint changed",
                ));
            }
            c.transaction(|c| {
                profile::media_refs::refresh_all(c)?;
                release_protection(c, id, envelope)?;
                c.db.execute(
                    "UPDATE migration_sessions SET state='activated' WHERE migration_id=?",
                    [id],
                )?;
                Ok(())
            })?;
            status(c, id, principal)
        }
        "migration.record" => import_record(
            c,
            id,
            &session,
            string(command, "itemId")?,
            &command["record"],
        ),
        _ => Err(invalid("Unknown migration command")),
    }
}
fn begin(c: &mut Context, principal: &str, envelope: &Value) -> Result<Value> {
    validate(envelope)?;
    if envelope.get("target").is_some()
        && envelope["target"]["workspaceId"].as_str() != Some(c.workspace_id.as_str())
    {
        return Err(conflict(
            "MIGRATION_CONFLICT",
            "Migration backup belongs to another candidate workspace",
        ));
    }
    let id = string(envelope, "migrationId")?;
    c.transaction(|c| {
        let previous=c.db.query_row("SELECT fingerprint,principal_id FROM migration_sessions WHERE migration_id=?",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
        if let Some((fingerprint,owner))=previous {if owner!=principal||json!(fingerprint)!=envelope["fingerprint"] {return Err(conflict("MIGRATION_CONFLICT","Source snapshot changed; create a new migration session"))}return Ok(())}
        if c.db.prepare("SELECT 1 FROM artworks UNION ALL SELECT 1 FROM projects UNION ALL SELECT 1 FROM migration_sessions LIMIT 1")?.exists([])? {return Err(conflict("MIGRATION_CONFLICT","Import requires an independent empty candidate workspace"))}
        c.db.execute("INSERT INTO migration_sessions VALUES(?,?,?,?,'importing','[]',0)",params![id,principal,string(envelope,"fingerprint")?,stringify(envelope)])?;
        for media in envelope["media"].as_array().unwrap() {
            let alias=string(media,"alias")?;let hash=string(media,"sha256")?;
            c.db.prepare_cached("INSERT INTO migration_media VALUES(?,?,?,?,?,0)")?.execute(params![id,alias,hash,media["bytes"].as_i64(),string(media,"mime")?])?;
            c.db.prepare_cached("INSERT INTO leases VALUES(?,'migration',?,NULL,?)")?.execute(params![key(id,alias),hash,now()])?;
        }Ok(())
    })?;
    status(c, id, principal)
}
fn import_record(
    c: &mut Context,
    id: &str,
    session: &Session,
    item: &str,
    record: &Value,
) -> Result<Value> {
    let expected = session.envelope["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == item)
        .ok_or_else(|| format_error("Record digest does not match the manifest"))?;
    if fingerprint(record) != expected["sha256"] || profile::credential(&record["value"]) {
        return Err(format_error(
            "Record digest does not match the manifest or contains a credential",
        ));
    }
    let expected_fields = expected
        .as_object()
        .unwrap()
        .iter()
        .filter(|(field, _)| !["id", "sha256", "bytes"].contains(&field.as_str()));
    let actual = record
        .as_object()
        .ok_or_else(|| format_error("Invalid source record"))?
        .iter()
        .filter(|(field, _)| field.as_str() != "value");
    if fingerprint_object(expected_fields) != fingerprint_object(actual) {
        return Err(format_error(
            "Record does not match its classified manifest entry",
        ));
    }
    if c.db
        .prepare("SELECT 1 FROM migration_items WHERE migration_id=? AND item_id=?")?
        .exists(params![id, item])?
    {
        return Ok(json!({"itemId":item,"imported":false}));
    }
    if session.state != "importing" {
        return Err(conflict(
            "MIGRATION_CONFLICT",
            "Verified migration is immutable",
        ));
    }
    c.transaction(|c| {
        c.db.execute(
            "INSERT INTO migration_items VALUES(?,?,?,?)",
            params![id, item, string(expected, "sha256")?, stringify(record)],
        )?;
        Ok(())
    })?;
    Ok(json!({"itemId":item,"imported":true}))
}

fn release_protection(c: &Context, id: &str, envelope: &Value) -> Result<()> {
    c.db.execute(
        "DELETE FROM media_refs WHERE owner_kind='migration' AND owner_id=?",
        [id],
    )?;
    for media in envelope["media"].as_array().unwrap() {
        c.check_cancel()?;
        c.db.prepare_cached("DELETE FROM leases WHERE kind='migration' AND id=?")?
            .execute([key(id, string(media, "alias")?)])?;
    }
    Ok(())
}

// Retire the old permanent migration pins only after live profile references
// have been rebuilt. New activations do this atomically; restored older v3
// workspaces receive the same repair before admitting requests.
pub(super) fn repair_activated(c: &mut Context) -> Result<()> {
    let sessions = c.db.prepare_cached(
        "SELECT migration_id,envelope FROM migration_sessions s WHERE state='activated'
         AND EXISTS(SELECT 1 FROM media_refs WHERE owner_kind='migration' AND owner_id=s.migration_id)",
    )?.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if sessions.is_empty() {
        return Ok(());
    }
    c.transaction(|c| {
        profile::media_refs::refresh_all(c)?;
        for (id, envelope) in &sessions {
            release_protection(c, id, &serde_json::from_str(envelope)?)?;
        }
        Ok(())
    })
}
