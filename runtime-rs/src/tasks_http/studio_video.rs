use super::*;

pub(super) async fn route(
    state: &AppState,
    storage: &Storage,
    session: &Session,
    method: &Method,
    path: &[String],
    body: &[u8],
) -> Result<Response> {
    let [scope, projects, project, rest @ ..] = path else {
        return Err(ApiError::invalid("分镜视频地址无效"));
    };
    if scope != "studio-video"
        || projects != "projects"
        || project.is_empty()
        || project.len() > 640
    {
        return Err(ApiError::invalid("分镜项目编号无效"));
    }
    let principal = &session.principal_id;
    let runtime = state
        .tasks
        .as_ref()
        .ok_or_else(|| ApiError::invalid("任务服务尚未就绪"))?;
    let catalog = crate::studio_workflows::load(state.config.runtime_root.clone()).await?;
    let templates = &catalog.templates;
    let action = rest.iter().map(String::as_str).collect::<Vec<_>>();
    match (method.as_str(), action.as_slice()) {
        ("GET" | "HEAD", []) => {}
        ("POST", ["batches", batch]) => {
            uuid::Uuid::parse_str(batch)
                .map_err(|_| ApiError::invalid("批次需要稳定的 UUID").not_accepted())?;
            let spec: Value = serde_json::from_slice(body)
                .map_err(|_| ApiError::invalid("分镜批次格式无效").not_accepted())?;
            if !spec.is_object() || spec.as_object().is_some_and(|obj| obj.len() != 1) {
                return Err(ApiError::invalid("分镜批次必须包含 shots 列表").not_accepted());
            }
            runtime.studio_command(storage.clone(), principal.clone(),
                json!({"kind":"studio.videoEnqueue","request":spec,"projectId":project,"batchId":batch,
                "templates":templates}), state.host.admit_owned()?).await.map_err(|error| {
                    // Validation and SQLite conflicts rolled back the batch. An
                    // ambiguous commit or a lost reply must retain its original key.
                    if error.status.is_client_error() { error.not_accepted() } else { error }
                })?;
        }
        ("POST", ["runs", run, "cancel"]) => {
            runtime
                .studio_command(
                    storage.clone(),
                    principal.clone(),
                    json!({"kind":"studio.videoCancel","id":run,"projectId":project}),
                    state.host.admit_owned()?,
                )
                .await?;
        }
        ("POST", ["shots", shot, "current"]) => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Select {
                run_id: String,
                expected_revision: i64,
            }
            let choice: Select = serde_json::from_slice(body)
                .map_err(|_| ApiError::invalid("请选择该镜头的历史结果").not_accepted())?;
            runtime.studio_command(storage.clone(), principal.clone(),
                json!({"kind":"studio.videoSelect","projectId":project,"shotId":shot,"runId":choice.run_id,"expectedRevision":choice.expected_revision}),
                state.host.admit_owned()?).await.map_err(definitive)?;
        }
        ("POST", ["exports", key]) => {
            uuid::Uuid::parse_str(key)
                .map_err(|_| ApiError::invalid("导出需要稳定的 UUID").not_accepted())?;
            let spec: Value = serde_json::from_slice(body)
                .map_err(|_| ApiError::invalid("导出请求格式无效").not_accepted())?;
            runtime.studio_command(storage.clone(),principal.clone(),
                json!({"kind":"studio.exportEnqueue","projectId":project,"id":key,"request":spec}),
                state.host.admit_owned()?).await.map_err(definitive)?;
        }
        ("POST", ["exports", key, "cancel"]) => {
            runtime
                .studio_command(
                    storage.clone(),
                    principal.clone(),
                    json!({"kind":"studio.exportCancel","projectId":project,"id":key}),
                    state.host.admit_owned()?,
                )
                .await
                .map_err(definitive)?;
        }
        _ => {
            return Err(ApiError::new(
                404,
                "STUDIO_VIDEO_ROUTE",
                "未知的分镜视频操作",
            ));
        }
    }
    runtime.start_recovery(storage.clone(), principal.clone())?;
    let mut runs = storage
        .request(
            json!({"kind":"studio.videoList","projectId":project}),
            principal,
        )
        .await?;
    if let Some(rows) = runs.as_array_mut() {
        if rows
            .iter()
            .any(|r| matches!(r["status"].as_str(), Some("running" | "queued")))
        {
            runtime.wake_studio(storage.clone(), principal.clone());
        }
        for run in rows {
            let child = run["preparation"]["tasks"]
                .as_array()
                .and_then(|children| children.iter().find(|r| r["status"] == "running"));
            let active = child.and_then(|r| r["taskId"].as_str()).or_else(|| {
                (run["status"] == "running")
                    .then(|| run["taskId"].as_str())
                    .flatten()
            });
            if let Some(id) = active
                && let Some(task) = storage.task_record(id, principal).await?
                && let Some(live) = runtime
                    .live_progress(storage, principal, &task.into_value()?)
                    .await
            {
                run["liveProgress"] = live;
            }
            if let Some(prep) = run["preparation"].as_object_mut() {
                prep.remove("referenceMedia");
            }
            if let Some(record) = run.as_object_mut() {
                for k in ["input", "firstRef", "lastRef", "audioRef"] {
                    record.remove(k);
                }
            }
        }
    }
    let exports = storage
        .request(
            json!({"kind":"studio.exportList","projectId":project}),
            principal,
        )
        .await?;
    if exports.as_array().is_some_and(|rows| {
        rows.iter()
            .any(|r| matches!(r["status"].as_str(), Some("queued" | "running")))
    }) {
        runtime.wake_exports(storage.clone(), principal.clone());
    }
    encode_response(json!({"ok":true,"runtimeEpoch":storage.runtime_epoch(),
        "result":{"templates":templates.iter().map(|t|t.summary()).collect::<Vec<_>>(),"templateWarnings":catalog.warnings,"runs":runs,"exports":exports}})).await
}
fn definitive(error: ApiError) -> ApiError {
    if error.status.is_client_error() {
        error.not_accepted()
    } else {
        error
    }
}
