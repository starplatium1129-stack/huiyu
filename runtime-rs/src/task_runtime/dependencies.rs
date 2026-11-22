use super::*;

// References must already exist in the same principal's ledger at acceptance.
// An edge can only point backwards, so concurrent submissions cannot form a cycle.
fn ids(context: &Value) -> Result<Vec<&str>> {
    let Some(raw) = context.get("dependsOnTaskIds") else {
        return Ok(Vec::new());
    };
    let values = raw
        .as_array()
        .filter(|list| list.len() <= 32)
        .ok_or_else(|| ApiError::invalid("前置任务列表最多可包含 32 条"))?;
    let mut ids = Vec::with_capacity(values.len());
    for value in values {
        let id = value
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 200 && !ids.contains(id))
            .ok_or_else(|| ApiError::invalid("前置任务编号无效或重复"))?;
        ids.push(id);
    }
    Ok(ids)
}

async fn lookup(storage: &Storage, principal: &str, id: &str) -> Result<Value> {
    let summary = storage
        .task(
            TaskCommand::Get {
                task_id: Some(id.into()),
                request_key: None,
                summary: true,
            },
            principal,
        )
        .await?;
    if summary.is_null() {
        return Err(ApiError::new(
            404,
            "TASK_DEPENDENCY_NOT_FOUND",
            "前置任务不在当前工作区",
        ));
    }
    Ok(summary)
}

pub(super) async fn validate(storage: &Storage, principal: &str, context: &Value) -> Result<bool> {
    let dependencies = ids(context)?;
    for id in &dependencies {
        lookup(storage, principal, id).await?;
    }
    Ok(!dependencies.is_empty())
}

pub(super) async fn wait(
    runtime: &TaskRuntime,
    storage: &Storage,
    principal: &str,
    task: &TaskRecord,
) -> Result<bool> {
    let context = task.metadata.get("context").unwrap_or(&Value::Null);
    let mut pending = ids(context)?;
    while !pending.is_empty() {
        runtime.check_running()?;
        let mut unfinished = Vec::new();
        for id in pending {
            let dependency = lookup(storage, principal, id).await?;
            if dependency["upstreamSettled"] == true {
                if dependency["status"] == "succeeded" && dependency["resultState"] == "available" {
                    continue;
                }
                if matches!(dependency["status"].as_str(), Some("failed" | "cancelled"))
                    || dependency["resultState"] == "unavailable"
                    || dependency["deliveryState"] == "discarded"
                {
                    return Err(ApiError::new(
                        409,
                        "TASK_DEPENDENCY_FAILED",
                        "前置任务未产出可用结果",
                    ));
                }
            }
            unfinished.push(id);
        }
        pending = unfinished;
        if !pending.is_empty() {
            tokio::select! {
                _ = runtime.shutdown.cancelled() => return Err(ApiError::new(503,"TASK_RUNTIME_CLOSED","任务调度已停止")),
                _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
            }
        }
        let current = TaskRuntime::get(storage, principal, &task.task_id).await?;
        if current.cancel_requested_at.is_some() || current.upstream_settled {
            return Ok(false);
        }
    }
    Ok(true)
}
