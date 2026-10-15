use super::*;
use crate::task_contract::{TaskListQuery, TaskListScope, TaskSummary};

// Project in SQLite: large recipes and checkpoints never cross the worker boundary.
const SUMMARY_BODY: &str = "json_set(json_remove(record_json,'$.input','$.inputMediaRefs','$.metadata','$.checkpoint','$.requestFingerprint','$.requestFingerprintLocale','$.providerFingerprint'),
         '$.sourceBatchId', CASE WHEN json_type(record_json,'$.metadata.context.retriedTaskId')='text' AND json_type(record_json,'$.metadata.context.stepIndex')='integer' AND json_extract(record_json,'$.metadata.context.stepIndex')>=0 THEN json_extract(record_json,'$.metadata.context.retriedTaskId') ELSE NULL END,
         '$.canConcat', json(CASE WHEN json_extract(record_json,'$.kind')='batch' AND json_extract(record_json,'$.status')='succeeded' AND json_array_length(record_json,'$.resultRefs')>1 AND json_type(record_json,'$.checkpoint.shots')='array' AND NOT EXISTS (SELECT 1 FROM json_each(record_json,'$.resultRefs') WHERE json_extract(value,'$.index')=json_array_length(record_json,'$.checkpoint.shots')) THEN 'true' ELSE 'false' END))";

pub(super) fn read_summary(c: &Context, principal: &str, id: &str) -> Result<Value> {
    let mut statement = c.db.prepare_cached(&format!(
        "SELECT {SUMMARY_BODY} FROM tasks WHERE principal_id=? AND task_id=?"
    ))?;
    let decoded = statement
        .query_row(params![principal, id], |row| {
            Ok(serde_json::from_str::<TaskSummary>(text_column(row, 0)?))
        })
        .optional()?;
    let Some(task) = decoded else {
        return Ok(Value::Null);
    };
    let mut task = task?;
    task.runtime_epoch = c.epoch.clone();
    Ok(serde_json::to_value(task)?)
}

// Revisions are unique and monotonic across durable writes. A fixed upper bound
// prevents new writes moving the page boundary; updates above it are returned
// by the next incremental refresh, including updates to not-yet-read records.
pub(super) fn read(c: &Context, principal: &str, query: TaskListQuery) -> Result<Value> {
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
        "record_json"
    };
    // Startup recovery runs once: use immutable rowids, so concurrent task
    // updates cannot move a still-unvisited recovery candidate out of its page.
    let cursor = if query.recoverable {
        "rowid"
    } else {
        "json_extract(record_json,'$.revision')"
    };
    let sql = scopes::sql(query.scope, cursor, body, recovery);
    let mut statement = c.db.prepare_cached(&sql)?;
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
        let mut task = if query.summary {
            serde_json::to_value(serde_json::from_str::<TaskSummary>(body)?)?
        } else {
            serde_json::from_str::<TaskRecord>(body)?.into_value()?
        };
        task["runtimeEpoch"] = json!(c.epoch);
        items.push(task);
        last_cursor = Some(cursor);
    }
    let mut result = json!({"runtimeEpoch": c.epoch, "items": null, "nextCursor": next, "throughRevision": through});
    result["items"] = Value::Array(items);
    Ok(result)
}
