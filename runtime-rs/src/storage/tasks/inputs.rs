use super::*;

enum InputCommand<'a> {
    Get,
    Prepare(&'a Value),
    Chunk(media::Chunk<'a>),
}

pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let id = string(command, "taskId")?;
    let name = string(command, "name")?;
    let command = match string(command, "kind")? {
        "task.input.get" => InputCommand::Get,
        "task.input.prepare" => InputCommand::Prepare(&command["media"]),
        "task.input.chunk" => InputCommand::Chunk(media::Chunk::Encoded(command)),
        _ => return Err(invalid("Unknown task input command")),
    };
    apply(c, principal, id, name, command)
}

pub(super) fn chunk(
    c: &mut Context,
    principal: &str,
    id: &str,
    name: &str,
    source: media::Chunk<'_>,
) -> Result<Value> {
    apply(c, principal, id, name, InputCommand::Chunk(source))
}

fn apply(
    c: &mut Context,
    principal: &str,
    id: &str,
    name: &str,
    command: InputCommand<'_>,
) -> Result<Value> {
    require(c, principal, id)?;
    if name.is_empty()
        || name.len() > 220
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Err(conflict(
            "TASK_INPUT_INVALID",
            "Invalid protected input name",
        ));
    }
    let key = canonical::digest(format!("input:{id}:{name}"));
    let existing: Option<(String, bool)> = c
        .db
        .prepare_cached("SELECT media_json,committed FROM task_inputs WHERE task_id=? AND name=?")?
        .query_row(params![id, name], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let stored: Option<Value> = existing
        .as_ref()
        .map(|(body, _)| serde_json::from_str(body))
        .transpose()?;
    let committed = existing.as_ref().is_some_and(|(_, committed)| *committed);
    if matches!(command, InputCommand::Get) {
        return Ok(if committed {
            stored.unwrap_or(Value::Null)
        } else {
            Value::Null
        });
    }
    if let InputCommand::Prepare(media) = command {
        media::validate(media)?;
        if media["alias"] != format!("task-input-{key}") {
            return Err(conflict(
                "TASK_INPUT_INVALID",
                "Invalid protected input media",
            ));
        }
        if stored
            .as_ref()
            .is_some_and(|stored| stringify(stored) != stringify(media))
        {
            return Err(conflict("TASK_INPUT_CHANGED", "Frozen task input changed"));
        }
        if committed {
            return Ok(json!({"offset": media["bytes"]}));
        }
        return c.transaction(|c| {
            c.db.execute(
                "INSERT OR IGNORE INTO task_inputs VALUES(?,?,?,0)",
                params![id, name, stringify(media)],
            )?;
            c.db.execute(
                "INSERT OR IGNORE INTO leases(id,kind,hash,created_at) VALUES(?,'task-input',?,?)",
                params![key, string(media, "sha256")?, now()],
            )?;
            Ok(json!({"offset": media::uploaded(c, &key, media)?}))
        });
    }
    let stored =
        stored.ok_or_else(|| conflict("TASK_INPUT_MISSING", "Protected task input is missing"))?;
    if let InputCommand::Chunk(chunk) = command {
        return Ok(
            json!({"offset": if committed { stored["bytes"].as_u64().unwrap() } else { media::upload_chunk(c, &key, &stored, chunk, false)? }}),
        );
    }
    Err(invalid("Unknown task input command"))
}
