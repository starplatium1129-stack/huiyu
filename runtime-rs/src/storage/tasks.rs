mod history;
mod inputs;
mod listing;
mod outputs;
#[cfg(test)]
mod tests;

use super::*;
use crate::task_contract::{
    DeliveryState, ResultState, TaskCommand, TaskKind, TaskPatch, TaskRecord, TaskStatus,
};
use canonical::stringify;
use rusqlite::{OptionalExtension, params};

fn read(
    c: &Context,
    principal: &str,
    task_id: Option<&str>,
    request_key: Option<&str>,
) -> Result<Option<TaskRecord>> {
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
        let mut task: TaskRecord = serde_json::from_str(&body)?;
        task.runtime_epoch = c.epoch.clone();
        Ok(task)
    })
    .transpose()
}
fn require(c: &Context, principal: &str, task_id: &str) -> Result<TaskRecord> {
    read(c, principal, Some(task_id), None)?
        .ok_or_else(|| ApiError::new(404, "TASK_NOT_FOUND", "Task does not exist"))
}
fn write(c: &Context, mut task: TaskRecord) -> Result<Value> {
    task.revision = c.next_revision()?;
    task.updated_at = now() as u64;
    task.runtime_epoch = c.epoch.clone();
    let value = serde_json::to_value(&task)?;
    c.db.prepare_cached(
        "UPDATE tasks SET provider=?,upstream_settled=?,record_json=? WHERE task_id=?",
    )?
    .execute(params![
        task.provider,
        task.upstream_settled,
        stringify(&value),
        task.task_id
    ])?;
    Ok(value)
}

pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let kind = string(command, "kind")?;
    if kind.starts_with("task.input.") {
        return inputs::execute(c, principal, command);
    }
    if kind.starts_with("task.result.") {
        return outputs::execute(c, principal, command);
    }
    if kind == "task.legacy-history" {
        return history::read(c, principal);
    }
    let command = serde_json::from_value(command.clone())
        .map_err(|_| invalid("Invalid task command fields"))?;
    execute_command(c, principal, command)
}
pub(super) fn execute_command(
    c: &mut Context,
    principal: &str,
    command: TaskCommand,
) -> Result<Value> {
    c.check_cancel()?;
    if principal.is_empty() {
        return Err(ApiError::new(
            401,
            "UNAUTHORIZED",
            "Desktop principal is required",
        ));
    }
    if !command.is_read() {
        c.writer()?;
    }
    match command {
        TaskCommand::Get {
            task_id,
            request_key,
        } => Ok(serde_json::to_value(read(
            c,
            principal,
            task_id.as_deref(),
            request_key.as_deref(),
        )?)?),
        TaskCommand::List { query } => listing::read(c, principal, query),
        TaskCommand::Accept { record } => accept(c, principal, *record),
        TaskCommand::Patch {
            task_id,
            expected_revision,
            patch: change,
        } => patch(c, principal, &task_id, expected_revision, *change),
        TaskCommand::Cancel { request_key } => cancel(c, principal, &request_key),
    }
}
fn accept(c: &mut Context, principal: &str, incoming: TaskRecord) -> Result<Value> {
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
            return Ok(json!({"task": previous, "created": false}));
        }
        let blocked: Option<String> = c.db.query_row("SELECT task_id FROM tasks WHERE upstream_settled=0 LIMIT 1", [], |r| r.get(0)).optional()?;
        if blocked.is_some() { return Err(conflict("TASK_PROVIDER_BUSY", "Provider has unfinished work; reconcile it before submitting")); }
        let cancellation: Option<i64> = c.db.query_row("SELECT requested_at FROM task_cancel_intents WHERE principal_id=? AND request_key=?",
            params![principal, incoming.request_key], |r| r.get(0)).optional()?;
        let mut task = incoming;
        if let Some(at) = cancellation {
            task.cancel_requested_at = Some(at.try_into().map_err(|_| invalid("Invalid task cancellation time"))?);
            task.status = TaskStatus::Cancelled;
            task.upstream_settled = true;
        }
        c.db.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?)", params![task.task_id, principal, task.request_key, task.provider, task.upstream_settled, stringify(&serde_json::to_value(&task)?)])?;
        for alias in &task.input_media_refs {
            let hash: Option<String> = c.db.query_row("SELECT hash FROM media_aliases WHERE alias=?", [alias], |r| r.get(0)).optional()?;
            let hash = hash.ok_or_else(|| conflict("TASK_INPUT_MISSING", "Frozen task input media is missing"))?;
            c.db.execute("INSERT OR IGNORE INTO media_refs VALUES('task-input',?,?)", params![task.task_id, hash])?;
        }
        Ok(json!({"task": write(c, task)?, "created": true}))
    })
}
fn patch(
    c: &mut Context,
    principal: &str,
    id: &str,
    expected_revision: i64,
    mut patch: TaskPatch,
) -> Result<Value> {
    c.transaction(|c| {
        let mut task = require(c, principal, id)?;
        let previous = task.clone();
        if task.revision != expected_revision {
            return Err(conflict("REVISION_CONFLICT", "Task revision changed"));
        }
        // Check cancellation and persist submission intent in the same transaction.
        if patch.submission_intent_at.flatten().is_some() {
            if task.cancel_requested_at.is_some() || task.upstream_settled {
                return Err(ApiError::new(
                    499,
                    "CANCELLED",
                    "Task was cancelled or already settled before submission",
                ));
            }
            if task.submission_intent_at.is_some() && task.kind != TaskKind::Batch {
                return Err(conflict(
                    "TASK_SUBMISSION_REPLAY",
                    "An existing submission intent cannot be repeated",
                ));
            }
        }
        if patch
            .delivery_state
            .is_some_and(|delivery| delivery < task.delivery_state)
        {
            patch.delivery_state = None;
        }
        if patch.delivery_state == Some(DeliveryState::Discarded)
            && task.delivery_state != DeliveryState::Discarded
        {
            if !task.upstream_settled || task.result_state != ResultState::Available {
                return Err(conflict(
                    "TASK_DISCARD_UNSAFE",
                    "Only settled available results can be discarded",
                ));
            }
            c.db.execute(
                "DELETE FROM media_refs WHERE owner_kind='task-result' AND owner_id=?",
                [&task.task_id],
            )?;
            task.result_refs.clear();
            task.result_state = ResultState::Unavailable;
        }
        if task.delivery_state == DeliveryState::Discarded {
            patch.delivery_state = None;
        }
        if task.status.terminal()
            && task.upstream_settled
            && patch.status.is_some_and(|status| status != task.status)
        {
            patch.status = None;
        }
        if task.cancel_requested_at.is_some_and(|time| time != 0)
            && !task.status.terminal()
            && patch.status.is_some_and(|status| {
                !matches!(status, TaskStatus::Cancelled | TaskStatus::Cancelling)
            })
        {
            patch.status = Some(TaskStatus::Cancelling);
        }
        if let (Some(current), Some(Some(next))) = (&task.upstream_id, &patch.upstream_id)
            && !current.is_empty()
            && !next.is_empty()
            && current != next
        {
            return Err(conflict(
                "TASK_UPSTREAM_CONFLICT",
                "Upstream identity cannot be replaced",
            ));
        }
        if let Some(value) = patch.status {
            task.status = value;
        }
        if let Some(value) = patch.recovery_state {
            task.recovery_state = value;
        }
        if let Some(value) = patch.upstream_id {
            task.upstream_id = value;
        }
        if let Some(value) = patch.provider {
            task.provider = value;
        }
        if let Some(value) = patch.provider_fingerprint {
            task.provider_fingerprint = value;
        }
        if let Some(value) = patch.submission_intent_at {
            task.submission_intent_at = value;
        }
        if let Some(value) = patch.submission_observed_at {
            task.submission_observed_at = value;
        }
        if let Some(value) = patch.upstream_settled {
            task.upstream_settled = value;
        }
        if let Some(value) = patch.result_state {
            task.result_state = value;
        }
        if let Some(value) = patch.delivery_state {
            task.delivery_state = value;
        }
        if let Some(value) = patch.error_code {
            task.error_code = value;
        }
        if let Some(value) = patch.metadata {
            task.metadata.extend(value);
        }
        if let Some(value) = patch.checkpoint {
            task.checkpoint = value;
        }
        if let Some(value) = patch.input {
            task.input = value;
        }
        // Writer, CAS, cancellation and submission checks still apply.
        // Compare after normalization so ignored regressions are also read-only.
        if task == previous {
            return Ok(serde_json::to_value(task)?);
        }
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
        let Some(mut task) = read(c, principal, None, Some(request_key))? else {
            return Ok(Value::Null);
        };
        if task.upstream_settled {
            return Ok(serde_json::to_value(task)?);
        }
        task.cancel_requested_at.get_or_insert(now() as u64);
        let submitted = task.submission_intent_at.is_some_and(|time| time != 0);
        task.status = if submitted {
            TaskStatus::Cancelling
        } else {
            TaskStatus::Cancelled
        };
        if !submitted {
            task.upstream_settled = true;
        }
        write(c, task)
    })
}
