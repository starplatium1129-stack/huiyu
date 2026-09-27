use super::*;

pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let id = string(command, "taskId")?;
    require(c, principal, id)?;
    let name = string(command, "name")?;
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
    let kind = string(command, "kind")?;
    if kind == "task.input.get" {
        return Ok(if committed {
            stored.unwrap_or(Value::Null)
        } else {
            Value::Null
        });
    }
    if kind == "task.input.prepare" {
        let media = &command["media"];
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
    if kind == "task.input.chunk" {
        return Ok(
            json!({"offset": if committed { stored["bytes"].as_u64().unwrap() } else { media::upload(c, &key, &stored, command, false)? }}),
        );
    }
    if kind != "task.input.commit" {
        return Err(invalid("Unknown task input command"));
    }
    if committed {
        media::cleanup(c, &key, &stored);
        return Ok(stored);
    }
    media::publish(c, &key, &stored)?;
    c.transaction(|c| {
        let hash = string(&stored, "sha256")?;
        c.db.execute(
            "INSERT OR IGNORE INTO media_objects VALUES(?,?,?)",
            params![hash, stored["bytes"].as_i64(), string(&stored, "mime")?],
        )?;
        c.db.execute(
            "INSERT OR IGNORE INTO media_aliases VALUES(?,?)",
            params![string(&stored, "alias")?, hash],
        )?;
        c.db.execute(
            "INSERT OR IGNORE INTO media_refs VALUES('task-input',?,?)",
            params![id, hash],
        )?;
        c.db.execute(
            "UPDATE task_inputs SET committed=1 WHERE task_id=? AND name=?",
            params![id, name],
        )?;
        c.db.execute("DELETE FROM leases WHERE id=?", [&key])?;
        let mut task = require(c, principal, id)?;
        let refs = task["inputMediaRefs"]
            .as_array_mut()
            .ok_or_else(|| invalid("Invalid task input references"))?;
        if !refs.contains(&stored["alias"]) {
            refs.push(stored["alias"].clone());
        }
        write(c, task)?;
        Ok(())
    })?;
    media::cleanup(c, &key, &stored);
    Ok(stored)
}
