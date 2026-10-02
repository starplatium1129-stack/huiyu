use super::*;

pub(in crate::storage) enum Prepared {
    Complete(Value),
    Verify(Output),
}

// Immutable authorization snapshot. A TaskRecord is deliberately not retained:
// cancellation, delivery and metadata can change while the file is being read.
pub(in crate::storage) struct Output {
    pub key: String,
    pub media: Value,
    principal: String,
    task_id: String,
    index: i64,
    body: String,
    request_key: String,
    fingerprint: String,
    lease_created: i64,
}

fn row(c: &Context, id: &str, index: i64) -> Result<(String, bool)> {
    c.db.prepare_cached(
        "SELECT media_json,committed FROM task_outputs WHERE task_id=? AND output_index=?",
    )?
    .query_row(params![id, index], |r| Ok((r.get(0)?, r.get(1)?)))
    .optional()?
    .ok_or_else(|| conflict("TASK_RESULT_MISSING", "Result was not prepared"))
}

fn lease(c: &Context, key: &str, media: &Value) -> Result<i64> {
    let stored: Option<(String, Option<String>, Option<String>, i64)> =
        c.db.query_row(
            "SELECT kind,hash,operation_key,created_at FROM leases WHERE id=?",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((kind, hash, operation, created)) = stored else {
        return Err(conflict(
            "TASK_RESULT_LEASE",
            "Result preparation lease is missing",
        ));
    };
    if kind != "task-result" || hash.as_deref() != media["sha256"].as_str() || operation.is_some() {
        return Err(conflict(
            "TASK_RESULT_LEASE",
            "Result preparation lease changed",
        ));
    }
    Ok(created)
}

pub(in crate::storage) fn prepare(
    c: &Context,
    principal: &str,
    command: &Value,
) -> Result<Prepared> {
    c.check_cancel()?;
    if principal.is_empty() {
        return Err(ApiError::new(
            401,
            "UNAUTHORIZED",
            "Desktop principal is required",
        ));
    }
    c.writer()?;
    c.owner.check()?;
    let id = string(command, "taskId")?;
    let task = result_task(c, principal, id)?;
    let index = output_index(command["index"].as_u64())?;
    let (body, committed) = row(c, id, index)?;
    let media: Value = serde_json::from_str(&body)?;
    media::validate(&media)?;
    if media["index"] != index
        || media["alias"] != format!("task-{id}-{index}")
        || task.workspace_id != c.workspace_id
        || task.task_id != id
        || task.principal_id != principal
    {
        return Err(conflict(
            "TASK_RESULT_CONFLICT",
            "Task output identity changed",
        ));
    }
    let key = canonical::digest(format!("task:{id}:{index}"));
    if committed {
        media::cleanup(c, &key, &media);
        return Ok(Prepared::Complete(serde_json::to_value(task)?));
    }
    let lease_created = lease(c, &key, &media)?;
    Ok(Prepared::Verify(Output {
        key,
        media,
        principal: principal.into(),
        task_id: id.into(),
        index,
        body,
        request_key: task.request_key,
        fingerprint: task.request_fingerprint,
        lease_created,
    }))
}

impl Output {
    pub fn check(&self, c: &Context) -> Result<TaskRecord> {
        let task = result_task(c, &self.principal, &self.task_id)?;
        if task.workspace_id != c.workspace_id
            || task.principal_id != self.principal
            || task.task_id != self.task_id
            || task.request_key != self.request_key
            || task.request_fingerprint != self.fingerprint
            || row(c, &self.task_id, self.index)? != (self.body.clone(), false)
        {
            return Err(conflict(
                "TASK_RESULT_CONFLICT",
                "Task output identity changed during verification",
            ));
        }
        if lease(c, &self.key, &self.media)? != self.lease_created {
            return Err(conflict(
                "TASK_RESULT_LEASE",
                "Result preparation lease changed",
            ));
        }
        Ok(task)
    }

    pub fn commit(
        &self,
        c: &mut Context,
        check_file: impl Fn(&Context) -> Result<()>,
    ) -> Result<Value> {
        let result = c.transaction(|c| {
            check_file(c)?;
            let mut task = self.check(c)?;
            let hash = string(&self.media, "sha256")?;
            // Other media mutations can run while verification is off-actor.
            // INSERT OR IGNORE must not retain a foreign alias or metadata.
            let alias_hash: Option<String> =
                c.db.query_row(
                    "SELECT hash FROM media_aliases WHERE alias=?",
                    [string(&self.media, "alias")?],
                    |r| r.get(0),
                )
                .optional()?;
            let object: Option<(i64, String)> =
                c.db.query_row(
                    "SELECT bytes,mime FROM media_objects WHERE hash=?",
                    [hash],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if alias_hash.as_deref().is_some_and(|stored| stored != hash)
                || object.is_some_and(|(bytes, mime)| {
                    Some(bytes) != self.media["bytes"].as_i64()
                        || Some(mime.as_str()) != self.media["mime"].as_str()
                })
            {
                return Err(conflict(
                    "MEDIA_CONFLICT",
                    "Result media identity is already in use",
                ));
            }
            c.db.execute(
                "INSERT OR IGNORE INTO media_objects VALUES(?,?,?)",
                params![
                    hash,
                    self.media["bytes"].as_i64(),
                    string(&self.media, "mime")?
                ],
            )?;
            c.db.execute(
                "INSERT OR IGNORE INTO media_aliases VALUES(?,?)",
                params![string(&self.media, "alias")?, hash],
            )?;
            c.db.execute(
                "INSERT OR IGNORE INTO media_refs VALUES('task-result',?,?)",
                params![self.task_id, hash],
            )?;
            c.db.execute(
                "UPDATE task_outputs SET committed=1 WHERE task_id=? AND output_index=?",
                params![self.task_id, self.index],
            )?;
            c.db.execute("DELETE FROM leases WHERE id=?", [&self.key])?;
            if !task
                .result_refs
                .iter()
                .any(|item| item.index == self.index as u64)
            {
                task.result_refs
                    .push(serde_json::from_value(self.media.clone())?);
            }
            task.result_state = ResultState::Available;
            let result = write(c, task)?;
            check_file(c)?;
            Ok(result)
        })?;
        media::cleanup(c, &self.key, &self.media);
        Ok(result)
    }
}
