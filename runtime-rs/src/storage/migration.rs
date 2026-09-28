mod records;
use super::*;
use canonical::{digest, fingerprint, stringify};
use rusqlite::{OptionalExtension, params};
use std::{collections::HashSet, fs};

struct Session {
    envelope: Value,
    state: String,
    report: Value,
    revision: i64,
}
fn session(c: &Context, id: &str, principal: &str) -> Result<Session> {
    let row=c.db.query_row("SELECT envelope,state,report,revision FROM migration_sessions WHERE migration_id=? AND principal_id=?",params![id,principal],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?))).optional()?.ok_or_else(||ApiError::new(404,"NOT_FOUND","Migration session does not exist"))?;
    Ok(Session {
        envelope: serde_json::from_str(&row.0)?,
        state: row.1,
        report: serde_json::from_str(&row.2)?,
        revision: row.3,
    })
}
fn status(c: &Context, id: &str, principal: &str) -> Result<Value> {
    let session = session(c, id, principal)?;
    let envelope = session.envelope;
    Ok(
        json!({"migrationId":id,"workspaceId":c.workspace_id,"fingerprint":envelope["fingerprint"],"source":envelope["source"],"state":session.state,"revision":session.revision,"totalRecords":envelope["records"].as_array().unwrap().len(),"totalMedia":envelope["media"].as_array().unwrap().len(),"importedRecords":c.db.query_row("SELECT COUNT(*) FROM migration_items WHERE migration_id=?",[id],|r|r.get::<_,i64>(0))?,"importedMedia":c.db.query_row("SELECT COUNT(*) FROM migration_media WHERE migration_id=? AND complete=1",[id],|r|r.get::<_,i64>(0))?,"blockers":session.report,"domains":["artwork","settings","chat","draft"]}),
    )
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
    let mut unsigned = envelope.clone();
    unsigned.as_object_mut().unwrap().remove("fingerprint");
    if fingerprint(&unsigned) != envelope["fingerprint"] {
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
fn key(id: &str, alias: &str) -> String {
    digest(stringify(&json!(["migration", id, alias])))
}
pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let kind = string(command, "kind")?;
    c.check_cancel()?;
    if kind == "migration.begin" {
        return begin(c, principal, &command["envelope"]);
    }
    let id = string(command, "migrationId")?;
    let session = session(c, id, principal)?;
    let envelope = &session.envelope;
    match kind {
        "migration.status" => status(c, id, principal),
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
                c.db.execute(
                    "UPDATE migration_sessions SET state='activated' WHERE migration_id=?",
                    [id],
                )?;
                Ok(())
            })?;
            status(c, id, principal)
        }
        "migration.record" => import_record(c, id, &session, command),
        "migration.recordChunk" => {
            let item = string(command, "itemId")?;
            let expected = envelope["records"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == item)
                .ok_or_else(|| format_error("Record chunk is outside an importing manifest"))?;
            if expected["bytes"].as_u64().is_none_or(|v| v == 0) || session.state != "importing" {
                return Err(format_error(
                    "Record chunk is outside an importing manifest",
                ));
            }
            let key = key(id, &format!("record:{item}"));
            let media = json!({"alias":item,"bytes":expected["bytes"],"sha256":expected["sha256"],"mime":"application/json"});
            let offset = media::upload(c, &key, &media, command, false)?;
            if json!(offset) == expected["bytes"] {
                let record: Value =
                    serde_json::from_slice(&fs::read(media::staging_path(&c.root, &key, item)?)?)?;
                import_record(c, id, &session, &json!({"itemId":item,"record":record}))?;
            }
            Ok(json!({"itemId":item,"offset":offset}))
        }
        "migration.media" => {
            if session.state != "importing" {
                return Err(conflict(
                    "MIGRATION_CONFLICT",
                    "Verified migration is immutable",
                ));
            }
            let alias = string(command, "alias")?;
            let media = envelope["media"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["alias"] == alias)
                .ok_or_else(|| format_error("Media is not in the manifest"))?;
            Ok(json!({"alias":alias,"offset":media::upload(c,&key(id,alias),media,command,false)?}))
        }
        "migration.verify" => verify(c, principal, id, &session),
        _ => Err(invalid("Unknown migration command")),
    }
}
fn begin(c: &mut Context, principal: &str, envelope: &Value) -> Result<Value> {
    validate(envelope)?;
    let id = string(envelope, "migrationId")?;
    c.transaction(|c| {
        let previous=c.db.query_row("SELECT fingerprint,principal_id FROM migration_sessions WHERE migration_id=?",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
        if let Some((fingerprint,owner))=previous {if owner!=principal||json!(fingerprint)!=envelope["fingerprint"] {return Err(conflict("MIGRATION_CONFLICT","Source snapshot changed; create a new migration session"))}return Ok(())}
        if c.db.prepare("SELECT 1 FROM artworks UNION ALL SELECT 1 FROM projects UNION ALL SELECT 1 FROM migration_sessions LIMIT 1")?.exists([])? {return Err(conflict("MIGRATION_CONFLICT","Import requires an independent empty candidate workspace"))}
        c.db.execute("INSERT INTO migration_sessions VALUES(?,?,?,?,'importing','[]',0)",params![id,principal,string(envelope,"fingerprint")?,stringify(envelope)])?;
        for media in envelope["media"].as_array().unwrap() {
            let alias=string(media,"alias")?;let hash=string(media,"sha256")?;
            c.db.execute("INSERT INTO migration_media VALUES(?,?,?,?,?,0)",params![id,alias,hash,media["bytes"].as_i64(),string(media,"mime")?])?;
            c.db.execute("INSERT INTO leases VALUES(?,'migration',?,NULL,?)",params![key(id,alias),hash,now()])?;
        }Ok(())
    })?;
    status(c, id, principal)
}
fn import_record(c: &mut Context, id: &str, session: &Session, command: &Value) -> Result<Value> {
    let item = string(command, "itemId")?;
    let record = &command["record"];
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
    let mut expected_fields = expected.clone();
    for field in ["id", "sha256", "bytes"] {
        expected_fields.as_object_mut().unwrap().remove(field);
    }
    let mut actual = record.clone();
    actual
        .as_object_mut()
        .ok_or_else(|| format_error("Invalid source record"))?
        .remove("value");
    if fingerprint(&expected_fields) != fingerprint(&actual) {
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
fn verify(c: &mut Context, principal: &str, id: &str, session: &Session) -> Result<Value> {
    if session.state != "importing" {
        return status(c, id, principal);
    }
    let envelope = &session.envelope;
    let mut blockers = Vec::new();
    if status(c, id, principal)?["importedRecords"]
        .as_u64()
        .unwrap()
        != envelope["records"].as_array().unwrap().len() as u64
    {
        blockers.push("incomplete-records".into());
    }
    for media in envelope["media"].as_array().unwrap() {
        c.check_cancel()?;
        let alias = string(media, "alias")?;
        let result = media::publish(c, &key(id, alias), media).and_then(|_| {
            media::verify(
                c,
                &media::object_path(&c.root, string(media, "sha256")?)?,
                string(media, "sha256")?,
                media["bytes"].as_u64().unwrap(),
                string(media, "mime")?,
            )
        });
        match result {
            Ok(()) => c.transaction(|c| {
                c.db.execute(
                    "UPDATE migration_media SET complete=1 WHERE migration_id=? AND alias=?",
                    params![id, alias],
                )?;
                Ok(())
            })?,
            Err(error) if error.code == "CANCELLED" => return Err(error),
            Err(_) => blockers.push(format!("media:{alias}")),
        }
    }
    blockers.extend(records::validate(c, envelope)?);
    c.transaction(|c| {
        c.db.execute(
            "UPDATE migration_sessions SET report=? WHERE migration_id=?",
            params![stringify(&json!(blockers)), id],
        )?;
        if !blockers.is_empty() {
            return Ok(());
        }
        let revision = c.next_revision()?;
        for media in envelope["media"].as_array().unwrap() {
            let hash = string(media, "sha256")?;
            c.db.execute(
                "INSERT OR IGNORE INTO media_objects VALUES(?,?,?)",
                params![hash, media["bytes"].as_i64(), string(media, "mime")?],
            )?;
            c.db.execute(
                "INSERT INTO media_aliases VALUES(?,?)",
                params![string(media, "alias")?, hash],
            )?;
            c.db.execute(
                "INSERT OR IGNORE INTO media_refs VALUES('migration',?,?)",
                params![id, hash],
            )?;
        }
        records::publish(c, envelope, revision)?;
        c.db.execute(
            "UPDATE migration_sessions SET state='verified',revision=? WHERE migration_id=?",
            params![revision, id],
        )?;
        Ok(())
    })?;
    status(c, id, principal)
}
