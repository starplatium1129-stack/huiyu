use super::*;

pub(super) fn accept(
    c: &mut Context,
    principal: &str,
    incoming: TaskRecord,
    retry_of: Option<&str>,
) -> Result<Value> {
    if incoming.request_key.is_empty()
        || incoming.request_key.len() > 200
        || incoming.principal_id != principal
        || incoming.workspace_id != c.workspace_id
        || incoming.task_id.is_empty()
    {
        return Err(ApiError::new(
            400,
            "TASK_INVALID",
            "Invalid task identity or media references",
        ));
    }
    c.transaction(|c| {
        if let Some(previous) = read(c, principal, None, Some(&incoming.request_key))? {
            if previous.request_fingerprint != incoming.request_fingerprint {
                return Err(conflict("TASK_KEY_CONFLICT", "Request key was already used with different input"));
            }
            let mut result = json!({"task": null, "created": false});
            result["task"] = previous.into_value()?;
            return Ok(result);
        }
        let source = retry_of.map(|id| retry::source(c, principal, id, &incoming)).transpose()?;
        let cancellation: Option<i64> = c.db.query_row("SELECT requested_at FROM task_cancel_intents WHERE principal_id=? AND request_key=?",
            params![principal, incoming.request_key], |r| r.get(0)).optional()?;
        // A cancellation recorded before acceptance settles this request
        // without using the provider. Unrelated running work cannot block it.
        if cancellation.is_none() {
            let blocked: Option<String> = c.db.query_row("SELECT task_id FROM tasks WHERE upstream_settled=0 LIMIT 1", [], |r| r.get(0)).optional()?;
            if blocked.is_some() { return Err(conflict("TASK_PROVIDER_BUSY", "Provider has unfinished work; reconcile it before submitting").not_accepted()); }
        }
        let mut task = incoming;
        if let Some(at) = cancellation {
            task.cancel_requested_at = Some(at.try_into().map_err(|_| invalid("Invalid task cancellation time"))?);
            task.status = TaskStatus::Cancelled;
            task.upstream_settled = true;
        }
        // Ordinary acceptance publishes once; retries attach protected media
        // and lineage below, within this same transaction.
        task.revision = c.next_revision()?;
        task.updated_at = now() as u64;
        task.runtime_epoch = c.epoch.clone();
        let (id, request_key, provider, settled) = (
            task.task_id.clone(), task.request_key.clone(), task.provider.clone(), task.upstream_settled,
        );
        c.db.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?)", params![id, principal, request_key, provider, settled, payload::hot(&mut task)?])?;
        payload::persist(c,&task)?;
        let mut value = task.into_value()?;
        // INSERT still precedes alias lookup so identity conflicts keep their
        // original priority; missing inputs roll back this entire transaction.
        for alias in value["inputMediaRefs"].as_array().unwrap() {
            let alias = alias.as_str().unwrap();
            let hash: Option<String> = c.db.query_row("SELECT hash FROM media_aliases WHERE alias=?", [alias], |r| r.get(0)).optional()?;
            let hash = hash.ok_or_else(|| conflict("TASK_INPUT_MISSING", "Frozen task input media is missing"))?;
            c.db.execute("INSERT OR IGNORE INTO media_refs VALUES('task-input',?,?)", params![id, hash])?;
        }
        if let Some(source) = source {
            // Publish the child, protected aliases and both lineage links in
            // this acceptance transaction. A restart cannot see a half-copy.
            value = retry::attach(c, principal, source, serde_json::from_value(value)?)?;
        }
        let mut result = json!({"task": null, "created": true});
        result["task"] = value;
        Ok(result)
    })
}
