use super::*;
use std::time::Duration;

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
        once.get_or_try_init(|| async {
            let list = storage.task(TaskCommand::List, principal).await?;
            for task in list["items"]
                .as_array()
                .ok_or_else(|| ApiError::invalid("Invalid task list"))?
            {
                let task: TaskRecord = serde_json::from_value(task.clone())?;
                if task.delivery_state == DeliveryState::Discarded
                    || task.upstream_settled
                        && (task.status != TaskStatus::Succeeded
                            || task.result_state == ResultState::Available)
                {
                    continue;
                }
                let id = &task.task_id;
                self.reconcile(storage, principal, id).await?;
            }
            Ok::<(), ApiError>(())
        })
        .await?;
        Ok(())
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
