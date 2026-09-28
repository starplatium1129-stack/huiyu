use super::*;
use crate::task_contract::TaskListQuery;

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
    let recovery = if query.recoverable {
        " AND json_extract(record_json,'$.deliveryState') != 'discarded' AND (upstream_settled=0 OR (json_extract(record_json,'$.status')='succeeded' AND json_extract(record_json,'$.resultState')!='available'))"
    } else {
        ""
    };
    // Startup recovery runs once: use immutable rowids, so concurrent task
    // updates cannot move a still-unvisited recovery candidate out of its page.
    let cursor = if query.recoverable {
        "rowid"
    } else {
        "json_extract(record_json,'$.revision')"
    };
    let sql = format!(
        "SELECT {cursor},record_json FROM tasks WHERE principal_id=? AND {cursor}>? AND {cursor}<=? AND {cursor}<?{recovery} ORDER BY {cursor} DESC LIMIT ?"
    );
    let mut statement = c.db.prepare_cached(&sql)?;
    let rows = statement.query_map(params![principal, after, through, before, limit + 1], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut items = Vec::new();
    let mut cursors = Vec::new();
    for row in rows {
        c.check_cancel()?;
        let (cursor, body) = row?;
        let mut task: TaskRecord = serde_json::from_str(&body)?;
        task.runtime_epoch = c.epoch.clone();
        items.push(task);
        cursors.push(cursor);
    }
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = if more {
        cursors.get(limit as usize - 1).copied()
    } else {
        None
    };
    Ok(
        json!({"runtimeEpoch": c.epoch, "items": items, "nextCursor": next, "throughRevision": through}),
    )
}
