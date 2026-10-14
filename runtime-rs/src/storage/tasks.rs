mod history;
pub(super) mod inputs;
mod listing;
mod result_reference;
mod scopes;

pub(super) use result_reference::ResultReference;
pub(super) use scopes::initialize;

pub(super) mod outputs;

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
    // Decode borrowed text while the row is alive. Keep JSON failures separate
    // from SQLite errors so malformed task JSON retains its request error.
    let decode = |row: &rusqlite::Row<'_>| -> rusqlite::Result<serde_json::Result<TaskRecord>> {
        Ok(serde_json::from_str(text_column(row, 0)?))
    };
    let row = if let Some(id) = task_id {
        c.db.prepare_cached("SELECT record_json FROM tasks WHERE principal_id=? AND task_id=?")?
            .query_row(params![principal, id], decode)
            .optional()?
    } else {
        c.db.prepare_cached("SELECT record_json FROM tasks WHERE principal_id=? AND request_key=?")?
            .query_row(params![principal, request_key.unwrap_or("")], decode)
            .optional()?
    };
    row.map(|decoded| {
        let mut task = decoded?;
        task.runtime_epoch = c.epoch.clone();
        Ok(task)
    })
    .transpose()
}
fn require(c: &Context, principal: &str, task_id: &str) -> Result<TaskRecord> {
    read(c, principal, Some(task_id), None)?
        .ok_or_else(|| ApiError::new(404, "TASK_NOT_FOUND", "Task does not exist"))
}
// Runtime consumers already use TaskRecord; keep JSON at the external boundary.
pub(super) fn read_record(
    c: &Context,
    principal: &str,
    task_id: &str,
) -> Result<Option<TaskRecord>> {
    c.check_cancel()?;
    if principal.is_empty() {
        return Err(ApiError::new(
            401,
            "UNAUTHORIZED",
            "Desktop principal is required",
        ));
    }
    read(c, principal, Some(task_id), None)
}
fn write(c: &Context, mut task: TaskRecord) -> Result<Value> {
    task.revision = c.next_revision()?;
    task.updated_at = now() as u64;
    task.runtime_epoch = c.epoch.clone();
    let provider = task.provider.clone();
    let settled = task.upstream_settled;
    let id = task.task_id.clone();
    let value = task.into_value()?;
    c.db.prepare_cached(
        "UPDATE tasks SET provider=?,upstream_settled=?,record_json=? WHERE task_id=?",
    )?
    .execute(params![provider, settled, stringify(&value), id])?;
    Ok(value)
}

pub(super) fn read_revision(c: &Context, principal: &str, task_id: &str) -> Result<Option<i64>> {
    c.check_cancel()?;
    if principal.is_empty() {
        return Err(ApiError::new(
            401,
            "UNAUTHORIZED",
            "Desktop principal is required",
        ));
    }
    // CAS admission needs one scalar. The actual patch still requires and
    // validates the complete TaskRecord inside its write transaction.
    let scalar = c.db.prepare_cached("SELECT json_extract(record_json,'$.revision') FROM tasks WHERE principal_id=? AND task_id=?")?
        .query_row(params![principal, task_id], |row| row.get(0)).optional();
    match scalar {
        Ok(value) => Ok(value),
        // A malformed revision/JSON must retain the full reader's Serde error,
        // rather than becoming a SQLite type error and a storage-unavailable reply.
        Err(_) => {
            read(c, principal, Some(task_id), None).map(|task| task.map(|task| task.revision))
        }
    }
}

pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let kind = string(command, "kind")?;
    if kind == "task.result.reference" {
        return result_reference::read(c, principal, command);
    }
    if kind.starts_with("task.result.import.") {
        return result_reference::import(c, principal, command);
    }
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
        } => Ok(
            read(c, principal, task_id.as_deref(), request_key.as_deref())?
                .map(TaskRecord::into_value)
                .transpose()?
                .unwrap_or(Value::Null),
        ),
        TaskCommand::List { query } => listing::read(c, principal, query),
        TaskCommand::Accept { record } => accept(c, principal, *record),
        TaskCommand::Patch {
            task_id,
            expected_revision,
            patch: change,
        } => patch(c, principal, &task_id, expected_revision, *change),
        TaskCommand::Cancel { request_key } => cancel(c, principal, &request_key),
        TaskCommand::ResolveWebui {
            task_id,
            expected_revision,
            upstream_stopped,
        } => resolve_webui(c, principal, &task_id, expected_revision, upstream_stopped),
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
            let mut result = json!({"task": null, "created": false});
            result["task"] = previous.into_value()?;
            return Ok(result);
        }
        let cancellation: Option<i64> = c.db.query_row("SELECT requested_at FROM task_cancel_intents WHERE principal_id=? AND request_key=?",
            params![principal, incoming.request_key], |r| r.get(0)).optional()?;
        // A cancellation recorded before acceptance settles this request
        // without using the provider. Unrelated running work cannot block it.
        if cancellation.is_none() {
            let blocked: Option<String> = c.db.query_row("SELECT task_id FROM tasks WHERE upstream_settled=0 LIMIT 1", [], |r| r.get(0)).optional()?;
            if blocked.is_some() { return Err(conflict("TASK_PROVIDER_BUSY", "Provider has unfinished work; reconcile it before submitting")); }
        }
        let mut task = incoming;
        if let Some(at) = cancellation {
            task.cancel_requested_at = Some(at.try_into().map_err(|_| invalid("Invalid task cancellation time"))?);
            task.status = TaskStatus::Cancelled;
            task.upstream_settled = true;
        }
        c.db.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?)", params![task.task_id, principal, task.request_key, task.provider, task.upstream_settled, serde_json::to_string(&task)?])?;
        for alias in &task.input_media_refs {
            let hash: Option<String> = c.db.query_row("SELECT hash FROM media_aliases WHERE alias=?", [alias], |r| r.get(0)).optional()?;
            let hash = hash.ok_or_else(|| conflict("TASK_INPUT_MISSING", "Frozen task input media is missing"))?;
            c.db.execute("INSERT OR IGNORE INTO media_refs VALUES('task-input',?,?)", params![task.task_id, hash])?;
        }
        let mut result = json!({"task": null, "created": true});
        result["task"] = write(c, task)?;
        Ok(result)
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
        let mut changed = false;
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
            outputs::discard(c, &task.task_id)?;
            task.result_refs.clear();
            task.result_state = ResultState::Unavailable;
            changed = true;
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
        // CAS retries can replay an observation taken before cancellation or
        // completion. A settled task must not block admission again.
        if task.upstream_settled && patch.upstream_settled == Some(false) {
            patch.upstream_settled = None;
        }
        // A collection commit can win the CAS race after an observation found
        // no outputs. Retrying that observation cannot hide durable results.
        // Explicit discard above already clears the references and state.
        if task.result_state == ResultState::Available
            && patch.result_state == Some(ResultState::Unavailable)
        {
            patch.result_state = None;
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
        changed |= replace(&mut task.status, patch.status);
        changed |= replace(&mut task.recovery_state, patch.recovery_state);
        changed |= replace(&mut task.upstream_id, patch.upstream_id);
        changed |= replace(&mut task.provider, patch.provider);
        changed |= replace(&mut task.provider_fingerprint, patch.provider_fingerprint);
        changed |= replace(&mut task.submission_intent_at, patch.submission_intent_at);
        changed |= replace(
            &mut task.submission_observed_at,
            patch.submission_observed_at,
        );
        changed |= replace(&mut task.upstream_settled, patch.upstream_settled);
        changed |= replace(&mut task.result_state, patch.result_state);
        changed |= replace(&mut task.delivery_state, patch.delivery_state);
        changed |= replace(&mut task.error_code, patch.error_code);
        if let Some(value) = patch.metadata {
            for (key, value) in value {
                if task.metadata.get(&key) != Some(&value) {
                    task.metadata.insert(key, value);
                    changed = true;
                }
            }
        }
        changed |= replace(&mut task.checkpoint, patch.checkpoint);
        changed |= replace(&mut task.input, patch.input);
        // Writer, CAS, cancellation and submission checks still apply.
        // Compare only supplied fields after normalization; polling must not clone
        // frozen inputs or checkpoints just to discover that nothing changed.
        if !changed {
            return Ok(task.into_value()?);
        }
        write(c, task)
    })
}
fn replace<T: PartialEq>(current: &mut T, change: Option<T>) -> bool {
    if let Some(value) = change
        && *current != value
    {
        *current = value;
        true
    } else {
        false
    }
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
        let submitted = task.submission_intent_at.is_some_and(|time| time != 0);
        if task.upstream_settled
            || (submitted
                && task.cancel_requested_at.is_some()
                && task.status == TaskStatus::Cancelling)
        {
            return Ok(task.into_value()?);
        }
        task.cancel_requested_at.get_or_insert(now() as u64);
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

fn resolve_webui(
    c: &mut Context,
    principal: &str,
    id: &str,
    expected_revision: i64,
    upstream_stopped: bool,
) -> Result<Value> {
    if !upstream_stopped || expected_revision < 0 {
        return Err(invalid(
            "Explicit WebUI stop confirmation and revision are required",
        ));
    }
    c.transaction(|c| {
        let mut task = require(c, principal, id)?;
        let previous = task.metadata.get("webuiRelease");
        if task.upstream_settled
            && previous.is_some_and(|receipt| {
                receipt["confirmedBy"] == principal
                    && receipt["expectedRevision"] == expected_revision
            })
        {
            return Ok(task.into_value()?);
        }
        if task.revision != expected_revision {
            return Err(conflict(
                "REVISION_CONFLICT",
                "Task revision changed; read it again before confirming",
            ));
        }
        if task.kind != TaskKind::Generation
            || task.provider != "webui"
            || task.recovery_state != crate::task_contract::RecoveryState::Unknown
            || !task.submission_intent_at.is_some_and(|at| at != 0)
            || task.upstream_settled
        {
            return Err(conflict(
                "TASK_RESOLUTION_UNSAFE",
                "Only submitted unknown WebUI tasks can be released",
            ));
        }
        // This is the authenticated user's declaration, not a runtime probe.
        // Preserve the original submission, media and diagnostics; never replay
        // or globally interrupt a WebUI request to resolve this ledger entry.
        task.metadata.insert(
            "webuiRelease".into(),
            json!({
                "confirmedBy":principal, "confirmedAt":now(), "expectedRevision":expected_revision,
                "evidence":"user-confirmation", "previousStatus":task.status,
                "previousErrorCode":task.error_code
            }),
        );
        task.status = TaskStatus::Failed;
        task.recovery_state = crate::task_contract::RecoveryState::Normal;
        task.upstream_settled = true;
        task.error_code = Some("WEBUI_STOP_CONFIRMED".into());
        if task.result_state != ResultState::Available {
            task.result_state = ResultState::Unavailable;
        }
        write(c, task)
    })
}
