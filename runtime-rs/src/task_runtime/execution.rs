use super::*;

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
            if current["cancelRequestedAt"].is_number()
                || current["submissionIntentAt"].is_number()
                || current["upstreamSettled"] == true
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
            && current["upstreamSettled"] != true
        {
            let change = if current["submissionIntentAt"].is_number() {
                json!({"recoveryState":"unknown","errorCode":"SUBMISSION_UNCONFIRMED"})
            } else if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() {
                json!({"recoveryState":"interrupted","errorCode":"TASK_AWAITING_RESUME"})
            } else {
                json!({"status":"failed","upstreamSettled":true,"errorCode":"TASK_VALIDATION_FAILED"})
            };
            let _ = patch(&storage, &principal, &id, change).await;
        }
        if let Ok(current) = Self::get(&storage, &principal, &id).await
            && current["upstreamSettled"] == true
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
        self.reconcile_inner(storage, principal, id, true).await
    }
    pub(super) async fn reconcile_inner(
        self: &Arc<Self>,
        storage: &Storage,
        principal: &str,
        id: &str,
        observe_after: bool,
    ) -> Result<Value> {
        self.check_running()?;
        let operation = self
            .jobs
            .lock()
            .unwrap()
            .entry(identity(storage, id))
            .or_insert_with(|| JobBinding::new(String::new()))
            .operation
            .clone();
        let mut cancellation = operation.lock_owned().await;
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
        if current["upstreamSettled"] == true
            && (current["status"] != "succeeded" || current["resultState"] == "available")
        {
            self.jobs.lock().unwrap().remove(&identity(storage, id));
            return Ok(current);
        }
        if current["providerFingerprint"] != self.binding(storage) {
            self.jobs.lock().unwrap().remove(&identity(storage, id));
            return patch(
                storage,
                principal,
                id,
                json!({"recoveryState":"unknown","errorCode":"PROVIDER_IDENTITY_CHANGED"}),
            )
            .await;
        }
        let job = self.job(storage, id).filter(|job| !job.is_empty());
        let mut observed = if let Some(job) = &job {
            self.query_provider(text(&current, "kind")?, job, principal)
                .await
        } else {
            self.recover_provider(storage, principal, &current, &mut cancellation)
                .await
        };
        if job.is_some()
            && current["provider"] != "webui"
            && observed.as_ref().map_or(true, |o| o.unknown)
        {
            observed = self
                .recover_provider(storage, principal, &current, &mut cancellation)
                .await;
        }
        let observation = match observed {
            Ok(observation) => observation,
            Err(_) => {
                return patch(
                    storage,
                    principal,
                    id,
                    json!({"recoveryState":"unknown","errorCode":"TASK_RECONCILE_REQUIRED"}),
                )
                .await;
            }
        };
        if current["cancelRequestedAt"].is_number()
            && !observation.settled
            && let Some(job) = job
        {
            let _ = self
                .cancel_provider(text(&current, "kind")?, &job, principal)
                .await;
        }
        let has_outputs = !observation.outputs.is_empty();
        if has_outputs && current["resultState"] != "available" {
            hooks::collect(storage, principal, id, observation.outputs).await?;
        }
        let latest = Self::get(storage, principal, id).await?;
        if latest["upstreamSettled"] == true
            && (latest["status"] != "succeeded" || latest["resultState"] == "available")
        {
            self.jobs.lock().unwrap().remove(&identity(storage, id));
            return Ok(latest);
        }
        let status = if latest["cancelRequestedAt"].is_number() && observation.settled {
            "cancelled"
        } else {
            &observation.status
        };
        let mut update = json!({"status":status,"upstreamSettled":observation.settled,
            "recoveryState":if observation.unknown {"unknown"} else {"normal"},"errorCode":observation.error_code,
            "metadata":observation.metadata});
        if observation.status == "succeeded" && !has_outputs && latest["resultState"] != "available"
        {
            update["resultState"] = json!("unavailable");
        }
        let task = patch(storage, principal, id, update).await?;
        if observation.settled {
            self.jobs.lock().unwrap().remove(&identity(storage, id));
        } else if observe_after && !observation.unknown && task["submissionIntentAt"].is_number() {
            self.monitor(storage.clone(), principal.into(), id.into());
        }
        Ok(task)
    }
}
