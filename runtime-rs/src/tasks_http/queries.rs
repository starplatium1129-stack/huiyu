use super::*;

pub(super) async fn read(
    state: &AppState,
    storage: &Storage,
    session: &Session,
    uri: &Uri,
    method: &Method,
    path: &[String],
) -> Result<Response> {
    if let [id, result, index] = path
        && result == "results"
    {
        return Ok(results::read(state, storage, session, method, id, index)
            .await
            .unwrap_or_else(|error| {
                failure(
                    ApiError {
                        code: "TASK_RESULT_UNAVAILABLE".into(),
                        ..error
                    },
                    "结果读取未完成",
                )
            }));
    }
    if let [id, inputs, index] = path
        && inputs == "inputs"
    {
        return qwen_inputs::read(state, storage, session, method, id, index).await;
    }
    let mut result = match path {
        [] => {
            let mut command = json!({"kind":"task.list"});
            for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()) {
                if key == "scope"
                    && matches!(
                        value.as_ref(),
                        "all" | "overview" | "open" | "attention" | "inbox"
                    )
                {
                    command["scope"] = json!(value);
                    continue;
                }
                if key == "summary" && matches!(value.as_ref(), "true" | "false") {
                    command["summary"] = json!(value == "true");
                    continue;
                }
                if !matches!(
                    key.as_ref(),
                    "before" | "afterRevision" | "throughRevision" | "limit"
                ) {
                    return Err(ApiError::invalid("Unknown task page parameter"));
                }
                let value: i64 = value
                    .parse()
                    .map_err(|_| ApiError::invalid("Invalid task page parameter"))?;
                command[key.as_ref()] = json!(value);
            }
            let mut list = request(state, storage, session, command).await?;
            let items = list["items"].as_array_mut().ok_or_else(invalid_record)?;
            for task in items {
                project_task(task, session, state, storage)?;
            }
            list
        }
        [name] if name == "legacy-history" => {
            request(
                state,
                storage,
                session,
                json!({"kind":"task.legacy-history"}),
            )
            .await?
        }
        [by_key, key] if by_key == "by-key" => {
            request(
                state,
                storage,
                session,
                json!({"kind":"task.get","requestKey":key}),
            )
            .await?
        }
        [id] => {
            let mut summary = false;
            for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()) {
                if key == "summary" {
                    summary = match value.as_ref() {
                        "true" => true,
                        "false" => false,
                        _ => return Err(ApiError::invalid("Invalid task summary parameter")),
                    };
                }
            }
            get(state, storage, session, id, summary).await?
        }
        _ => {
            return Err(ApiError::new(
                404,
                "TASK_ROUTE",
                "Task route does not exist",
            ));
        }
    };
    if result.get("taskId").is_some() {
        project_task(&mut result, session, state, storage)?;
        if let Some(runtime) = &state.tasks {
            result["liveProgress"] = runtime
                .live_progress(storage, &session.principal_id, &result)
                .await
                .unwrap_or(Value::Null);
        }
    }
    let mut envelope = json!({"ok":true,"result":null,"runtimeEpoch":storage.runtime_epoch(),"executionAvailable":state.tasks.is_some()});
    envelope["result"] = result;
    encode_response(envelope).await
}
