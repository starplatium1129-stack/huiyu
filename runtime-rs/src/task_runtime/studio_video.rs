use super::*;
mod frames;
use std::time::Duration;
use tokio::sync::Notify;

fn retry_admission(error: &ApiError) -> bool {
    matches!(
        error.code.as_str(),
        "NATIVE_QUEUE_FULL"
            | "NATIVE_QUEUE_BUSY"
            | "TASK_PROVIDER_BUSY"
            | "GENERATION_BUSY"
            | "TASK_ACCEPT_UNKNOWN"
            | "STORAGE_UNAVAILABLE"
            | "COMMIT_UNKNOWN"
            | "TASK_RUNTIME_CLOSED"
            | "SERVICE_CLOSED"
    )
}

impl TaskRuntime {
    pub(crate) async fn studio_command(
        self: &Arc<Self>,
        storage: Storage,
        principal: String,
        command: Value,
        admission: crate::host::OwnedWriteGuard,
    ) -> Result<()> {
        self.check_running()?;
        let runtime = self.clone();
        let (reply, received) = tokio::sync::oneshot::channel();
        // The durable mutation and its dispatcher survive an HTTP disconnect.
        self.tracker.spawn(async move {
            let _admission = admission;
            let result = storage.request(command, &principal).await;
            if result.is_ok() || result.as_ref().is_err_and(|e| e.code == "COMMIT_UNKNOWN") {
                runtime.wake_studio(storage, principal);
            }
            let _ = reply.send(result.map(|_| ()));
        });
        received.await.map_err(|_| {
            ApiError::new(
                503,
                "STUDIO_COMMAND_UNKNOWN",
                "请按原批次编号重新查询提交结果",
            )
        })?
    }

    /// Also recover before a window opens. The private workspace supplies the
    /// original principal for each unfinished manifest, never a caller's guess.
    pub(crate) fn restore_studio(self: &Arc<Self>, storage: Storage) {
        let runtime = self.clone();
        self.tracker.spawn(async move {
            match storage
                .request(json!({"kind":"studio.videoOwners"}), "studio-recovery")
                .await
            {
                Ok(owners) => {
                    for owner in owners
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                    {
                        runtime.wake_studio(storage.clone(), owner.to_owned());
                    }
                }
                Err(error) => eprintln!("studio video recovery: {error}"),
            }
        });
    }

    pub(crate) fn wake_studio(self: &Arc<Self>, storage: Storage, principal: String) {
        if self.check_running().is_err() {
            return;
        }
        self.wake_exports(storage.clone(), principal.clone());
        let key = format!("{}:{principal}", storage.runtime_epoch());
        let mut workers = self.studio_workers.lock().unwrap();
        if let Some(wake) = workers.get(&key) {
            wake.notify_one();
            return;
        }
        let wake = Arc::new(Notify::new());
        workers.insert(key.clone(), wake.clone());
        let runtime = self.clone();
        self.tracker
            .spawn(runtime.drive_studio(storage, principal, key, wake));
    }

    async fn drive_studio(
        self: Arc<Self>,
        storage: Storage,
        principal: String,
        key: String,
        wake: Arc<Notify>,
    ) {
        let pending = json!({"kind":"studio.videoPending"});
        while self.check_running().is_ok() {
            let mut delay = Duration::from_millis(1200);
            match storage.request(pending.clone(), &principal).await {
                Ok(value) if value.as_array().is_some_and(Vec::is_empty) => {
                    // Once unregistered, any concurrent enqueue installs a fresh
                    // dispatcher. Catch work admitted just before removal as well.
                    self.studio_workers.lock().unwrap().remove(&key);
                    match storage.request(pending.clone(), &principal).await {
                        Ok(runs) if runs.as_array().is_some_and(Vec::is_empty) => {}
                        _ => self.wake_studio(storage, principal),
                    }
                    return;
                }
                Ok(value) => {
                    let runs = value.as_array().map(Vec::as_slice).unwrap_or_default();
                    self.dispatch_studio_runs(&storage, &principal, runs).await;
                }
                Err(error) => {
                    eprintln!("studio video queue: {error}");
                    delay = Duration::from_secs(5);
                }
            }
            tokio::select! {
                _ = self.shutdown.cancelled() => break,
                _ = wake.notified() => {},
                _ = tokio::time::sleep(delay) => {},
            }
        }
        self.studio_workers.lock().unwrap().remove(&key);
    }

    async fn dispatch_studio_runs(
        self: &Arc<Self>,
        storage: &Storage,
        principal: &str,
        runs: &[Value],
    ) {
        let needs_frames =
            |run: &Value| !run["preparation"].is_null() && run["preparation"]["state"] != "ready";
        // Admit every required image before dispatching Wan for the same batch.
        let preparing: std::collections::HashSet<_> = runs
            .iter()
            .filter(|r| needs_frames(r))
            .filter_map(|r| r["batchId"].as_str())
            .collect();
        for run in runs {
            if self.check_running().is_err() {
                break;
            }
            let result = if needs_frames(run) {
                self.studio_frames(storage, principal, run).await
            } else if run["cancelRequested"] == true
                || run["taskId"].is_string()
                || !preparing.contains(run["batchId"].as_str().unwrap_or(""))
            {
                self.studio_tick(storage, principal, run).await
            } else {
                continue;
            };
            if let Err(error) = result {
                eprintln!("studio video {}: {error}", run["id"]);
            }
        }
    }
    async fn studio_tick(
        self: &Arc<Self>,
        storage: &Storage,
        principal: &str,
        run: &Value,
    ) -> Result<()> {
        let id = text(run, "id")?;
        let key = format!("studio-render-{id}");
        let record = storage.task_record_by_request(&key, principal).await?;
        let mut update = json!({"kind":"studio.videoAdvance","id":id,"status":"queued"});
        if let Some(task) = record {
            if task.kind != TaskKind::Video
                || task.provider != "native"
                || task
                    .metadata
                    .get("context")
                    .and_then(|v| v["studioRunId"].as_str())
                    != Some(id)
            {
                return Err(ApiError::new(
                    409,
                    "STUDIO_TASK_IDENTITY",
                    "镜头与原生任务身份不一致",
                ));
            }
            if run["cancelRequested"] == true
                && !task.status.terminal()
                && task.cancel_requested_at.is_none()
            {
                self.cancel(storage.clone(), principal.into(), key).await?;
                return Ok(());
            }
            if !task.status.terminal() && !self.owns(storage, &task.task_id) {
                self.start_recovery(storage.clone(), principal.to_owned())?;
                if task.status == TaskStatus::Queued
                    && task.recovery_state == TaskRecoveryState::Interrupted
                    && task.submission_intent_at.is_none()
                    && task.cancel_requested_at.is_none()
                    && !task.upstream_settled
                {
                    match self
                        .resume(storage.clone(), principal.into(), task.task_id.clone())
                        .await
                    {
                        Err(e)
                            if e.code == "TASK_RESUME_UNSAFE"
                                && task.provider_fingerprint != self.binding_for(task.kind) =>
                        {
                            update["status"] = "interrupted".into();
                            update["error"] = "任务保存的推理环境已改变，请重新生成这个镜头".into();
                            storage.request(update, principal).await?;
                            return Ok(());
                        }
                        Err(e) => return Err(e),
                        Ok(_) => return Ok(()),
                    }
                }
            }
            let state = match task.status {
                TaskStatus::Queued | TaskStatus::Submitting => "queued",
                TaskStatus::Running | TaskStatus::Cancelling => "running",
                TaskStatus::Succeeded if task.result_state == ResultState::Available => "succeeded",
                TaskStatus::Succeeded if task.result_state == ResultState::Unavailable => {
                    "interrupted"
                }
                TaskStatus::Succeeded => "running",
                TaskStatus::Cancelled if task.upstream_settled => "cancelled",
                TaskStatus::Failed if task.upstream_settled => "failed",
                _ => "running",
            };
            update["status"] = state.into();
            update["taskId"] = task.task_id.clone().into();
            if let Some(code) = task.error_code.as_ref() {
                update["error"] = task
                    .metadata
                    .get("errorMessage")
                    .cloned()
                    .unwrap_or_else(|| json!(code));
            }
            let retry = task.metadata.get("gpuRetry").cloned().or_else(|| {
                task.checkpoint
                    .as_deref()
                    .and_then(|p| p.get("gpuRetry").cloned())
            });
            let effective = retry.as_ref().unwrap_or(&Value::Null);
            update["effective"] = json!({"width":effective.get("width").or_else(||task.input.get("width")),
                "height":effective.get("height").or_else(||task.input.get("height")),"frames":task.input.get("frames"),"fps":task.input.get("fps")});
            if let Some(value) = retry {
                update["gpuRetry"] = value;
            }
            if let Some(v) = task
                .metadata
                .get("nativeRuntime")
                .or_else(|| task.checkpoint.as_deref().and_then(|p| p.get("telemetry")))
            {
                update["telemetry"] = v.clone();
            }
        } else if run["cancelRequested"] == true {
            self.cancel(storage.clone(), principal.into(), key).await?;
            update["status"] = "cancelled".into();
        } else {
            match self.submit_studio_clip(storage, principal, run, &key).await {
                Ok(v) if v.is_null() => return Ok(()),
                Ok(v) => update["taskId"] = v["taskId"].clone(),
                Err(e) if retry_admission(&e) => return Ok(()),
                Err(e) => {
                    update["status"] = "failed".into();
                    update["error"] = json!(e.message);
                }
            }
        }
        if [
            "status",
            "taskId",
            "effective",
            "gpuRetry",
            "telemetry",
            "error",
        ]
        .iter()
        .any(|k| update.get(*k).is_some_and(|v| v != &run[*k]))
        {
            storage.request(update, principal).await?;
        }
        Ok(())
    }

    async fn submit_studio_clip(
        self: &Arc<Self>,
        storage: &Storage,
        principal: &str,
        run: &Value,
        key: &str,
    ) -> Result<Value> {
        let mut input = run["input"].clone();
        input["image"] = self
            .video
            .studio_frame(storage.clone(), principal, &run["firstRef"])
            .await?
            .into();
        if !run["lastRef"].is_null() {
            input["lastFrame"] = self
                .video
                .studio_frame(storage.clone(), principal, &run["lastRef"])
                .await?
                .into();
        }
        if !run["audioRef"].is_null() {
            let (audio, frames) = self
                .video
                .studio_audio(storage.clone(), principal, &run["audioRef"])
                .await?;
            input["drivingAudio"] = audio.into();
            input["audioFrames"] = frames.into();
            input["duration"] = [2_u64, 3, 5, 10, 15]
                .into_iter()
                .find(|s| s * 25 >= frames)
                .ok_or_else(|| ApiError::invalid("对白超过 15 秒"))?
                .into();
        }
        let latest = storage
            .request(
                json!({"kind":"studio.videoRun", "id":run["id"], "projectId":run["projectId"]}),
                principal,
            )
            .await?;
        if latest["cancelRequested"] == true {
            return Ok(Value::Null);
        }
        let dependencies: Vec<_> = run["preparation"]["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|child| child["taskId"].as_str())
            .collect();
        let context = json!({"studioRunId":run["id"], "dependsOnTaskIds":dependencies,
            "projectId":run["projectId"], "shotId":run["shotId"], "templateId":run["templateId"], "templateVersion":run["templateVersion"]});
        let request = json!({"kind":"video", "requestKey":key, "input":input,"context":context});
        self.submit(storage.clone(), principal.into(), request)
            .await
    }
}
