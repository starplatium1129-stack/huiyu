use super::*;

pub(super) struct Submission {
    pub kind: TaskKind,
    pub key: String,
    pub fingerprint: String,
    pub context: Value,
    pub retry_of: Option<String>,
}

impl TaskRuntime {
    pub async fn submit(
        self: &Arc<Self>,
        storage: Storage,
        principal: String,
        mut request: Value,
    ) -> Result<Value> {
        self.check_running()?;
        let key = request["requestKey"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .ok_or_else(|| ApiError::invalid("Invalid task request key"))?
            .to_owned();
        let kind: TaskKind = serde_json::from_value(request["kind"].clone()).map_err(|_| {
            ApiError::new(
                501,
                "TASK_PROVIDER_NOT_MIGRATED",
                "This task provider has not been migrated",
            )
        })?;
        if !request["input"].is_object() {
            return Err(ApiError::invalid("Task input must be an object"));
        }
        let mut frozen = json!({"kind":request["kind"],"input":null});
        frozen["input"] = request["input"].take();
        if let Some(context) = request.get_mut("context") {
            frozen["context"] = context.take();
        }
        let existing = storage
            .task(
                TaskCommand::Get {
                    task_id: None,
                    request_key: Some(key.clone()),
                    summary: false,
                },
                &principal,
            )
            .await?;
        let existing: Option<TaskRecord> = serde_json::from_value(existing)?;
        let codec = existing
            .as_ref()
            .and_then(|task| task.request_fingerprint_locale.as_deref())
            .map(Fingerprint::new)
            .transpose()?;
        let fingerprint = codec.as_ref().unwrap_or(&self.fingerprint).hash(&frozen);
        if let Some(existing) = existing {
            if existing.request_fingerprint != fingerprint {
                return Err(ApiError::new(
                    409,
                    "TASK_KEY_CONFLICT",
                    "Request key already belongs to different input",
                ));
            }
            return Ok(existing.into_value()?);
        }
        let prepared = self.prepare(kind, frozen["input"].take()).await?;
        self.accept_prepared(
            storage,
            principal,
            prepared,
            Submission {
                kind,
                key,
                fingerprint,
                context: frozen
                    .get_mut("context")
                    .map(Value::take)
                    .unwrap_or(json!({})),
                retry_of: None,
            },
        )
        .await
    }

    pub(super) async fn accept_prepared(
        self: &Arc<Self>,
        storage: Storage,
        principal: String,
        prepared: Preparation,
        submission: Submission,
    ) -> Result<Value> {
        self.check_running()?;
        let Submission {
            kind,
            key,
            fingerprint,
            context,
            retry_of,
        } = submission;
        let task_id = uuid::Uuid::new_v4().to_string();
        let now = now();
        let mut record = TaskRecord {
            task_id,
            workspace_id: storage.workspace_id().into(),
            principal_id: principal.clone(),
            request_key: key,
            request_fingerprint: fingerprint,
            request_fingerprint_locale: Some(self.fingerprint.locale.clone()),
            kind,
            provider: prepared.provider().into(),
            provider_fingerprint: self.binding_for(kind),
            upstream_id: None,
            status: TaskStatus::Queued,
            recovery_state: TaskRecoveryState::Normal,
            revision: 0,
            runtime_epoch: storage.runtime_epoch().into(),
            created_at: now,
            updated_at: now,
            submission_intent_at: None,
            submission_observed_at: None,
            cancel_requested_at: None,
            upstream_settled: false,
            execution_deadline: now + 3 * 60 * 60 * 1000,
            input: prepared
                .input()
                .as_object()
                .cloned()
                .ok_or_else(|| ApiError::invalid("Invalid prepared task input"))?,
            input_media_refs: vec![],
            result_state: ResultState::None,
            result_refs: vec![],
            delivery_state: DeliveryState::Unseen,
            error_code: None,
            metadata: serde_json::Map::from_iter([("context".into(), context)]),
            checkpoint: None,
            parent_batch_id: None,
            step_index: None,
        };
        if let Some(source) = &retry_of {
            record
                .metadata
                .insert("retryOfTaskId".into(), json!(source));
        }
        let (reply, received) = tokio::sync::oneshot::channel();
        let runtime = self.clone();
        // After transfer, a lost HTTP response cannot orphan an accepted job.
        // The runtime owns acceptance and dispatch; callers query the stable key.
        self.tracker.spawn(async move {
            let accepted = async {
                runtime.check_running()?;
                let mut result = storage
                    .task(
                        TaskCommand::Accept {
                            record: Box::new(record),
                            retry_of,
                        },
                        &principal,
                    )
                    .await?;
                let task: TaskRecord = serde_json::from_value(result["task"].take())?;
                if result["created"] == true {
                    let id = task.task_id.clone();
                    runtime.jobs.lock().unwrap().insert(
                        identity(&storage, &id),
                        JobBinding {
                            dispatching: true,
                            ..JobBinding::new(String::new())
                        },
                    );
                    let dispatcher = runtime.clone();
                    let storage = storage.clone();
                    let principal = principal.clone();
                    runtime.tracker.spawn(async move {
                        dispatcher.dispatch(storage, principal, id, prepared).await;
                    });
                }
                Ok(task.into_value()?)
            }
            .await;
            let _ = reply.send(accepted);
        });
        received.await.map_err(|_| {
            ApiError::new(
                503,
                "TASK_ACCEPT_UNKNOWN",
                "Query the original request key before retrying",
            )
        })?
    }
}
