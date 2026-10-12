use super::*;
use crate::task_contract::TaskListScope;

// Share exact predicates with the partial indexes: SQLite's implication rules
// must recognize the same scope, including SQL NULL behavior.
const OPEN: &str = "(upstream_settled=0 OR json_extract(record_json,'$.recoveryState')!='normal')";
const ATTENTION: &str = "(json_extract(record_json,'$.recoveryState')!='normal' OR json_extract(record_json,'$.status')='failed')";
const INBOX: &str = "json_array_length(record_json,'$.resultRefs')>0 AND json_extract(record_json,'$.deliveryState') NOT IN ('saved','discarded')";

pub(in crate::storage) fn initialize(db: &Connection) -> Result<()> {
    // Reapply on open for existing v3 workspaces and restored older backups.
    // SQLite maintains membership in the same transaction as every task write.
    for (name, predicate) in [
        ("tasks_open_revision", OPEN),
        ("tasks_attention_revision", ATTENTION),
        ("tasks_inbox_revision", INBOX),
    ] {
        db.execute_batch(&format!(
            "CREATE INDEX IF NOT EXISTS {name} ON tasks(principal_id,json_extract(record_json,'$.revision')) WHERE {predicate};"
        ))?;
    }
    Ok(())
}

pub(super) fn sql(scope: TaskListScope, cursor: &str, body: &str, recovery: &str) -> String {
    if scope == TaskListScope::Overview {
        // Recent membership depends only on principal and the fixed upper bound,
        // before applying this page's lower/before cursors. UNION deduplicates
        // recent tasks that are also open; rowids stay internal to this query.
        // Each sorted branch needs at most k keys to supply the union's top k.
        // Limit OPEN before merging; fetch JSON only after final page selection.
        return format!(
            "WITH selected AS (
                SELECT rowid,revision FROM (
                    SELECT rowid,json_extract(record_json,'$.revision') AS revision FROM tasks
                WHERE principal_id=?1 AND json_extract(record_json,'$.revision')>?2
                    AND json_extract(record_json,'$.revision')<=?3
                    AND json_extract(record_json,'$.revision')<?4 AND {OPEN}
                    ORDER BY json_extract(record_json,'$.revision') DESC LIMIT ?5
                )
                UNION SELECT rowid,revision FROM (
                    SELECT rowid,json_extract(record_json,'$.revision') AS revision FROM tasks
                    WHERE principal_id=?1 AND json_extract(record_json,'$.revision')<=?3
                    ORDER BY json_extract(record_json,'$.revision') DESC LIMIT 60
                )
            ), page AS MATERIALIZED (
                SELECT rowid,revision FROM selected
                WHERE revision>?2 AND revision<=?3 AND revision<?4
                ORDER BY revision DESC LIMIT ?5
            )
            SELECT page.revision,{body} FROM page JOIN tasks ON tasks.rowid=page.rowid
            ORDER BY page.revision DESC"
        );
    }
    let predicate = match scope {
        TaskListScope::Open => OPEN,
        TaskListScope::Attention => ATTENTION,
        TaskListScope::Inbox => INBOX,
        TaskListScope::All => "",
        TaskListScope::Overview => unreachable!(),
    };
    let filter = if predicate.is_empty() {
        String::new()
    } else {
        format!(" AND {predicate}")
    };
    format!(
        "SELECT {cursor},{body} FROM tasks WHERE principal_id=?1 AND {cursor}>?2 AND {cursor}<=?3 AND {cursor}<?4{recovery}{filter} ORDER BY {cursor} DESC LIMIT ?5"
    )
}
