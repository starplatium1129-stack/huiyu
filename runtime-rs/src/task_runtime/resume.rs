use super::*;

impl TaskRuntime {
    pub async fn resume(
        self: &Arc<Self>,
        storage: Storage,
        principal: String,
        id: String,
    ) -> Result<Value> {
        self.check_running()?;
        let task = Self::get(&storage, &principal, &id).await?;
        if task.submission_intent_at.is_some()
            || task.cancel_requested_at.is_some()
            || task.status != TaskStatus::Queued
            || task.upstream_settled
            || task.provider_fingerprint != self.binding()
        {
            return Err(ApiError::new(
                409,
                "TASK_RESUME_UNSAFE",
                "仅同一提供方中从未提交且未取消的排队任务可以恢复",
            ));
        }
        {
            let mut jobs = self.jobs.lock().unwrap();
            let binding = jobs
                .entry(identity(&storage, &id))
                .or_insert_with(|| JobBinding::new(String::new()));
            if binding.dispatching || binding.watching {
                return Ok(serde_json::to_value(task)?);
            }
            binding.dispatching = true;
        }
        let (reply, received) = tokio::sync::oneshot::channel();
        let runtime = self.clone();
        self.tracker.spawn(async move {
            let hooks = hooks::Hooks {
                runtime: Arc::downgrade(&runtime),
                storage: storage.clone(),
                principal: principal.clone(),
                id: id.clone(),
            };
            let preparation = match task.kind {
                TaskKind::Generation => runtime
                    .provider
                    .resume_prepared(
                        Value::Object(task.input.clone()),
                        &task.provider,
                        runtime.shutdown.child_token(),
                    )
                    .await
                    .map(Preparation::Generation),
                TaskKind::Anima | TaskKind::Creative => match &runtime.images {
                    Some(images) => images
                        .resume_prepared(
                            Value::Object(task.input.clone()),
                            &hooks,
                            runtime.shutdown.child_token(),
                        )
                        .await
                        .map(Preparation::Image),
                    None => Err(ApiError::new(
                        501,
                        "TASK_PROVIDER_NOT_MIGRATED",
                        "图片任务提供方不可用",
                    )),
                },
                TaskKind::Video => match runtime.video() {
                    Ok(video) => video
                        .resume_prepared(
                            Value::Object(task.input.clone()),
                            &hooks,
                            runtime.shutdown.child_token(),
                        )
                        .await
                        .map(Preparation::Video),
                    Err(error) => Err(error),
                },
                TaskKind::Batch => match runtime.video() {
                    Ok(video) => video
                        .prepare_batch_resumed(
                            Value::Object(task.input.clone()),
                            &hooks,
                            runtime.shutdown.child_token(),
                        )
                        .await
                        .map(Preparation::Batch),
                    Err(error) => Err(error),
                },
            };
            match preparation {
                Ok(prepared) => {
                    let _ = reply.send(serde_json::to_value(task).map_err(ApiError::from));
                    runtime.dispatch(storage, principal, id, prepared).await;
                }
                Err(error) => {
                    let _ = patch(
                        &storage,
                        &principal,
                        &id,
                        TaskPatch {
                            recovery_state: Some(TaskRecoveryState::Interrupted),
                            error_code: Some(Some(error.code.clone())),
                            ..Default::default()
                        },
                    )
                    .await;
                    runtime
                        .jobs
                        .lock()
                        .unwrap()
                        .remove(&identity(&storage, &id));
                    let _ = reply.send(Err(error));
                }
            }
        });
        received
            .await
            .map_err(|_| ApiError::new(503, "TASK_ACCEPT_UNKNOWN", "恢复结果未知，请查询原任务"))?
    }
}
