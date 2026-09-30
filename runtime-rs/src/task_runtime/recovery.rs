use super::*;
use futures_util::{StreamExt, TryStreamExt, stream};
use std::{collections::HashSet, time::Duration};

const RECOVERY_PARALLELISM: usize = 2;
const RECOVERY_TIMEOUT: Duration = Duration::from_secs(60);
const RECOVERY_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

impl TaskRuntime {
    pub async fn ensure_recovered(
        self: &Arc<Self>,
        storage: &Storage,
        principal: &str,
    ) -> Result<()> {
        self.check_running()?;
        let key = format!("{}:{principal}", storage.runtime_epoch());
        let once = self
            .recoveries
            .lock()
            .unwrap()
            .entry(key)
            .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new()))
            .clone();
        let initialize = once.get_or_try_init(|| async {
            let unfinished = Arc::new(Mutex::new(HashSet::new()));
            let scan = async {
                let mut query = crate::task_contract::TaskListQuery {
                    recoverable: true,
                    ..Default::default()
                };
                loop {
                    let mut list = storage
                        .task(
                            TaskCommand::List {
                                query: query.clone(),
                            },
                            principal,
                        )
                        .await?;
                    let tasks = list
                        .get_mut("items")
                        .and_then(Value::as_array_mut)
                        .map(std::mem::take)
                        .ok_or_else(|| ApiError::invalid("Invalid task list"))?;
                    // Independent task probes may overlap; each reconciliation
                    // still owns its task operation lock and never resubmits.
                    let unfinished = unfinished.clone();
                    stream::iter(tasks.into_iter().map(move |task| {
                        let unfinished = unfinished.clone();
                        async move {
                            let task: TaskRecord = serde_json::from_value(task)?;
                            unfinished.lock().unwrap().insert(task.task_id.clone());
                            let result = self.recover_one(storage, principal, &task.task_id).await;
                            if result.is_ok() {
                                unfinished.lock().unwrap().remove(&task.task_id);
                            }
                            result
                        }
                    }))
                    .buffer_unordered(RECOVERY_PARALLELISM)
                    .try_for_each(|()| std::future::ready(Ok(())))
                    .await?;
                    query.through_revision = list["throughRevision"].as_i64();
                    query.before = list["nextCursor"].as_i64();
                    if query.before.is_none() {
                        break;
                    }
                }
                Ok::<(), ApiError>(())
            };
            // Bound the complete scan, including storage waits and all pages.
            // Err leaves OnceCell empty so a later request can retry observation.
            let result = tokio::select! {
                biased;
                _ = self.shutdown.cancelled() => Err(recovery_closed()),
                result = tokio::time::timeout(RECOVERY_TIMEOUT, scan) =>
                    result.unwrap_or_else(|_| Err(recovery_timeout())),
            };
            if result
                .as_ref()
                .is_err_and(|error| error.code == "TASK_RECOVERY_TIMEOUT")
            {
                let unfinished = unfinished
                    .lock()
                    .unwrap()
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>();
                let cleanup = async {
                    for id in unfinished {
                        let _ = self.recovery_unknown(storage, principal, &id).await;
                    }
                };
                tokio::select! {
                    biased;
                    _ = self.shutdown.cancelled() => return Err(recovery_closed()),
                    _ = tokio::time::timeout(RECOVERY_CLEANUP_TIMEOUT, cleanup) => {},
                }
            }
            result
        });
        // A second HTTP request shares initialization but also has its own
        // finite wait; it cannot wait through repeated failed initialization.
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => return Err(recovery_closed()),
            result = tokio::time::timeout(RECOVERY_TIMEOUT + RECOVERY_CLEANUP_TIMEOUT, initialize) => {
                result.map_err(|_| recovery_timeout())??;
            }
        }
        Ok(())
    }
    async fn recover_one(
        self: &Arc<Self>,
        storage: &Storage,
        principal: &str,
        id: &str,
    ) -> Result<()> {
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => Err(recovery_closed()),
            result = tokio::time::timeout(RECOVERY_TIMEOUT, self.reconcile_inner(storage, principal, id, true)) => {
                match result {
                    Ok(result) => result.map(|_| ()),
                    Err(_) => {
                        // A probe timeout is an unknown observation, never a
                        // cancellation, successful result or permission to replay.
                        Err(recovery_timeout())
                    }
                }
            }
        }
    }
    async fn recovery_unknown(&self, storage: &Storage, principal: &str, id: &str) -> Result<()> {
        let operation = self
            .jobs
            .lock()
            .unwrap()
            .entry(identity(storage, id))
            .or_insert_with(|| JobBinding::new(String::new()))
            .operation
            .clone();
        // The cancelled query releases its own lock. If another operation took
        // over, it owns the observation; do not overwrite it or extend the wait.
        let Ok(_guard) = operation.try_lock_owned() else {
            return Ok(());
        };
        let current = Self::get(storage, principal, id).await?;
        if self
            .jobs
            .lock()
            .unwrap()
            .get(&identity(storage, id))
            .is_some_and(|job| job.dispatching)
        {
            return Ok(());
        }
        if current.upstream_settled
            && (current.status != TaskStatus::Succeeded
                || current.result_state == ResultState::Available)
        {
            return Ok(());
        }
        patch(
            storage,
            principal,
            id,
            TaskPatch {
                recovery_state: Some(TaskRecoveryState::Unknown),
                error_code: Some(Some("TASK_RECOVERY_TIMEOUT".into())),
                ..Default::default()
            },
        )
        .await
        .map(|_| ())
    }
    pub(super) fn monitor(self: &Arc<Self>, storage: Storage, principal: String, id: String) {
        if self.check_running().is_err() {
            return;
        }
        {
            let mut jobs = self.jobs.lock().unwrap();
            let binding = jobs
                .entry(identity(&storage, &id))
                .or_insert_with(|| JobBinding::new(String::new()));
            if binding.dispatching || binding.watching {
                binding.watch_requested = true;
                return;
            }
            binding.watching = true;
            binding.watch_requested = false;
        }
        let runtime = self.clone();
        self.tracker.spawn(async move {
            runtime.follow(&storage, &principal, &id).await;
        });
    }
    async fn follow(self: &Arc<Self>, storage: &Storage, principal: &str, id: &str) {
        loop {
            let observed = self.reconcile_inner(storage, principal, id, false).await;
            let settled = observed.as_ref().is_ok_and(|task| task.upstream_settled);
            let stop = observed.as_ref().map_or(true, |task| {
                settled || task.recovery_state == TaskRecoveryState::Unknown
            });
            if stop {
                let again = {
                    let mut jobs = self.jobs.lock().unwrap();
                    jobs.get_mut(&identity(storage, id)).is_some_and(|job| {
                        let again = !settled && job.watch_requested && self.check_running().is_ok();
                        job.watch_requested = false;
                        if !again {
                            job.watching = false;
                        }
                        again
                    })
                };
                if again {
                    continue;
                }
                return;
            }
            tokio::select! {
                _=self.shutdown.cancelled()=>{
                    let _=patch(storage,principal,id,TaskPatch { recovery_state: Some(TaskRecoveryState::Unknown), error_code: Some(Some("TASK_RUNTIME_INTERRUPTED".into())), ..Default::default() }).await;
                    if let Some(job)=self.jobs.lock().unwrap().get_mut(&identity(storage,id)){job.watching=false;}
                    return;
                },
                _=tokio::time::sleep(Duration::from_millis(1500))=>{},
            }
        }
    }
    pub(super) async fn recover_provider(
        self: &Arc<Self>,
        storage: &Storage,
        principal: &str,
        task: &TaskRecord,
        cancellation: &mut RecoveryState,
    ) -> Result<crate::execution::Observation> {
        if task.kind != TaskKind::Batch {
            return self
                .provider
                .recover_task(&serde_json::to_value(task)?, &mut cancellation.single)
                .await;
        }
        let id = &task.task_id;
        let hooks = Arc::new(hooks::Hooks {
            runtime: Arc::downgrade(self),
            storage: storage.clone(),
            principal: principal.into(),
            id: id.into(),
        });
        let (observation, checkpoint) = self
            .video()?
            .recover_batch(&serde_json::to_value(task)?, hooks, &mut cancellation.batch)
            .await?;
        patch(
            storage,
            principal,
            id,
            TaskPatch {
                checkpoint: Some(Some(checkpoint.clone())),
                ..Default::default()
            },
        )
        .await?;
        if let Some(job) = checkpoint["gatewayJobId"].as_str() {
            self.register_job(storage, id, job.into());
        }
        Ok(observation)
    }
}
fn recovery_closed() -> ApiError {
    ApiError::new(503, "TASK_RUNTIME_CLOSED", "Task runtime is draining")
}
fn recovery_timeout() -> ApiError {
    ApiError::new(
        504,
        "TASK_RECOVERY_TIMEOUT",
        "Task recovery observation timed out; retry the original task",
    )
}
