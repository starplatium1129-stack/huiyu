use super::*;
use canonical::stringify;
use rusqlite::{OptionalExtension, params};
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
    "aics_chat_volume_v1",
    "aics_companion_live2d_v1",
    "aics_live2d_quality_v1",
    "aics_stage_framing_v1",
    "aics_companion_behavior_v1",
    "aics_companion_affection_v1",
    "aics_speech_input_v1",
    "aics_draw_engine",
    "aics_guest_guide_dismissed",
    "aics_auto_save_to_gallery",
    "aics_backup_last_at",
    "aics-artist-usage",
    "aics-voice-studio-collapsed",
    "aics_managed_route_collapsed_v1",
    "aics_managed_route_dismissed_v1",
    "atelier-desktop-appearance-v1",
];
const DRAFT: &[&str] = &[
    "aics_pb_last_draft",
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
            remove.execute([key])?;
        }
    }
    c.db.execute("DELETE FROM profile_records WHERE domain='chat'", [])?;
    Ok(())
}
fn snapshot(c: &Context, domain: &str, window: Option<&str>) -> Result<Value> {
    let prefix = format!("{}:", window.unwrap_or("undefined"));
    // Filter window-owned drafts before copying their bodies out of SQLite.
    // Match registered global keys, including the hyphenated model namespace.
    // substr preserves literal window IDs, including Unicode and SQL wildcards.
    let sql = format!(
        "SELECT record_key,body,revision FROM profile_records WHERE domain=?1
         AND (?1!='draft' OR record_key GLOB 'aics_chat_draft_v1:*'
         OR record_key GLOB 'aics-model-draft-*' OR record_key IN ({})
         OR substr(record_key,1,length(?2))=?2)
         ORDER BY record_key",
        (3..DRAFT.len() + 3)
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let mut statement = c.db.prepare_cached(&sql)?;
    let parameters = std::iter::once(domain)
        .chain(std::iter::once(prefix.as_str()))
        .chain(DRAFT.iter().copied());
    let rows = statement.query_map(rusqlite::params_from_iter(parameters), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    let mut records = Vec::new();
    for row in rows {
        c.check_cancel()?;
        let (key, body, revision) = row?;
        let key = if self::domain(&key) == Some("draft") {
            key.as_str()
        } else {
            key.strip_prefix(&prefix).unwrap_or(&key)
        };
        records.push(
            json!({"key":key,"value":serde_json::from_str::<Value>(&body)?,"revision":revision}),
        );
    }
    Ok(json!({"records":records,"revision":c.revision()?,"resetRevision":reset(c)?}))
}
pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let kind = string(command, "kind")?;
    match kind {
        "profile.readSettings" => return snapshot(c, "settings", None),
        "profile.readChat" => return snapshot(c, "chat", None),
        "profile.readDrafts" => return snapshot(c, "draft", Some(string(command, "windowId")?)),
        "profile.saveSetting"
        | "profile.saveChatRecord"
        | "profile.saveDraft"
        | "profile.resetChat" => {}
        _ => return Err(invalid("Unknown profile command")),
    }
    c.transaction(|c| {
        let (op,previous)=c.start_operation(principal,command)?;
        if let Some(receipt)=previous {return Ok(receipt["profile"].clone())}
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
            if let Some(retained)=retained {c.db.execute("INSERT INTO profile_records VALUES('chat','aics_chat_v1',?,?)",params![retained,revision])?;}
            c.db.execute("INSERT INTO profile_records VALUES('chat','aics_chat_reset_v1',?,?)",params![stringify(&command["operationId"]),revision])?;
            snapshot(c,"chat",None)?
        } else {
            let selected=match kind {"profile.saveSetting"=>"settings","profile.saveChatRecord"=>"chat",_=>"draft"};
            let key=string(command,"key")?;
            if domain(key)!=Some(selected)||key=="aics_chat_reset_v1"||credential(&command["value"]) {return Err(invalid("Profile field is outside the domain contract or contains a credential"))}
            let record_key=if kind=="profile.saveDraft" {command["windowId"].as_str().filter(|w|!w.is_empty()).map(|w|format!("{w}:{key}")).unwrap_or_else(||key.into())} else {key.into()};
            let existing:Option<i64>=c.db.query_row("SELECT revision FROM profile_records WHERE domain=? AND record_key=?",params![selected,record_key],|r|r.get(0)).optional()?;
            if json!(existing)!=command["expectedRevision"] {return Err(conflict("REVISION_CONFLICT","Profile record has a newer revision"))}
            c.db.execute("INSERT INTO profile_records VALUES(?,?,?,?) ON CONFLICT(domain,record_key) DO UPDATE SET body=excluded.body,revision=excluded.revision",params![selected,record_key,stringify(&command["value"]),revision])?;
            json!({"key":key,"value":command["value"],"revision":revision})
        };
        c.commit_operation(&op,&json!({"operationId":command["operationId"],"kind":kind,"revision":revision,"profile":result}))?;Ok(result)
    })
}
