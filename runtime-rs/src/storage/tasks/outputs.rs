use super::*;

pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let id = string(command, "taskId")?;
    let task = result_task(c, principal, id)?;
    let kind = string(command, "kind")?;
    if kind == "task.result.prepare" {
        return prepare(c, task, &command["media"]);
    }
    let index = output_index(command["index"].as_u64())?;
    let chunk = match kind {
        "task.result.chunk" => Some(media::Chunk::Encoded(command)),
        "task.result.commit" => None,
        _ => return Err(invalid("Unknown task result command")),
    };
    prepared(c, principal, task, index, chunk)
}

pub(super) fn chunk(
    c: &mut Context,
    principal: &str,
    id: &str,
    index: u64,
    source: media::Chunk<'_>,
) -> Result<Value> {
    let task = result_task(c, principal, id)?;
    prepared(c, principal, task, output_index(Some(index))?, Some(source))
}

fn result_task(c: &Context, principal: &str, id: &str) -> Result<TaskRecord> {
    let task = require(c, principal, id)?;
    if task.delivery_state == DeliveryState::Discarded {
        return Err(conflict(
            "TASK_RESULT_DISCARDED",
            "This task result was discarded",
        ));
    }
    Ok(task)
}

fn output_index(index: Option<u64>) -> Result<i64> {
    index
        .filter(|index| *index <= 9_007_199_254_740_991)
        .map(|index| index as i64)
        .ok_or_else(|| invalid("Invalid output index"))
}

fn prepared(
    c: &mut Context,
    principal: &str,
    task: TaskRecord,
    index: i64,
    chunk: Option<media::Chunk<'_>>,
) -> Result<Value> {
    let id = task.task_id.as_str();
    let (body, committed): (String, bool) =
        c.db.prepare_cached(
            "SELECT media_json,committed FROM task_outputs WHERE task_id=? AND output_index=?",
        )?
        .query_row(params![id, index], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| conflict("TASK_RESULT_MISSING", "Result was not prepared"))?;
    let media: Value = serde_json::from_str(&body)?;
    let key = canonical::digest(format!("task:{id}:{index}"));
    if let Some(chunk) = chunk {
        return Ok(
            json!({"offset": if committed { media["bytes"].as_u64().unwrap() } else { media::upload_chunk(c, &key, &media, chunk, false)? }}),
        );
    }
    if committed {
        media::cleanup(c, &key, &media);
        return Ok(serde_json::to_value(task)?);
    }
    media::publish(c, &key, &media)?;
    let result = c.transaction(|c| {
        let mut task = require(c, principal, id)?;
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

pub(super) fn discard(c: &Context, id: &str) -> Result<()> {
    let pending =
        c.db.prepare("SELECT output_index FROM task_outputs WHERE task_id=? AND committed=0")?
            .query_map([id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    for index in pending {
        let key = canonical::digest(format!("task:{id}:{index}"));
        c.db.execute(
            "DELETE FROM leases WHERE id=? AND kind='task-result'",
            [key],
        )?;
    }
    Ok(())
}

fn prepare(c: &mut Context, task: TaskRecord, media: &Value) -> Result<Value> {
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
