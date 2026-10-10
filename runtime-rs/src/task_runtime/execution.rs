use super::*;
use crate::execution::Output;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum ReconcileMode {
    Startup,
    Explicit,
    Follow,
}

impl TaskRuntime {
    pub(super) async fn dispatch(
        self: Arc<Self>,
        storage: Storage,
        principal: String,
        id: String,
        prepared: Preparation,
    ) {
        let execution = async {
            let current = Self::get(&storage, &principal, &id).await?;
            if current.cancel_requested_at.is_some()
                || current.submission_intent_at.is_some()
                || current.upstream_settled
            {
                return Ok(false);
            }
            self.check_running()?;
            let hooks = Arc::new(hooks::Hooks {
                runtime: Arc::downgrade(&self),
                storage: storage.clone(),
                principal: principal.clone(),
                id: id.clone(),
            });
            let job = match prepared {
                Preparation::Generation(prepared) => {
                    self.provider
                        .clone()
                        .submit(prepared, principal.clone(), Some(hooks))
                        .await?
                }
                Preparation::Image(prepared) => {
                    self.images
                        .as_ref()
                        .ok_or_else(|| {
                            ApiError::new(
                                501,
                                "TASK_PROVIDER_NOT_MIGRATED",
                                "Image task provider unavailable",
                            )
                        })?
                        .clone()
                        .submit(prepared, principal.clone(), Some(hooks))
                        .await?
                }
                Preparation::Video(prepared) => {
                    self.video()?
                        .clone()
                        .submit(prepared, principal.clone(), Some(hooks))
                        .await?
                }
                Preparation::Batch(prepared) => {
                    self.video()?
                        .clone()
                        .submit_batch(prepared, principal.clone(), Some(hooks))
                        .await?
                }
            };
            let job_id = text(&job, "id")?.to_owned();
            self.register_job(&storage, &id, job_id);
            Ok::<bool, ApiError>(true)
        }
        .await;
        if execution.is_err()
            && let Ok(current) = Self::get(&storage, &principal, &id).await
            && !current.upstream_settled
        {
            let change = if current.submission_intent_at.is_some() {
                TaskPatch {
                    recovery_state: Some(TaskRecoveryState::Unknown),
                    error_code: Some(Some("SUBMISSION_UNCONFIRMED".into())),
                    ..Default::default()
                }
            } else if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() {
                TaskPatch {
                    recovery_state: Some(TaskRecoveryState::Interrupted),
                    error_code: Some(Some("TASK_AWAITING_RESUME".into())),
                    ..Default::default()
                }
            } else {
                TaskPatch {
                    status: Some(TaskStatus::Failed),
                    upstream_settled: Some(true),
                    error_code: Some(Some("TASK_VALIDATION_FAILED".into())),
                    ..Default::default()
                }
            };
            let _ = patch(&storage, &principal, &id, change).await;
        }
        if let Ok(current) = Self::get(&storage, &principal, &id).await
            && current.upstream_settled
        {
            self.jobs.lock().unwrap().remove(&identity(&storage, &id));
        }
        let requested = {
            let mut jobs = self.jobs.lock().unwrap();
            jobs.get_mut(&identity(&storage, &id)).is_some_and(|job| {
                job.dispatching = false;
                job.watch_requested || matches!(execution, Ok(true))
            })
        };
        if requested {
            self.monitor(storage, principal, id);
        }
    }
    pub async fn reconcile(
        self: &Arc<Self>,
        storage: &Storage,
        principal: &str,
        id: &str,
    ) -> Result<Value> {
        Ok(serde_json::to_value(
            self.reconcile_inner(storage, principal, id, ReconcileMode::Explicit)
                .await?,
        )?)
    }
    pub(super) async fn reconcile_inner(
        self: &Arc<Self>,
        storage: &Storage,
        principal: &str,
        id: &str,
        mode: ReconcileMode,
    ) -> Result<TaskRecord> {
        self.check_running()?;
        let observe_after = mode != ReconcileMode::Follow;
        // A rejected task identity must not allocate a persistent operation
        // binding, or wait on another principal's in-flight task operation.
        Self::get(storage, principal, id).await?;
        let operation = self
            .jobs
            .lock()
            .unwrap()
            .entry(identity(storage, id))
            .or_insert_with(|| JobBinding::new(String::new()))
            .operation
            .clone();
        let mut cancellation = if mode == ReconcileMode::Explicit {
            match operation.try_lock_owned() {
                Ok(guard) => guard,
                Err(_) => return Self::get(storage, principal, id).await,
            }
        } else {
            tokio::select! {
                _ = self.shutdown.cancelled() => return Err(ApiError::new(503, "TASK_RUNTIME_CLOSED", "Task runtime unavailable")),
                guard = operation.lock_owned() => guard,
            }
        };
        let current = Self::get(storage, principal, id).await?;
        // Input protection and initial submit belong to the actual dispatcher.
        // A read cannot relinquish that ownership or start a second dispatcher.
        if self
            .jobs
            .lock()
            .unwrap()
            .get(&identity(storage, id))
            .is_some_and(|job| job.dispatching)
        {
            return Ok(current);
        }
        if current.upstream_settled
            && (current.status != TaskStatus::Succeeded
                || current.result_state == ResultState::Available
                || current.delivery_state == DeliveryState::Discarded)
        {
            // Explicit discard is terminal, not an invitation to fetch the output again.
            self.jobs.lock().unwrap().remove(&identity(storage, id));
            let known = current.recovery_state == TaskRecoveryState::Normal;
            return clear_collection_diagnostic(storage, principal, id, current, known).await;
        }
        if current.provider_fingerprint != self.binding_for(current.kind) {
            self.jobs.lock().unwrap().remove(&identity(storage, id));
            return patch(
                storage,
                principal,
                id,
                TaskPatch {
                    recovery_state: Some(TaskRecoveryState::Unknown),
                    error_code: Some(Some("PROVIDER_IDENTITY_CHANGED".into())),
                    ..Default::default()
                },
            )
            .await;
        }
        // Startup must publish a durable transition even if an explicit probe
        // attached ownership while we waited: a list may already show Unknown
        // at the old revision. Ordinary observer polls do not rewrite this state.
        if mode == ReconcileMode::Startup
            && !current.upstream_settled
            && current.recovery_state == TaskRecoveryState::Normal
        {
            patch(
                storage,
                principal,
                id,
                TaskPatch {
                    recovery_state: Some(TaskRecoveryState::Reconciling),
                    ..Default::default()
                },
            )
            .await?;
        }
        let job = self.job(storage, id).filter(|job| !job.is_empty());
        let mut recovered_single = job.is_none() && current.kind != TaskKind::Batch;
        let mut observed = if let Some(job) = &job {
            self.query_provider(current.kind, job, principal).await
        } else {
            self.recover_provider(storage, principal, &current, &mut cancellation)
                .await
        };
        if job.is_some()
            && current.provider != "webui"
            && observed.as_ref().map_or(true, |o| o.unknown)
        {
            recovered_single = current.kind != TaskKind::Batch;
            observed = self
                .recover_provider(storage, principal, &current, &mut cancellation)
                .await;
        }
        let mut observation = match observed {
            Ok(observation) => observation,
            Err(_) => {
                return patch(
                    storage,
                    principal,
                    id,
                    TaskPatch {
                        recovery_state: Some(TaskRecoveryState::Unknown),
                        error_code: Some(Some("TASK_RECONCILE_REQUIRED".into())),
                        ..Default::default()
                    },
                )
                .await;
            }
        };
        if current.cancel_requested_at.is_some()
            && !observation.settled
            && let Some(job) = job
        {
            let _ = self.cancel_provider(current.kind, &job, principal).await;
        }
        let has_outputs = !observation.outputs.is_empty();
        let mut recovered_files = Vec::new();
        // A provider query can retry a failed collection hook and commit the
        // result. Consult durable state again before rereading its output.
        if has_outputs
            && observation.settled
            && !observation.unknown
            && observation.status == "succeeded"
            && Self::get(storage, principal, id).await?.result_state != ResultState::Available
        {
            // Only this single-task recovery owns these downloads. Live jobs
            // retain their outputs, and batch shots still need theirs for
            // tail-frame extraction and stitching.
            if recovered_single
                && observation.settled
                && !observation.unknown
                && observation.status == "succeeded"
            {
                recovered_files = observation
                    .outputs
                    .iter()
                    .filter_map(|output| match output {
                        Output::File { path, .. } => Some(path.clone()),
                        Output::Bytes { .. } => None,
                    })
                    .collect();
            }
            hooks::collect(storage, principal, id, observation.outputs).await?;
        }
        let latest = Self::get(storage, principal, id).await?;
        if latest.result_state == ResultState::Available {
            // Commit and read-back must both succeed before releasing the
            // exact source paths. Cleanup failure cannot undo durable success.
            for path in recovered_files {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
        if latest.upstream_settled
            && (latest.status != TaskStatus::Succeeded
                || latest.result_state == ResultState::Available)
        {
            self.jobs.lock().unwrap().remove(&identity(storage, id));
            let known =
                observation.settled && !observation.unknown && observation.status == "succeeded";
            return clear_collection_diagnostic(storage, principal, id, latest, known).await;
        }
        if observation.settled
            && !observation.unknown
            && observation.status == "succeeded"
            && latest.result_state == ResultState::Available
            && latest.cancel_requested_at.is_none()
        {
            observation.metadata["resultCollectionError"] = Value::Null;
            observation.error_code = None;
        }
        let observed_status: TaskStatus = serde_json::from_value(json!(observation.status))?;
        let status = if latest.cancel_requested_at.is_some() && observation.settled {
            TaskStatus::Cancelled
        } else {
            observed_status
        };
        let update = TaskPatch {
            status: Some(status),
            upstream_settled: Some(observation.settled),
            recovery_state: Some(if observation.unknown {
                TaskRecoveryState::Unknown
            } else {
                TaskRecoveryState::Normal
            }),
            error_code: Some(observation.error_code),
            metadata: Some(serde_json::from_value(observation.metadata)?),
            result_state: (observed_status == TaskStatus::Succeeded
                && !has_outputs
                && latest.result_state != ResultState::Available)
                .then_some(ResultState::Unavailable),
            ..Default::default()
        };
        // Reuse the post-observation read for the first CAS. A concurrent write
        // still fails that CAS and refreshes the revision before retrying.
        let watch = !observation.settled
            && observe_after
            && !observation.unknown
            && latest.submission_intent_at.is_some();
        // Startup lists are already visible: claim observation before publishing
        // Normal. follow waits on this guard and cannot overtake the patch.
        if watch
            && mode == ReconcileMode::Startup
            && !self.monitor(storage.clone(), principal.into(), id.into())
        {
            return Err(ApiError::new(
                503,
                "TASK_RUNTIME_CLOSED",
                "Task runtime is draining",
            ));
        }
        let task = patch_at(storage, principal, id, latest.revision, update).await?;
        if observation.settled {
            self.jobs.lock().unwrap().remove(&identity(storage, id));
        } else if watch && mode == ReconcileMode::Explicit {
            self.monitor(storage.clone(), principal.into(), id.into());
        }
        Ok(task)
    }
}

async fn clear_collection_diagnostic(
    storage: &Storage,
    principal: &str,
    id: &str,
    task: TaskRecord,
    known: bool,
) -> Result<TaskRecord> {
    if known
        && task.status == TaskStatus::Succeeded
        && task.result_state == ResultState::Available
        && task.cancel_requested_at.is_none()
        && (task
            .metadata
            .get("resultCollectionError")
            .is_some_and(|value| !value.is_null())
            || task.error_code.as_deref() == Some("RESULT_COLLECTION_PENDING"))
    {
        return patch(
            storage,
            principal,
            id,
            TaskPatch {
                metadata: Some(serde_json::from_value(
                    json!({"resultCollectionError":null}),
                )?),
                error_code: (task.error_code.as_deref() == Some("RESULT_COLLECTION_PENDING"))
                    .then_some(None),
                ..Default::default()
            },
        )
        .await;
    }
    Ok(task)
}
