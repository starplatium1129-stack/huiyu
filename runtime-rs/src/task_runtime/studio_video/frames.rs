use super::*;

impl TaskRuntime {
    pub(super) async fn studio_frames(
        self: &Arc<Self>,
        store: &Storage,
        owner: &str,
        run: &Value,
    ) -> Result<()> {
        let plan = &run["preparation"];
        let tasks = plan["tasks"]
            .as_array()
            .ok_or_else(|| ApiError::invalid("镜头补帧清单无效"))?;
        let failed = tasks.iter().find(|child| {
            matches!(
                child["status"].as_str(),
                Some("failed" | "cancelled" | "interrupted")
            )
        });
        let cancelling = run["cancelRequested"] == true || failed.is_some();
        let mut settled = true;
        for child in tasks {
            if matches!(
                child["status"].as_str(),
                Some("succeeded" | "failed" | "cancelled" | "interrupted")
            ) {
                continue;
            }
            let key = text(child, "requestKey")?;
            let mut update = json!({"kind":"studio.videoFrame","id":run["id"],"slot":child["slot"],"status":"queued"});
            if let Some(task) = store.task_record_by_request(key, owner).await? {
                if task.kind != TaskKind::Keyframe
                    || task.provider != "native"
                    || task
                        .metadata
                        .get("context")
                        .and_then(|v| v.get("studioFrameRunId"))
                        != Some(&run["id"])
                {
                    return Err(ApiError::new(
                        409,
                        "STUDIO_TASK_IDENTITY",
                        "补帧任务与提交记录不一致",
                    ));
                }
                if cancelling && !task.status.terminal() && task.cancel_requested_at.is_none() {
                    self.cancel(store.clone(), owner.into(), key.into()).await?;
                    settled = false;
                    continue;
                }
                if !task.status.terminal() && !self.owns(store, &task.task_id) {
                    self.start_recovery(store.clone(), owner.into())?;
                    if task.status == TaskStatus::Queued
                        && task.recovery_state == TaskRecoveryState::Interrupted
                        && task.cancel_requested_at.is_none()
                        && task.submission_intent_at.is_none()
                        && !task.upstream_settled
                    {
                        let resumed = self
                            .resume(store.clone(), owner.into(), task.task_id.clone())
                            .await;
                        if let Err(e) = resumed
                            && e.code == "TASK_RESUME_UNSAFE"
                            && task.provider_fingerprint != self.binding_for(task.kind)
                        {
                            update["status"] = "interrupted".into();
                            update["error"] = "补帧推理环境已改变".into();
                            store.request(update, owner).await?;
                            continue;
                        }
                    }
                }
                update["taskId"] = json!(task.task_id);
                update["status"] = match (task.status, task.result_state, task.upstream_settled) {
                    (TaskStatus::Succeeded, ResultState::Available, _) => "succeeded",
                    (TaskStatus::Cancelled, _, true) => "cancelled",
                    (TaskStatus::Failed, _, true) => "failed",
                    (TaskStatus::Succeeded, ResultState::Unavailable, true) => "interrupted",
                    (TaskStatus::Queued | TaskStatus::Submitting, _, _) => "queued",
                    _ => "running",
                }
                .into();
                if let Some(msg) = task.error_code {
                    update["error"] = task
                        .metadata
                        .get("errorMessage")
                        .cloned()
                        .unwrap_or_else(|| json!(msg));
                }
                if let Some(info) = task.metadata.get("nativeRuntime") {
                    update["telemetry"] = info.clone();
                }
            } else if cancelling {
                self.cancel(store.clone(), owner.into(), key.into()).await?;
                update["status"] = "cancelled".into();
            } else {
                let submitted = self.submit_studio_frame(store, owner, run, child).await;
                match submitted {
                    Ok(v) => update["taskId"] = v["taskId"].clone(),
                    Err(e) if retry_admission(&e) => {
                        settled = false;
                        continue;
                    }
                    Err(e) => {
                        update["status"] = "failed".into();
                        update["error"] = e.message.into();
                    }
                }
            }
            if matches!(update["status"].as_str(), Some("queued" | "running")) {
                settled = false;
            }
            if ["taskId", "status", "error", "telemetry"]
                .iter()
                .any(|k| update.get(*k).is_some_and(|v| v != &child[*k]))
            {
                store.request(update, owner).await?;
            }
        }
        if cancelling && settled {
            let error = failed
                .and_then(|f| f["error"].as_str())
                .unwrap_or("分镜补帧已取消");
            let status = if run["cancelRequested"] == true {
                "cancelled"
            } else {
                "failed"
            };
            store.request(json!({"kind":"studio.videoAdvance","id":run["id"],"status":status,"error":error}),owner).await?;
        }
        Ok(())
    }
    async fn submit_studio_frame(
        self: &Arc<Self>,
        store: &Storage,
        owner: &str,
        run: &Value,
        child: &Value,
    ) -> Result<Value> {
        let plan = &run["preparation"];
        let mut names = Vec::new();
        for frame in plan["referenceMedia"]
            .as_array()
            .ok_or_else(|| ApiError::invalid("缺少补帧原图"))?
        {
            names.push(
                self.images
                    .studio_reference(store.clone(), owner, frame)
                    .await?,
            );
        }
        let (first, more) = names
            .split_first()
            .ok_or_else(|| ApiError::invalid("缺少补帧原图"))?;
        let input = json!({"modelId":plan["modelId"],"seed":child["seed"],"prompt":child["prompt"],"width":plan["width"],"height":plan["height"],
            "initImage":first,"referenceImages":more});
        self.submit(store.clone(),owner.into(),json!({"kind":"keyframe","requestKey":child["requestKey"],"input":input,
            "context":{"studioFrameRunId":run["id"],"projectId":run["projectId"],"shotId":run["shotId"],"slot":child["slot"]}})).await
    }
}
