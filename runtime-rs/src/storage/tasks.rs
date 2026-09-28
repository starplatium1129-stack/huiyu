mod history;
mod inputs;
mod outputs;
#[cfg(test)]
mod tests;

use super::*;
use canonical::stringify;
use rusqlite::{OptionalExtension, params};

fn terminal(task: &Value) -> bool {
    matches!(
        task["status"].as_str(),
        Some("succeeded" | "failed" | "cancelled")
    )
}

fn read(
    c: &Context,
    principal: &str,
    task_id: Option<&str>,
    request_key: Option<&str>,
) -> Result<Value> {
    let row: Option<String> = if let Some(id) = task_id {
        c.db.prepare_cached("SELECT record_json FROM tasks WHERE principal_id=? AND task_id=?")?
            .query_row(params![principal, id], |r| r.get(0))
            .optional()?
    } else {
        c.db.prepare_cached("SELECT record_json FROM tasks WHERE principal_id=? AND request_key=?")?
            .query_row(params![principal, request_key.unwrap_or("")], |r| r.get(0))
            .optional()?
    };
    row.map(|body| {
        let mut task: Value = serde_json::from_str(&body)?;
        task["runtimeEpoch"] = json!(c.epoch);
        Ok(task)
    })
    .transpose()
    .map(|task| task.unwrap_or(Value::Null))
}

fn require(c: &Context, principal: &str, task_id: &str) -> Result<Value> {
    let task = read(c, principal, Some(task_id), None)?;
    if task.is_null() {
        Err(ApiError::new(404, "TASK_NOT_FOUND", "Task does not exist"))
    } else {
        Ok(task)
    }
}

fn write(c: &Context, mut task: Value) -> Result<Value> {
    task["revision"] = json!(c.next_revision()?);
    task["updatedAt"] = json!(now());
    task["runtimeEpoch"] = json!(c.epoch);
    c.db.prepare_cached(
        "UPDATE tasks SET provider=?,upstream_settled=?,record_json=? WHERE task_id=?",
    )?
    .execute(params![
        string(&task, "provider")?,
        task["upstreamSettled"].as_bool().unwrap_or(false),
        stringify(&task),
        string(&task, "taskId")?
    ])?;
    Ok(task)
}

pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let kind = string(command, "kind")?;
    if kind.starts_with("task.input.") {
        return inputs::execute(c, principal, command);
    }
    if kind.starts_with("task.result.") {
        return outputs::execute(c, principal, command);
    }
    match kind {
        "task.legacy-history" => history::read(c, principal),
        "task.get" => read(
            c,
            principal,
            command["taskId"].as_str(),
            command["requestKey"].as_str(),
        ),
        "task.list" => {
            let mut query = c.db.prepare_cached(
                "SELECT record_json FROM tasks WHERE principal_id=? ORDER BY rowid DESC",
            )?;
            let rows = query.query_map([principal], |r| r.get::<_, String>(0))?;
            let mut items = Vec::new();
            for row in rows {
                let mut task: Value = serde_json::from_str(&row?)?;
                task["runtimeEpoch"] = json!(c.epoch);
                items.push(task);
            }
            Ok(json!({"runtimeEpoch": c.epoch, "items": items}))
        }
        "task.accept" => accept(c, principal, &command["record"]),
        "task.patch" => patch(c, principal, command),
        "task.cancel" => cancel(c, principal, string(command, "requestKey")?),
        _ => Err(ApiError::new(400, "TASK_INVALID", "Unknown task command")),
    }
}

fn accept(c: &mut Context, principal: &str, incoming: &Value) -> Result<Value> {
    let request_key = string(incoming, "requestKey")?;
    if request_key.is_empty()
        || request_key.len() > 200
        || incoming["principalId"] != principal
        || incoming["workspaceId"] != c.workspace_id
        || string(incoming, "taskId")?.is_empty()
        || !incoming["upstreamSettled"].is_boolean()
        || !incoming["inputMediaRefs"].is_array()
        || !incoming["resultRefs"].is_array()
    {
        return Err(ApiError::new(
            400,
            "TASK_INVALID",
            "Invalid task identity or media references",
        ));
    }
    string(incoming, "requestFingerprint")?;
    string(incoming, "provider")?;
    c.transaction(|c| {
        let previous = read(c, principal, None, Some(request_key))?;
        if !previous.is_null() {
            if previous["requestFingerprint"] != incoming["requestFingerprint"] {
                return Err(conflict("TASK_KEY_CONFLICT", "Request key was already used with different input"));
            }
            return Ok(json!({"task": previous, "created": false}));
        }
        let blocked: Option<String> = c.db.query_row("SELECT task_id FROM tasks WHERE upstream_settled=0 LIMIT 1", [], |r| r.get(0)).optional()?;
        if blocked.is_some() { return Err(conflict("TASK_PROVIDER_BUSY", "Provider has unfinished work; reconcile it before submitting")); }
        let cancellation: Option<i64> = c.db.query_row("SELECT requested_at FROM task_cancel_intents WHERE principal_id=? AND request_key=?",
            params![principal, request_key], |r| r.get(0)).optional()?;
        let mut task = incoming.clone();
        if let Some(at) = cancellation {
            task["cancelRequestedAt"] = json!(at);
            task["status"] = json!("cancelled");
            task["upstreamSettled"] = json!(true);
        }
        let id = string(&task, "taskId")?;
        c.db.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?)", params![id, principal, request_key, string(&task, "provider")?, task["upstreamSettled"].as_bool().unwrap(), stringify(&task)])?;
        for alias in task["inputMediaRefs"].as_array().unwrap() {
            let alias = alias.as_str().ok_or_else(|| invalid("Invalid frozen task media alias"))?;
            let hash: Option<String> = c.db.query_row("SELECT hash FROM media_aliases WHERE alias=?", [alias], |r| r.get(0)).optional()?;
            let hash = hash.ok_or_else(|| conflict("TASK_INPUT_MISSING", "Frozen task input media is missing"))?;
            c.db.execute("INSERT OR IGNORE INTO media_refs VALUES('task-input',?,?)", params![id, hash])?;
        }
        Ok(json!({"task": write(c, task)?, "created": true}))
    })
}

fn delivery_order(value: &Value) -> Option<usize> {
    ["unseen", "seen", "saved", "discarded"]
        .iter()
        .position(|v| value.as_str() == Some(v))
}

fn patch(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    const FIELDS: &[&str] = &[
        "status",
        "recoveryState",
        "upstreamId",
        "provider",
        "providerFingerprint",
        "submissionIntentAt",
        "submissionObservedAt",
        "upstreamSettled",
        "resultState",
        "deliveryState",
        "errorCode",
        "metadata",
        "checkpoint",
        "input",
    ];
    let patch = command["patch"]
        .as_object()
        .ok_or_else(|| invalid("Task patch must be an object"))?;
    if patch.keys().any(|key| !FIELDS.contains(&key.as_str())) {
        return Err(invalid("Task patch contains immutable fields"));
    }
    c.transaction(|c| {
        let mut task = require(c, principal, string(command, "taskId")?)?;
        if task["revision"] != command["expectedRevision"] {
            return Err(conflict("REVISION_CONFLICT", "Task revision changed"));
        }
        // The cancellation check and durable submission intent must be one
        // transaction; a stale caller-side check cannot authorize a new POST.
        if patch
            .get("submissionIntentAt")
            .is_some_and(Value::is_number)
            && (task["cancelRequestedAt"].is_number() || task["upstreamSettled"] == true)
        {
            return Err(ApiError::new(
                499,
                "CANCELLED",
                "Task was cancelled or already settled before submission",
            ));
        }
        if patch
            .get("submissionIntentAt")
            .is_some_and(Value::is_number)
            && task["submissionIntentAt"].is_number()
            && task["kind"] != "batch"
        {
            return Err(conflict(
                "TASK_SUBMISSION_REPLAY",
                "An existing submission intent cannot be repeated",
            ));
        }
        let mut patch = patch.clone();
        if let Some(delivery) = patch.get("deliveryState") {
            let order =
                delivery_order(delivery).ok_or_else(|| invalid("Invalid task delivery state"))?;
            if order < delivery_order(&task["deliveryState"]).unwrap_or(0) {
                patch.remove("deliveryState");
            }
        }
        if patch.get("deliveryState").and_then(Value::as_str) == Some("discarded")
            && task["deliveryState"] != "discarded"
        {
            if task["upstreamSettled"] != true || task["resultState"] != "available" {
                return Err(conflict(
                    "TASK_DISCARD_UNSAFE",
                    "Only settled available results can be discarded",
                ));
            }
            c.db.execute(
                "DELETE FROM media_refs WHERE owner_kind='task-result' AND owner_id=?",
                [string(&task, "taskId")?],
            )?;
            task["resultRefs"] = json!([]);
            task["resultState"] = json!("unavailable");
        }
        if task["deliveryState"] == "discarded" {
            patch.remove("deliveryState");
        }
        if terminal(&task)
            && task["upstreamSettled"] == true
            && patch
                .get("status")
                .is_some_and(|status| *status != task["status"])
        {
            patch.remove("status");
        }
        if task["cancelRequestedAt"]
            .as_i64()
            .is_some_and(|time| time != 0)
            && !terminal(&task)
            && patch
                .get("status")
                .is_some_and(|status| status != "cancelled" && status != "cancelling")
        {
            patch.insert("status".into(), json!("cancelling"));
        }
        if task["upstreamId"].as_str().is_some_and(|id| !id.is_empty())
            && patch
                .get("upstreamId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty() && task["upstreamId"] != id)
        {
            return Err(conflict(
                "TASK_UPSTREAM_CONFLICT",
                "Upstream identity cannot be replaced",
            ));
        }
        if let Some(incoming) = patch.get_mut("metadata") {
            let mut metadata = task["metadata"].as_object().cloned().unwrap_or_default();
            metadata.extend(
                incoming
                    .as_object()
                    .ok_or_else(|| invalid("Task metadata must be an object"))?
                    .clone(),
            );
            *incoming = Value::Object(metadata);
        }
        task.as_object_mut()
            .ok_or_else(|| invalid("Invalid stored task"))?
            .extend(patch);
        write(c, task)
    })
}

fn cancel(c: &mut Context, principal: &str, request_key: &str) -> Result<Value> {
    if request_key.is_empty() || request_key.len() > 200 {
        return Err(invalid("Invalid task request key"));
    }
    c.transaction(|c| {
        c.db.execute(
            "INSERT OR IGNORE INTO task_cancel_intents VALUES(?,?,?)",
            params![principal, request_key, now()],
        )?;
        let mut task = read(c, principal, None, Some(request_key))?;
        if task.is_null() || task["upstreamSettled"] == true {
            return Ok(task);
        }
        if task["cancelRequestedAt"].is_null() {
            task["cancelRequestedAt"] = json!(now());
        }
        let submitted = task["submissionIntentAt"]
            .as_i64()
            .is_some_and(|time| time != 0);
        task["status"] = json!(if submitted { "cancelling" } else { "cancelled" });
        if !submitted {
            task["upstreamSettled"] = json!(true);
        }
        write(c, task)
    })
}
