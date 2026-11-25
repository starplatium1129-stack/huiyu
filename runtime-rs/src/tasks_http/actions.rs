use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) async fn companion_draw(
    state: &AppState,
    storage: &Storage,
    session: &Session,
    peer: SocketAddr,
    uri: &Uri,
    method: &Method,
    headers: &HeaderMap,
    path: &[String],
    body: &[u8],
) -> Result<Response> {
    if !crate::security::is_direct_local(headers, peer.ip()) {
        return Err(ApiError::new(403, "LOCAL_ONLY", "对话绘图仅供本机使用"));
    }
    use crate::images::remote::muse::companion;
    let result = match (method.as_str(), path) {
        ("POST", [_, endpoint]) if endpoint == "agent" => {
            state
                .desktop_tools
                .as_ref()
                .ok_or_else(|| ApiError::new(403, "TOOL_PERMISSION_DENIED", "本机工具未启用"))?
                .check_drawing_permission("huiyu_drawing")
                .await?;
            let input: Value = serde_json::from_slice(body)?;
            match crate::images::remote::agent_cli::invoke(state, &input, "desktop", false).await {
                Ok(receipt) => receipt,
                Err(error) => json!({
                    "ok": false,
                    "code": error.code,
                    "message": error.message,
                    "requestKey": input["batchKey"]
                }),
            }
        }
        ("GET", [_, catalog]) if catalog == "catalog" => {
            companion::catalog(state, uri)
                .await
                .map_err(ApiError::not_accepted)?
        }
        (_, [_, id]) => companion::batch(state, storage, session, method, id, body).await?,
        (_, [_, id, index]) => {
            companion::item(state, storage, session, method, id, index, body).await?
        }
        _ => return Err(ApiError::invalid("无效的对话绘图地址")),
    };
    encode_response(json!({"ok":true,"result":result,"runtimeEpoch":storage.runtime_epoch()}))
        .await
}

pub(super) async fn image_batch(
    state: &AppState,
    storage: &Storage,
    session: &Session,
    method: &Method,
    path: &[String],
    body: &[u8],
) -> Result<Response> {
    let runtime = state
        .tasks
        .as_ref()
        .ok_or_else(|| ApiError::invalid("Task runtime unavailable"))?;
    let input: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(body)?
    };
    let command = match (method.as_str(), path) {
        ("GET", [_, id]) => json!({"kind":"imageBatch.get","id":id}),
        ("POST", [_, id]) => json!({"kind":"imageBatch.create","id":id,"plan":input}),
        ("POST", [_, id, action])
            if matches!(action.as_str(), "pause" | "resume" | "retry") =>
        {
            json!({"kind":"imageBatch.control","id":id,"action":action})
        }
        _ => return Err(ApiError::invalid("Unknown image batch route")),
    };
    let result = runtime
        .image_batch(storage.clone(), session.principal_id.clone(), command)
        .await?;
    encode_response(json!({"ok":true,"result":result,"runtimeEpoch":storage.runtime_epoch()}))
        .await
}

pub(super) async fn write(
    state: &AppState,
    storage: &Storage,
    session: &Session,
    method: &Method,
    path: &[String],
    body: &[u8],
) -> Result<Response> {
    let runtime = state.tasks.as_ref().ok_or_else(|| {
        ApiError::new(
            501,
            "TASK_PROVIDER_NOT_MIGRATED",
            "Task execution has not been migrated",
        )
    })?;
    let input: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(body)?
    };
    let result = match (method.as_str(), path) {
        ("POST", []) => {
            runtime
                .submit(storage.clone(), session.principal_id.clone(), input)
                .await?
        }
        ("DELETE", [by_key, key]) if by_key == "by-key" => {
            runtime
                .cancel(storage.clone(), session.principal_id.clone(), key.clone())
                .await?
        }
        ("DELETE", [id]) => {
            let task = get(state, storage, session, id, false).await?;
            let key = task["requestKey"]
                .as_str()
                .ok_or_else(invalid_record)?
                .to_owned();
            drop(task);
            runtime
                .cancel(storage.clone(), session.principal_id.clone(), key)
                .await?
        }
        ("POST", [id, action]) if action == "reconcile" => {
            runtime
                .reconcile(storage, &session.principal_id, id)
                .await?
        }
        ("POST", [id, action]) if action == "confirm-webui-stopped" => {
            let revision = input["expectedRevision"]
                .as_i64()
                .filter(|value| (0..=9_007_199_254_740_991).contains(value))
                .ok_or_else(|| ApiError::invalid("Missing or invalid task revision"))?;
            if input["upstreamStopped"] != true {
                return Err(ApiError::invalid(
                    "Confirm that WebUI has stopped or restarted",
                ));
            }
            runtime
                .resolve_webui(storage, &session.principal_id, id, revision, true)
                .await?
        }
        ("POST", [id, action]) if action == "resume" => {
            runtime
                .resume(storage.clone(), session.principal_id.clone(), id.clone())
                .await?
        }
        ("POST", [id, action]) if action == "retry" => {
            runtime
                .retry_manga(storage.clone(), session.principal_id.clone(), id.clone())
                .await?
        }
        ("POST", [id, action]) if ["concat", "continue"].contains(&action.as_str()) => {
            runtime
                .action(
                    storage.clone(),
                    session.principal_id.clone(),
                    id.clone(),
                    action.clone(),
                )
                .await?
        }
        ("PATCH", [id, action]) if action == "delivery" => {
            crate::task_runtime::TaskRuntime::delivery(
                storage,
                &session.principal_id,
                id,
                input["state"].as_str().unwrap_or(""),
            )
            .await?
        }
        _ => {
            return Err(ApiError::new(
                501,
                "TASK_PROVIDER_NOT_MIGRATED",
                "This task action has not been migrated",
            ));
        }
    };
    let mut envelope = json!({"ok":true,"result":null,"runtimeEpoch":storage.runtime_epoch()});
    envelope["result"] = result;
    encode_response(envelope).await
}
