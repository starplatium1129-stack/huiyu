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
        if task["submissionIntentAt"].is_number()
            || task["cancelRequestedAt"].is_number()
            || task["status"] != "queued"
            || task["upstreamSettled"] == true
            || task["providerFingerprint"] != self.binding(&storage)
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
                return Ok(task);
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
            let preparation = match task["kind"].as_str() {
                Some("generation") => runtime
                    .provider
                    .resume_prepared(
                        task["input"].clone(),
                        task["provider"].as_str().unwrap_or(""),
                        runtime.shutdown.child_token(),
                    )
                    .await
                    .map(Preparation::Generation),
                Some("anima" | "creative") => match &runtime.images {
                    Some(images) => images
                        .resume_prepared(
                            task["input"].clone(),
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
                Some("video") => match runtime.video() {
                    Ok(video) => video
                        .resume_prepared(
                            task["input"].clone(),
                            &hooks,
                            runtime.shutdown.child_token(),
                        )
                        .await
                        .map(Preparation::Video),
                    Err(error) => Err(error),
                },
                Some("batch") => match runtime.video() {
                    Ok(video) => video
                        .prepare_batch_resumed(
                            task["input"].clone(),
                            &hooks,
                            runtime.shutdown.child_token(),
                        )
                        .await
                        .map(Preparation::Batch),
                    Err(error) => Err(error),
                },
                _ => Err(ApiError::new(
                    501,
                    "TASK_RESUME_UNAVAILABLE",
                    "该任务类型尚未支持排队恢复",
                )),
            };
            match preparation {
                Ok(prepared) => {
                    let _ = reply.send(Ok(task));
                    runtime.dispatch(storage, principal, id, prepared).await;
                }
                Err(error) => {
                    let _ = patch(
                        &storage,
                        &principal,
                        &id,
                        json!({"recoveryState":"interrupted","errorCode":error.code}),
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
