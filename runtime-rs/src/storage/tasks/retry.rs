//! Manga retry linkage shares acceptance's transaction and media objects.
use super::*;

pub(super) fn source(
    c: &Context,
    principal: &str,
    id: &str,
    child: &TaskRecord,
) -> Result<TaskRecord> {
    let source = require(c, principal, id)?;
    if !source.can_retry_manga()
        || child.kind != source.kind
        || child.provider != source.provider
        || child.provider_fingerprint != source.provider_fingerprint
        || child.input != source.input
        || child.request_key != format!("manga-retry:{id}")
        || child.metadata.get("retryOfTaskId") != Some(&json!(id))
        || child.metadata.get("context") != source.metadata.get("context")
        || source.metadata.contains_key("retryTaskId")
        || !child.input_media_refs.is_empty()
    {
        return Err(conflict(
            "TASK_RETRY_UNSAFE",
            "原任务已变化或已有重试记录，请重新核对",
        ));
    }
    Ok(source)
}

pub(super) fn attach(
    c: &Context,
    principal: &str,
    mut source: TaskRecord,
    mut child: TaskRecord,
) -> Result<Value> {
    let mut names = std::collections::HashSet::new();
    for key in ["initImage", "penLines"] {
        let Some(name) = source.input.get(key).and_then(Value::as_str) else {
            if key == "initImage" {
                return Err(conflict("TASK_INPUT_MISSING", "原任务缺少已保存的原图"));
            }
            continue;
        };
        if !names.insert(name) {
            continue;
        }
        let mut media = inputs::execute_read(c, principal, &source.task_id, name)?;
        if media.is_null() {
            return Err(conflict(
                "TASK_INPUT_MISSING",
                "原图或外部线稿尚未持久化，不能一键重试",
            ));
        }
        media::validate(&media)?;
        let hash = string(&media, "sha256")?.to_owned();
        let alias = string(&media, "alias")?;
        let stored: Option<(String, i64, String)> = c.db.query_row(
            "SELECT a.hash,o.bytes,o.mime FROM media_aliases a JOIN media_objects o ON o.hash=a.hash WHERE a.alias=?",
            [alias], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        if !source.input_media_refs.iter().any(|item| item == alias)
            || !stored.is_some_and(|(saved, bytes, mime)| {
                saved == hash
                    && Some(bytes) == media["bytes"].as_i64()
                    && Some(mime.as_str()) == media["mime"].as_str()
            })
        {
            return Err(conflict(
                "TASK_INPUT_MISSING",
                "已保存的任务素材引用不可用，请核对工作区",
            ));
        }
        let alias = format!(
            "task-input-{}",
            canonical::digest(format!("input:{}:{name}", child.task_id))
        );
        media["alias"] = json!(alias);
        c.db.execute(
            "INSERT INTO media_aliases VALUES(?,?)",
            params![alias, hash],
        )?;
        c.db.execute(
            "INSERT INTO task_inputs VALUES(?,?,?,1)",
            params![child.task_id, name, stringify(&media)],
        )?;
        c.db.execute(
            "INSERT OR IGNORE INTO media_refs VALUES('task-input',?,?)",
            params![child.task_id, hash],
        )?;
        child.input_media_refs.push(alias);
    }
    source
        .metadata
        .insert("retryTaskId".into(), json!(child.task_id));
    write(c, source)?;
    write(c, child)
}
