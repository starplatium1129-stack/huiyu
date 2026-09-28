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
            let list = storage
                .request(json!({"kind":"task.list"}), principal)
                .await?;
            for task in list["items"]
                .as_array()
                .ok_or_else(|| ApiError::invalid("Invalid task list"))?
            {
                if task["deliveryState"] == "discarded"
                    || task["upstreamSettled"] == true
                        && (task["status"] != "succeeded" || task["resultState"] == "available")
                {
                    continue;
                }
                let id = text(task, "taskId")?;
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
            let settled = observed
                .as_ref()
                .is_ok_and(|task| task["upstreamSettled"] == true);
            let stop = observed
                .as_ref()
                .map_or(true, |task| settled || task["recoveryState"] == "unknown");
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
                    let _=patch(storage,principal,id,json!({"recoveryState":"unknown","errorCode":"TASK_RUNTIME_INTERRUPTED"})).await;
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
        task: &Value,
        cancellation: &mut RecoveryState,
    ) -> Result<crate::generation::Observation> {
        if task["kind"] != "batch" {
            return self
                .provider
                .recover_task(task, &mut cancellation.single)
                .await;
        }
        let id = text(task, "taskId")?;
        let hooks = Arc::new(hooks::Hooks {
            runtime: Arc::downgrade(self),
            storage: storage.clone(),
            principal: principal.into(),
            id: id.into(),
        });
        let (observation, checkpoint) = self
            .video()?
            .recover_batch(task, hooks, &mut cancellation.batch)
            .await?;
        patch(storage, principal, id, json!({"checkpoint":checkpoint})).await?;
        if let Some(job) = checkpoint["gatewayJobId"].as_str() {
            self.register_job(storage, id, job.into());
        }
        Ok(observation)
    }
}
