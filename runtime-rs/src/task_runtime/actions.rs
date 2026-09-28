use super::*;

impl TaskRuntime {
    pub async fn action(
        self: &Arc<Self>,
        storage: Storage,
        principal: String,
        id: String,
        action: String,
    ) -> Result<Value> {
        self.check_running()?;
        if !["concat", "continue"].contains(&action.as_str()) {
            return Err(ApiError::invalid("Unsupported task action"));
        }
        let task = Self::get(&storage, &principal, &id).await?;
        if task.kind != TaskKind::Batch
            || task.provider_fingerprint != self.binding(&storage)
            || task.cancel_requested_at.is_some()
        {
            return Err(ApiError::new(
                409,
                "TASK_ACTION_INVALID",
                "Task action unavailable",
            ));
        }
        self.video()?;
        let operation = self
            .jobs
            .lock()
            .unwrap()
            .entry(identity(&storage, &id))
            .or_insert_with(|| JobBinding::new(String::new()))
            .operation
            .clone();
        let mut guard = operation.try_lock_owned().map_err(|_| {
            ApiError::new(409, "TASK_ACTION_BUSY", "Another task operation is running")
        })?;
        let (reply, received) = tokio::sync::oneshot::channel();
        let runtime = self.clone();
        self.tracker.spawn(async move {
            let work = async {
                runtime.check_running()?;
                let task = Self::get(&storage, &principal, &id).await?;
                if task.cancel_requested_at.is_some() {
                    return Err(ApiError::new(
                        409,
                        "TASK_ACTION_INVALID",
                        "Task was cancelled",
                    ));
                }
                let job = task
                    .checkpoint
                    .as_ref()
                    .and_then(|checkpoint| checkpoint["gatewayJobId"].as_str())
                    .or_else(|| task.metadata.get("gatewayJobId").and_then(Value::as_str));
                let exists = if let Some(job) = job {
                    runtime.video()?.get_batch(job, &principal).await.is_ok()
                } else {
                    false
                };
                if !exists || action == "continue" {
                    runtime
                        .recover_provider(&storage, &principal, &task, &mut guard)
                        .await?;
                }
                let task = Self::get(&storage, &principal, &id).await?;
                let job = task
                    .checkpoint
                    .as_ref()
                    .and_then(|checkpoint| checkpoint["gatewayJobId"].as_str())
                    .ok_or_else(|| {
                        ApiError::new(409, "TASK_ACTION_INVALID", "Batch identity unavailable")
                    })?;
                runtime
                    .video()?
                    .clone()
                    .batch_action(job, &principal, &action, runtime.shutdown.child_token())
                    .await?;
                if action == "continue" {
                    patch(
                        &storage,
                        &principal,
                        &id,
                        TaskPatch {
                            status: Some(TaskStatus::Running),
                            recovery_state: Some(TaskRecoveryState::Normal),
                            error_code: Some(None),
                            ..Default::default()
                        },
                    )
                    .await?;
                }
                Ok::<Value, ApiError>(serde_json::to_value(
                    Self::get(&storage, &principal, &id).await?,
                )?)
            }
            .await;
            drop(guard);
            if work.is_ok() && action == "continue" {
                runtime.monitor(storage, principal, id);
            }
            let _ = reply.send(work);
        });
        received.await.map_err(|_| {
            ApiError::new(
                503,
                "TASK_ACTION_UNKNOWN",
                "Task action result unknown; query the original task",
            )
        })?
    }
}
