use super::*;
use canonical::stringify;
use rusqlite::{OptionalExtension, params};
pub(super) mod media_refs;
const CHAT_ARCHIVE: &str = "aics_chat_archive_v1";
const CHAT: &[&str] = &[
    "aics_chat_v1",
    "aics_chat_archive_v1",
    "aics_chat_memories_v1",
    "aics_user_profile_v1",
    "aics_retired_companion_chat_v1",
    "aics_chat_reset_v1",
];
const SETTINGS: &[&str] = &[
    "aics_desktop_start_page",
    "aics_desktop_last_page",
    "aics_theme",
    "aics_interface_sound_v1",
    "aics_sd_last_success_v1",
    "aics_pb_director_mode",
    "aics_scene_favorites",
    "aics_recent_scenes",
    "aics_hidden_scenes",
    "aics_scene_usage_v1",
    "aics_show_mature",
    "aics_tunnel_off",
    "aics_chat_model",
    "aics_chat_api_drafts",
    "aics_chat_thinking_v1",
    "aics_chat_search_v1",
    "aics_chat_volume_v1",
    "aics_companion_live2d_v1",
    "aics_live2d_quality_v1",
    "aics_stage_framing_v1",
    "aics_companion_behavior_v1",
    "aics_companion_affection_v1",
    "aics_speech_input_v1",
    "aics_draw_engine",
    "aics_director_layout_v1",
    "aics_guest_guide_dismissed",
    "aics_auto_save_to_gallery",
    "aics_gallery_filter_presets_v1",
    "aics_backup_last_at",
    "aics-artist-usage",
    "aics-voice-studio-collapsed",
    "aics_managed_route_collapsed_v1",
    "aics_managed_route_dismissed_v1",
    "atelier-desktop-appearance-v1",
];
const DRAFT: &[&str] = &[
    "aics_pb_last_draft",
    "aics_pb_batch_plan_v1",
    "aics_video_ctx",
    "aics_video_shots_ctx",
    "aics_video_scenario_ctx",
    "aics_video_draft_v1",
    "aics_video_shots_draft_v1",
    "aics_pb_temp_result_v1",
    "aics_sd_pending_queue_v1",
];
pub(super) fn domain(key: &str) -> Option<&'static str> {
    if CHAT.contains(&key) {
        Some("chat")
    } else if SETTINGS.contains(&key) {
        Some("settings")
    } else if DRAFT.contains(&key)
        || key.starts_with("aics_chat_draft_v1:")
        || key.starts_with("aics-model-draft-")
    {
        Some("draft")
    } else {
        None
    }
}
pub(super) fn credential(value: &Value) -> bool {
    if let Value::String(s) = value {
        return serde_json::from_str(s).ok().is_some_and(|v| credential(&v));
    }
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let key = key.to_ascii_lowercase().replace(['-', '_'], "");
            (matches!(
                key.as_str(),
                "apikey"
                    | "authorization"
                    | "password"
                    | "secret"
                    | "accesstoken"
                    | "refreshtoken"
                    | "token"
            ) && !value.is_null()
                && value != "")
                || ((value.is_object() || value.is_array()) && credential(value))
        }),
        Value::Array(array) => array
            .iter()
            .filter(|v| v.is_object() || v.is_array())
            .any(credential),
        _ => false,
    }
}
fn reset(c: &Context) -> Result<String> {
    let value:Option<String>=c.db.query_row("SELECT body FROM profile_records WHERE domain='chat' AND record_key='aics_chat_reset_v1'",[],|r|r.get(0)).optional()?;
    value
        .map(|v| serde_json::from_str::<String>(&v).map_err(Into::into))
        .transpose()
        .map(|v| v.unwrap_or_default())
}
fn archive_version(c: &Context, revision: Option<i64>, reset: &str) -> Result<String> {
    Ok(canonical::digest(serde_json::to_vec(&(
        &c.workspace_id, &c.epoch, "chat", CHAT_ARCHIVE, reset, revision,
    ))?))
}
fn archive_snapshot(c: &Context, known: Option<&str>) -> Result<Value> {
    c.check_cancel()?;
    let reset_revision = reset(c)?;
    let revision: Option<i64> = c.db.query_row(
        "SELECT revision FROM profile_records WHERE domain='chat' AND record_key=?",
        [CHAT_ARCHIVE], |row| row.get(0),
    ).optional()?;
    let version = archive_version(c, revision, &reset_revision)?;
    let mut snapshot = json!({"records":[],"revision":c.revision()?,"resetRevision":reset_revision,"version":version});
    if known == Some(version.as_str()) {
        snapshot["unchanged"] = json!(true);
        return Ok(snapshot);
    }
    // The actor does not yield between metadata and body. A match never copies
    // or parses the archive; a miss reads only this row, not the whole chat domain.
    if let Some(revision) = revision {
        c.check_cancel()?;
        let mut statement = c.db.prepare_cached("SELECT body FROM profile_records WHERE domain='chat' AND record_key=?")?;
        let mut rows = statement.query([CHAT_ARCHIVE])?;
        let row = rows.next()?.ok_or_else(|| invalid("Chat archive disappeared during read"))?;
        let mut record = json!({"key":CHAT_ARCHIVE,"value":null,"revision":revision,"version":version});
        record["value"] = serde_json::from_str(text_column(row, 0)?)?;
        snapshot["records"] = Value::Array(vec![record]);
    }
    Ok(snapshot)
}
fn draft_record_key(key: &str) -> Option<&str> {
    if domain(key) == Some("draft") {
        return Some(key);
    }
    key.match_indices(':').find_map(|(index, _)| {
        let suffix = &key[index + 1..];
        (domain(suffix) == Some("draft")).then_some(suffix)
    })
}
fn clear_chat(c: &Context) -> Result<()> {
    // Inspect keys only. A model draft can contain a chat-like suffix; classify
    // its registered base key before deciding whether this reset owns it.
    let keys =
        c.db.prepare_cached("SELECT record_key FROM profile_records WHERE domain='draft'")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut remove =
        c.db.prepare_cached("DELETE FROM profile_records WHERE domain='draft' AND record_key=?")?;
    for key in keys {
        c.check_cancel()?;
        if draft_record_key(&key).is_some_and(|key| key.starts_with("aics_chat_draft_v1:")) {
            media_refs::remove(c, "draft", &key)?;
            remove.execute([key])?;
        }
    }
    media_refs::clear_domain(c, "chat")?;
    c.db.execute("DELETE FROM profile_records WHERE domain='chat'", [])?;
    Ok(())
}
fn snapshot(c: &Context, domain: &str, window: Option<&str>, known: Option<&str>, known_archive: Option<&str>) -> Result<Value> {
    c.check_cancel()?;
    let prefix = format!("{}:", window.unwrap_or("undefined"));
    // Filter window-owned drafts before copying their bodies out of SQLite.
    // Match registered global keys, including the hyphenated model namespace.
    // substr preserves literal window IDs, including Unicode and SQL wildcards.
    let scope = format!(
        "FROM profile_records WHERE domain=?1
         AND (?1!='draft' OR record_key GLOB 'aics_chat_draft_v1:*'
         OR record_key GLOB 'aics-model-draft-*' OR record_key IN ({})
         OR substr(record_key,1,length(?2))=?2)",
        (3..DRAFT.len() + 3)
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let parameters = std::iter::once(domain)
        .chain(std::iter::once(prefix.as_str()))
        .chain(DRAFT.iter().copied());
    let reset_revision = reset(c)?;
    let mut archive_revision = None;
    // This actor does not yield between metadata and bodies. Raw keys preserve
    // window/global draft precedence; the key set also detects deletions.
    // Task/artwork writes must not invalidate unchanged profile snapshots.
    let version = {
        let mut statement = c.db.prepare_cached(&format!("SELECT record_key,revision {scope} ORDER BY record_key"))?;
        let mut rows = statement.query(rusqlite::params_from_iter(parameters.clone()))?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next()? {
            c.check_cancel()?;
            let key = row.get::<_, String>(0)?;
            let revision = row.get::<_, i64>(1)?;
            if domain == "chat" && key == CHAT_ARCHIVE { archive_revision = Some(revision); }
            entries.push((key, revision));
        }
        canonical::digest(serde_json::to_vec(&(
            &c.workspace_id, &c.epoch, domain, window, &reset_revision, entries,
        ))?)
    };
    if known == Some(version.as_str()) {
        return Ok(json!({"records":[],"revision":c.revision()?,"resetRevision":reset_revision,"version":version,"unchanged":true}));
    }
    let unchanged_archive = match (domain, known_archive, archive_revision) {
        ("chat", Some(known), Some(revision)) => {
            let version = archive_version(c, Some(revision), &reset_revision)?;
            (known == version.as_str()).then_some(version)
        }
        _ => None,
    };
    // The domain token above still covers every row. Omit only the archive body
    // whose exact record token the caller already holds, within this same read.
    let skip_archive = if unchanged_archive.is_some() { CHAT_ARCHIVE } else { "" };
    let parameter = DRAFT.len() + 3;
    let mut statement = c.db.prepare_cached(&format!("SELECT record_key,body,revision {scope} AND (?{parameter}='' OR record_key!=?{parameter}) ORDER BY record_key"))?;
    let mut rows = statement.query(rusqlite::params_from_iter(parameters.chain(std::iter::once(skip_archive))))?;
    let mut records = Vec::new();
    while let Some(row) = rows.next().transpose() {
        c.check_cancel()?;
        let row = row?;
        let key = row.get::<_, String>(0)?;
        let body = text_column(row, 1)?;
        let revision = row.get::<_, i64>(2)?;
        let key = if self::domain(&key) == Some("draft") {
            key.as_str()
        } else {
            key.strip_prefix(&prefix).unwrap_or(&key)
        };
        let mut record = json!({"key":key,"value":null,"revision":revision});
        record["value"] = serde_json::from_str(body)?;
        if domain == "chat" && key == CHAT_ARCHIVE {
            record["version"] = json!(archive_version(c, Some(revision), &reset_revision)?);
        }
        records.push(record);
    }
    let mut snapshot = json!({"records":null,"revision":c.revision()?,"resetRevision":reset_revision,"version":version});
    snapshot["records"] = Value::Array(records);
    if let Some(version) = unchanged_archive { snapshot["unchangedArchive"] = json!(version); }
    Ok(snapshot)
}
pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let kind = string(command, "kind")?;
    if kind == "profile.readChatArchive" {
        let known = command.get("ifVersion").map(|_| string(command, "ifVersion")).transpose()?;
        return archive_snapshot(c, known);
    }
    let read_domain = match kind {
        "profile.readSettings" => Some("settings"),
        "profile.readChat" => Some("chat"),
        "profile.readDrafts" => Some("draft"),
        _ => None,
    };
    if let Some(domain) = read_domain {
        let window = if domain == "draft" { Some(string(command, "windowId")?) } else { None };
        let known = command.get("ifVersion").map(|_| string(command, "ifVersion")).transpose()?;
        let archive = if domain == "chat" { command.get("ifArchiveVersion").map(|_| string(command, "ifArchiveVersion")).transpose()? } else { None };
        return snapshot(c, domain, window, known, archive);
    }
    match kind {
        "profile.saveSetting"
        | "profile.saveChatRecord"
        | "profile.saveDraft"
        | "profile.resetChat" => {}
        _ => return Err(invalid("Unknown profile command")),
    }
    let ack_only = command
        .get("ackOnly")
        .map(|value| value.as_bool().ok_or_else(|| invalid("Invalid profile acknowledgement mode")))
        .transpose()?
        .unwrap_or(false);
    c.transaction(|c| {
        let (op,previous)=c.start_operation(principal,command)?;
        if let Some(mut receipt)=previous {return Ok(receipt.get_mut("profile").map(Value::take).unwrap_or(Value::Null))}
        let current_reset=reset(c)?;
        if command.get("expectedReset").is_some_and(|expected|expected!=&json!(current_reset)) {
            return Err(conflict("PROFILE_RESET_CONFLICT","Chat was reset in another window; reload before writing"));
        }
        let revision=c.next_revision()?;
        let result=if kind=="profile.resetChat" {
            let current:Option<String>=c.db.query_row("SELECT body FROM profile_records WHERE domain='chat' AND record_key='aics_chat_v1'",[],|r|r.get(0)).optional()?;
            let retained=if let Some(current)=current {
                let decoded:Value=serde_json::from_str(&current)?;
                let mut record=if let Value::String(s)=decoded {serde_json::from_str::<Value>(&s)?} else {decoded};
                if !record.is_object() {return Err(invalid("Invalid chat profile"))}
                record["histories"]=json!({});record["historiesRevision"]=json!(revision);record["historiesRevisions"]=json!({});
                if !record["settings"].is_object() {record["settings"]=json!({});}record["settings"]["drafts"]=json!({});
                Some(stringify(&json!(stringify(&record))))
            } else {None};
            clear_chat(c)?;
            if let Some(retained)=retained {
                c.db.execute("INSERT INTO profile_records VALUES('chat','aics_chat_v1',?,?)",params![retained,revision])?;
                media_refs::replace(c,"chat","aics_chat_v1",&serde_json::from_str(&retained)?)?;
            }
            c.db.execute("INSERT INTO profile_records VALUES('chat','aics_chat_reset_v1',?,?)",params![stringify(&command["operationId"]),revision])?;
            snapshot(c,"chat",None,None,None)?
        } else {
            let selected=match kind {"profile.saveSetting"=>"settings","profile.saveChatRecord"=>"chat",_=>"draft"};
            let key=string(command,"key")?;
            let invalid_field=|| invalid("Profile field is outside the domain contract or contains a credential");
            if domain(key)!=Some(selected)||key=="aics_chat_reset_v1" {return Err(invalid_field())}
            // Chat/draft values often hold a full JSON document as a String.
            // Decode it once for both scans; persist and fingerprint the original.
            let value=&command["value"];
            let parsed=value.as_str().and_then(|text|serde_json::from_str::<Value>(text).ok());
            let decoded=parsed.as_ref().unwrap_or(value);
            if credential(decoded) {return Err(invalid_field())}
            let record_key=if kind=="profile.saveDraft" {command["windowId"].as_str().filter(|w|!w.is_empty()).map(|w|format!("{w}:{key}")).unwrap_or_else(||key.into())} else {key.into()};
            let existing:Option<i64>=c.db.query_row("SELECT revision FROM profile_records WHERE domain=? AND record_key=?",params![selected,record_key],|r|r.get(0)).optional()?;
            if json!(existing)!=command["expectedRevision"] {return Err(conflict("REVISION_CONFLICT","Profile record has a newer revision"))}
            media_refs::replace_decoded(c,selected,&record_key,decoded)?;
            // Both writes share this transaction. Release the decoded tree
            // before encoding the original value and constructing its receipt.
            drop(parsed);
            c.db.execute("INSERT INTO profile_records VALUES(?,?,?,?) ON CONFLICT(domain,record_key) DO UPDATE SET body=excluded.body,revision=excluded.revision",params![selected,record_key,stringify(&command["value"]),revision])?;
            // Callers already retain the exact submitted value. Opt-in writes
            // persist/replay only the acknowledgement, not another full archive.
            if ack_only {
                let mut result=json!({"key":key,"revision":revision});
                // Persist the token with the acknowledgement. Replay must keep
                // this historical revision/reset/epoch, never consult newer data.
                if key==CHAT_ARCHIVE {result["version"]=json!(archive_version(c,Some(revision),&current_reset)?);}
                result
            }
            else {json!({"key":key,"value":command["value"],"revision":revision})}
        };
        // Move the potentially large history into its receipt, then return the
        // same allocation after persistence rather than cloning it for each side.
        let mut receipt=json!({"operationId":command["operationId"],"kind":kind,"revision":revision,"profile":null});
        receipt["profile"]=result;
        c.commit_operation(&op,&receipt)?;
        Ok(receipt["profile"].take())
    })
}
