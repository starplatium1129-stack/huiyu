use super::*;
const FORMAT: &str = "huiyu-chat-records-v1";
const DELTA: &str = "huiyu-chat-delta-v1";

fn parsed(value: Value) -> Result<(Value, bool)> {
    if let Some(text) = value.as_str() { Ok((serde_json::from_str(text)?, true)) }
    else { Ok((value, false)) }
}
fn lists(value: &mut Value, mut visit: impl FnMut(&mut Value, Vec<String>) -> Result<()>) -> Result<()> {
    if let Some(histories) = value["histories"].as_object_mut() {
        for (character, messages) in histories { visit(messages, vec!["history".into(), character.clone()])?; }
    }
    if let Some(conversations) = value["conversations"].as_object_mut() {
        for (character, conversation) in conversations {
            if let Some(branches) = conversation["branches"].as_array_mut() {
                for branch in branches {
                    let id = branch["id"].as_str().ok_or_else(|| invalid("Invalid chat branch"))?.to_owned();
                    visit(&mut branch["messages"], vec!["branch".into(), character.clone(), id])?;
                }
            }
        }
    }
    Ok(())
}
fn encode(c: &Context, value: Value) -> Result<Value> {
    let (mut header, string_encoded) = parsed(value)?;
    lists(&mut header, |list, path| {
        let Some(items) = list.as_array() else { return Ok(()) };
        let mut ids = Vec::new();
        for item in items {
            let mut key = path.clone();
            key.push(item["mid"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| invalid("Message identity missing"))?.into());
            let id = stringify(&json!(key));
            c.db.execute("INSERT INTO chat_message_records VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
                params![id, stringify(item)])?;
            ids.push(id);
        }
        *list = json!({"$messages":ids});
        Ok(())
    })?;
    Ok(json!({"storageFormat":FORMAT,"stringEncoded":string_encoded,"header":header}))
}
pub(in crate::storage) fn decode(db: &Connection, value: Value) -> Result<Value> {
    if value["storageFormat"] != FORMAT { return Ok(value); }
    let mut header = value["header"].clone();
    let mut lookup = db.prepare_cached("SELECT body FROM chat_message_records WHERE id=?")?;
    lists(&mut header, |list, _| {
        let ids = list["$messages"].as_array().ok_or_else(|| invalid("Invalid message index"))?;
        let mut messages = Vec::with_capacity(ids.len());
        for id in ids {
            let body: String = lookup.query_row([id.as_str().ok_or_else(|| invalid("Invalid message reference"))?], |r| r.get(0))?;
            messages.push(serde_json::from_str::<Value>(&body)?);
        }
        *list = Value::Array(messages);
        Ok(())
    })?;
    Ok(if value["stringEncoded"] == true { Value::String(stringify(&header)) } else { header })
}

/** Runs inside profile's revision-checked transaction, including initial migration. */
pub(super) fn prepare(c: &Context, value: &Value) -> Result<Value> {
    if value["storageFormat"] != DELTA {
        if value.is_null() { c.db.execute("DELETE FROM chat_message_records", [])?; return Ok(Value::Null); }
        c.db.execute("DELETE FROM chat_message_records", [])?;
        return encode(c, value.clone());
    }
    let old: Option<String> = c.db.query_row("SELECT body FROM profile_records WHERE domain='chat' AND record_key='aics_chat_v1'", [], |r| r.get(0)).optional()?;
    if let Some(old) = old {
        let old: Value = serde_json::from_str(&old)?;
        if old["storageFormat"] != FORMAT { encode(c, old)?; }
    }
    let upsert = value["upsert"].as_array().ok_or_else(|| invalid("Invalid chat changes"))?;
    let remove = value["remove"].as_array().ok_or_else(|| invalid("Invalid chat removals"))?;
    if upsert.len() > 10000 || remove.len() > 10000 || !value["header"].is_object() || !value["stringEncoded"].is_boolean() {
        return Err(invalid("Invalid chat delta"));
    }
    for record in upsert {
        let id = record["id"].as_str().filter(|id| id.len() <= 1000).ok_or_else(|| invalid("Invalid message ID"))?;
        if !record["body"].is_object() || credential(&record["body"]) { return Err(invalid("Invalid message body")); }
        c.db.execute("INSERT INTO chat_message_records VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", params![id,stringify(&record["body"])])?;
    }
    for id in remove { c.db.execute("DELETE FROM chat_message_records WHERE id=?", [id.as_str().ok_or_else(|| invalid("Invalid message ID"))?])?; }
    // The profile writer resolves this index once for credentials and media
    // references before committing; any missing body rolls back this transaction.
    Ok(json!({"storageFormat":FORMAT,"stringEncoded":value["stringEncoded"],"header":value["header"]}))
}
