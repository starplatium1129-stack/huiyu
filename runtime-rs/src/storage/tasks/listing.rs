use super::*;
use crate::task_contract::{TaskListQuery, TaskListScope, TaskSummary};
use std::sync::OnceLock;

// Project in SQLite: large recipes and checkpoints never cross the worker boundary.
const SUMMARY_BODY: &str = "json_set(json_remove(record_json,'$.input','$.inputMediaRefs','$.metadata','$.checkpoint','$.requestFingerprint','$.requestFingerprintLocale','$.providerFingerprint'),
         '$.retryOfTaskId', json_extract(record_json,'$.metadata.retryOfTaskId'),
         '$.retryTaskId', json_extract(record_json,'$.metadata.retryTaskId'),
         '$.sourceBatchId', CASE WHEN json_type(record_json,'$.metadata.context.retriedTaskId')='text' AND ((json_type(record_json,'$.metadata.context.stepIndex')='integer' AND json_extract(record_json,'$.metadata.context.stepIndex')>=0) OR (json_type(record_json,'$.metadata.context.stepIndices')='array' AND json_array_length(record_json,'$.metadata.context.stepIndices')>0 AND NOT EXISTS (SELECT 1 FROM json_each(record_json,'$.metadata.context.stepIndices') WHERE type!='integer' OR value<0))) THEN json_extract(record_json,'$.metadata.context.retriedTaskId') ELSE NULL END,
         '$.canConcat', json(CASE WHEN json_extract(record_json,'$.kind')='batch' AND json_extract(record_json,'$.status')='succeeded' AND json_array_length(record_json,'$.resultRefs')>1 AND (SELECT checkpoint_shots FROM task_payloads p WHERE p.task_id=tasks.task_id) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(record_json,'$.resultRefs') WHERE json_extract(value,'$.index')=(SELECT checkpoint_shots FROM task_payloads p WHERE p.task_id=tasks.task_id)) THEN 'true' ELSE 'false' END))";

pub(super) fn read_summary(c: &Context, principal: &str, id: &str) -> Result<Value> {
    static SQL: OnceLock<String> = OnceLock::new();
    let sql = SQL.get_or_init(|| {
        format!("SELECT {SUMMARY_BODY} FROM tasks WHERE principal_id=? AND task_id=?")
    });
    let mut statement = c.db.prepare_cached(sql)?;
    let decoded = statement
        .query_row(params![principal, id], |row| {
            Ok(serde_json::from_str::<TaskSummary>(text_column(row, 0)?))
        })
        .optional()?;
    let Some(task) = decoded else {
        return Ok(Value::Null);
    };
    let mut task = task?;
    task.runtime_epoch.clear();
    let mut task = task.into_value()?;
    task["runtimeEpoch"] = json!(c.epoch);
    Ok(task)
}

// Revisions are unique and monotonic across durable writes. A fixed upper bound
// prevents new writes moving the page boundary; updates above it are returned
// by the next incremental refresh, including updates to not-yet-read records.
pub(super) fn read(c: &Context, principal: &str, query: TaskListQuery) -> Result<Value> {
    let summary = query.summary;
    let (items, next, through) = page(c, principal, query, |body| {
        // Validate the stored epoch, then serialize an empty placeholder before
        // installing the current epoch once at the response boundary.
        let mut task = if summary {
            let mut task = serde_json::from_str::<TaskSummary>(body)?;
            task.runtime_epoch.clear();
            task.into_value()?
        } else {
            let mut task = serde_json::from_str::<TaskRecord>(body)?;
            task.runtime_epoch.clear();
            task.into_value()?
        };
        task["runtimeEpoch"] = json!(c.epoch);
        Ok(task)
    })?;
    let mut result = json!({"runtimeEpoch": c.epoch, "items": null, "nextCursor": next, "throughRevision": through});
    result["items"] = Value::Array(items);
    Ok(result)
}

pub(crate) struct RecoveryPage {
    pub ids: Vec<String>,
    pub next_cursor: Option<i64>,
    pub through_revision: i64,
}
pub(in crate::storage) fn recovery(
    c: &Context,
    principal: &str,
    query: TaskListQuery,
) -> Result<RecoveryPage> {
    c.check_cancel()?;
    if principal.is_empty() {
        return Err(ApiError::new(
            401,
            "UNAUTHORIZED",
            "Desktop principal is required",
        ));
    }
    if !query.recoverable {
        return Err(invalid("Recovery requires complete task records"));
    }
    // Decode every complete record before publishing the page. Only IDs survive
    // each row, so recipes/checkpoints never accumulate in the recovery queue.
    let (ids, next_cursor, through_revision) = page(c, principal, query, |body| {
        Ok(serde_json::from_str::<TaskRecord>(body)?.task_id)
    })?;
    Ok(RecoveryPage {
        ids,
        next_cursor,
        through_revision,
    })
}

fn page<T>(
    c: &Context,
    principal: &str,
    query: TaskListQuery,
    decode: impl Fn(&str) -> Result<T>,
) -> Result<(Vec<T>, Option<i64>, i64)> {
    let limit = query.limit.unwrap_or(100);
    let after = query.after_revision.unwrap_or(0);
    let through = match query.through_revision {
        Some(value) => value,
        None if query.recoverable => {
            c.db.query_row("SELECT COALESCE(MAX(rowid),0) FROM tasks", [], |row| {
                row.get(0)
            })?
        }
        None => c.revision()?,
    };
    let before = query.before.unwrap_or(i64::MAX);
    if !(1..=200).contains(&limit) || after < 0 || through < after || before <= 0 {
        return Err(invalid("Invalid task page bounds"));
    }
    if query.recoverable && (query.summary || query.scope != TaskListScope::All) {
        return Err(invalid("Recovery requires complete task records"));
    }
    let recovery = if query.recoverable {
        " AND json_extract(record_json,'$.deliveryState') != 'discarded' AND (upstream_settled=0 OR (json_extract(record_json,'$.status')='succeeded' AND json_extract(record_json,'$.resultState')!='available'))"
    } else {
        ""
    };
    let body = if query.summary {
        SUMMARY_BODY
    } else {
        payload::BODY
    };
    // Startup recovery runs once: use immutable rowids, so concurrent task
    // updates cannot move a still-unvisited recovery candidate out of its page.
    let cursor = if query.recoverable {
        "rowid"
    } else {
        "json_extract(record_json,'$.revision')"
    };
    // Five scopes each have full/summary forms; validated recovery has one form.
    // Only SQL templates are shared. Principal, bounds and limit stay bound below.
    static SQL: [OnceLock<String>; 11] = [const { OnceLock::new() }; 11];
    let scope = match query.scope {
        TaskListScope::All => 0,
        TaskListScope::Overview => 1,
        TaskListScope::Open => 2,
        TaskListScope::Attention => 3,
        TaskListScope::Inbox => 4,
    };
    let shape = if query.recoverable {
        10
    } else {
        scope * 2 + usize::from(query.summary)
    };
    let sql = SQL[shape].get_or_init(|| scopes::sql(query.scope, cursor, body, recovery));
    let mut statement = c.db.prepare_cached(sql)?;
    let mut rows = statement.query(params![principal, after, through, before, limit + 1])?;
    let mut items = Vec::new();
    let mut last_cursor = None;
    let mut next = None;
    while let Some(row) = rows.next().transpose() {
        c.check_cancel()?;
        let row = row?;
        let cursor = row.get::<_, i64>(0)?;
        // Borrow until decoding finishes; even the next-page probe need not
        // copy its JSON. Keep the same text/UTF-8 errors as String reads.
        let body = text_column(row, 1)?;
        if items.len() == limit as usize {
            next = last_cursor;
            break;
        }
        items.push(decode(body)?);
        last_cursor = Some(cursor);
    }
    Ok((items, next, through))
}
