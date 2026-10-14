use super::*;
use crate::task_contract::ResultRef;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Projection {
    principal_id: String,
    workspace_id: String,
    result_refs: Vec<ResultRef>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResultReference {
    pub(crate) principal_id: String,
    pub(crate) workspace_id: String,
    pub(crate) reference: Option<ResultRef>,
}
impl Projection {
    fn select(self, index: u64) -> ResultReference {
        ResultReference {
            principal_id: self.principal_id,
            workspace_id: self.workspace_id,
            reference: self
                .result_refs
                .into_iter()
                .find(|reference| reference.index == index),
        }
    }
}

pub(super) fn read(c: &Context, principal: &str, command: &Value) -> Result<Value> {
    c.check_cancel()?;
    let id = string(command, "taskId")?;
    let index = command["index"]
        .as_u64()
        .ok_or_else(|| invalid("Invalid task result index"))?;
    // Keep complete result-reference validation and u64 index matching, without
    // decoding frozen inputs, metadata or batch checkpoints into Rust objects.
    let projected =
        c.db.prepare_cached(
            "SELECT json_object('principalId',json_extract(record_json,'$.principalId'),
            'workspaceId',json_extract(record_json,'$.workspaceId'),
            'resultRefs',json_extract(record_json,'$.resultRefs'))
         FROM tasks WHERE principal_id=?1 AND task_id=?2",
        )?
        .query_row(params![principal, id], |row| {
            Ok(serde_json::from_str::<Projection>(text_column(row, 0)?))
        })
        .optional();
    let reference = match projected {
        Ok(Some(Ok(projection))) => projection.select(index),
        Ok(None) => return Err(ApiError::new(404, "TASK_NOT_FOUND", "Task does not exist")),
        // Preserve the full reader's JSON/SQLite errors on malformed persisted
        // data instead of converting SQLite JSON failures into a new error type.
        _ => {
            let task = require(c, principal, id)?;
            Projection {
                principal_id: task.principal_id,
                workspace_id: task.workspace_id,
                result_refs: task.result_refs,
            }
            .select(index)
        }
    };
    c.check_cancel()?;
    Ok(serde_json::to_value(reference)?)
}

pub(super) fn import(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    let lease = canonical::digest(stringify(&json!([
        c.epoch,
        principal,
        string(command, "leaseId")?
    ])));
    if command["kind"] == "task.result.import.end" {
        c.db.execute(
            "DELETE FROM leases WHERE id=? AND kind='video-import'",
            [&lease],
        )?;
        return Ok(Value::Null);
    }
    if command["kind"] != "task.result.import.begin" {
        return Err(invalid("Unknown task media import command"));
    }
    c.transaction(|c| {
        let value = read(c, principal, command)?;
        let result: ResultReference = serde_json::from_value(value.clone())?;
        let reference = result
            .reference
            .as_ref()
            .filter(|reference| command["alias"].as_str() == Some(reference.alias.as_str()))
            .ok_or_else(|| conflict("TASK_RESULT_MISSING", "Task result alias does not match"))?;
        if result.principal_id != principal || result.workspace_id != c.workspace_id {
            return Err(conflict(
                "TASK_RECORD_INVALID",
                "Task result authority does not match",
            ));
        }
        let media = c.lookup_media(&reference.alias)?;
        if reference.sha256 != media.sha256
            || reference.bytes != media.total_bytes
            || reference.mime != media.mime
        {
            return Err(conflict(
                "MEDIA_INVALID",
                "Task result metadata does not match",
            ));
        }
        // Hold this source through verification, copying and controlled publication,
        // including when another window discards the originating task meanwhile.
        c.db.execute(
            "INSERT INTO leases(id,kind,hash,created_at) VALUES(?,'video-import',?,?)",
            params![lease, reference.sha256, now()],
        )?;
        Ok(value)
    })
}
