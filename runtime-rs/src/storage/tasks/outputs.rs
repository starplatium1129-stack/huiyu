use super::*;

pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let id = string(command, "taskId")?;
    let task = require(c, principal, id)?;
    let kind = string(command, "kind")?;
    if kind == "task.result.prepare" {
        return prepare(c, task, &command["media"]);
    }
    let index = command["index"]
        .as_i64()
        .filter(|index| (0..=9_007_199_254_740_991).contains(index))
        .ok_or_else(|| invalid("Invalid output index"))?;
    let (body, committed): (String, bool) =
        c.db.prepare_cached(
            "SELECT media_json,committed FROM task_outputs WHERE task_id=? AND output_index=?",
        )?
        .query_row(params![id, index], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| conflict("TASK_RESULT_MISSING", "Result was not prepared"))?;
    let media: Value = serde_json::from_str(&body)?;
    let key = canonical::digest(format!("task:{id}:{index}"));
    if kind == "task.result.chunk" {
        return Ok(
            json!({"offset": if committed { media["bytes"].as_u64().unwrap() } else { media::upload(c, &key, &media, command, false)? }}),
        );
    }
    if kind != "task.result.commit" {
        return Err(invalid("Unknown task result command"));
    }
    if committed {
        media::cleanup(c, &key, &media);
        return Ok(serde_json::to_value(task)?);
    }
    media::publish(c, &key, &media)?;
    let result = c.transaction(|c| {
        let mut task = require(c, principal, id)?;
        if task.delivery_state == DeliveryState::Discarded {
            return Ok(serde_json::to_value(task)?);
        }
        let hash = string(&media, "sha256")?;
        c.db.execute(
            "INSERT OR IGNORE INTO media_objects VALUES(?,?,?)",
            params![hash, media["bytes"].as_i64(), string(&media, "mime")?],
        )?;
        c.db.execute(
            "INSERT OR IGNORE INTO media_aliases VALUES(?,?)",
            params![string(&media, "alias")?, hash],
        )?;
        c.db.execute(
            "INSERT OR IGNORE INTO media_refs VALUES('task-result',?,?)",
            params![id, hash],
        )?;
        c.db.execute(
            "UPDATE task_outputs SET committed=1 WHERE task_id=? AND output_index=?",
            params![id, index],
        )?;
        c.db.execute("DELETE FROM leases WHERE id=?", [&key])?;
        if !task
            .result_refs
            .iter()
            .any(|item| item.index == index as u64)
        {
            task.result_refs
                .push(serde_json::from_value(media.clone())?);
        }
        task.result_state = ResultState::Available;
        write(c, task)
    })?;
    media::cleanup(c, &key, &media);
    Ok(result)
}

fn prepare(c: &mut Context, task: TaskRecord, media: &Value) -> Result<Value> {
    if task.delivery_state == DeliveryState::Discarded {
        return Err(conflict(
            "TASK_RESULT_DISCARDED",
            "This task result was discarded",
        ));
    }
    let id = task.task_id.clone();
    let index = media["index"]
        .as_i64()
        .filter(|index| (0..=9_007_199_254_740_991).contains(index))
        .ok_or_else(|| invalid("Invalid task output index"))?;
    media::validate(media)?;
    if media["alias"] != format!("task-{id}-{index}") {
        return Err(conflict("MEDIA_INVALID", "Invalid task result identity"));
    }
    let existing: Option<(String, bool)> =
        c.db.query_row(
            "SELECT media_json,committed FROM task_outputs WHERE task_id=? AND output_index=?",
            params![id, index],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let encoded = stringify(media);
    if existing.as_ref().is_some_and(|(body, _)| body != &encoded) {
        return Err(conflict(
            "TASK_RESULT_CONFLICT",
            "Task output identity changed",
        ));
    }
    if existing.as_ref().is_some_and(|(_, committed)| *committed) {
        return Ok(json!({"offset": media["bytes"]}));
    }
    let key = canonical::digest(format!("task:{id}:{index}"));
    c.transaction(|c| {
        c.db.execute(
            "INSERT OR IGNORE INTO task_outputs VALUES(?,?,?,0)",
            params![id, index, encoded],
        )?;
        c.db.execute(
            "INSERT OR IGNORE INTO leases(id,kind,hash,created_at) VALUES(?,'task-result',?,?)",
            params![key, string(media, "sha256")?, now()],
        )?;
        let mut task = task;
        task.result_state = ResultState::Collecting;
        write(c, task)?;
        Ok(json!({"offset": media::uploaded(c, &key, media)?}))
    })
}
