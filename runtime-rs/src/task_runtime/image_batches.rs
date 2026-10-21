use super::*;
use std::time::Duration;

impl TaskRuntime {
    pub async fn image_batch(self: &Arc<Self>, storage: Storage, principal: String, command: Value) -> Result<Value> {
        self.check_running()?;
        let result = storage.request(command, &principal).await?;
        if needs_work(&result) && let Some(id) = result["id"].as_str() { self.start_image_batch(storage, principal, id.to_owned()); }
        Ok(result)
    }
    pub(crate) async fn recover_image_batches(self: &Arc<Self>, storage: &Storage, principal: &str) -> Result<()> {
        let plans = storage.request(json!({"kind":"imageBatch.list"}), principal).await?;
        for plan in plans.as_array().into_iter().flatten() {
            if needs_work(plan) && let Some(id) = plan["id"].as_str() {
                self.start_image_batch(storage.clone(), principal.into(), id.into());
            }
        }
        Ok(())
    }
    fn start_image_batch(self: &Arc<Self>, storage: Storage, principal: String, id: String) {
        let key = format!("{}:{principal}:{id}", storage.runtime_epoch());
        if self.check_running().is_err() || !self.image_batches.lock().unwrap().insert(key.clone()) { return; }
        let runtime = self.clone();
        self.tracker.spawn(async move {
            let result = runtime.run_image_batch(&storage, &principal, &id).await;
            if let Err(error) = result {
                if !runtime.shutdown.is_cancelled() {
                    if let Ok(plan) = storage.request(json!({"kind":"imageBatch.get","id":id}), &principal).await {
                        let index = plan["jobs"].as_array().and_then(|jobs| jobs.iter().position(|job| matches!(job["status"].as_str(),Some("accepted"|"running"))));
                        let mut command = json!({"kind":"imageBatch.progress","id":id,"expectedRevision":plan["revision"],"state":"paused","error":error.message});
                        if let Some(index) = index { command["index"]=json!(index); command["patch"]=json!({"status":"unknown"}); }
                        let _ = storage.request(command, &principal).await;
                    }
                }
            }
            runtime.image_batches.lock().unwrap().remove(&key);
        });
    }
    async fn run_image_batch(self: &Arc<Self>, storage: &Storage, principal: &str, id: &str) -> Result<()> {
        self.ensure_recovered(storage, principal).await?;
        loop {
            self.check_running()?;
            let plan = storage.request(json!({"kind":"imageBatch.get","id":id}), principal).await?;
            let jobs = plan["jobs"].as_array().ok_or_else(|| ApiError::invalid("Invalid image batch"))?;
            let next = jobs.iter().enumerate().find(|(_, job)| matches!(job["status"].as_str(), Some("accepted" | "running" | "unknown"))
                || plan["state"] == "running" && job["status"] == "pending");
            let Some((index, job)) = next else {
                if plan["state"] == "running" {
                    let state = if jobs.iter().any(|job| job["status"] == "failed") { "failed" } else { "succeeded" };
                    match storage.request(json!({"kind":"imageBatch.progress","id":id,"expectedRevision":plan["revision"],"state":state}), principal).await {
                        Err(error) if error.code == "REVISION_CONFLICT" => continue,
                        Err(error) => return Err(error),
                        Ok(_) => {}
                    }
                }
                return Ok(());
            };
            let key = job["requestKey"].as_str().ok_or_else(|| ApiError::invalid("Missing batch request identity"))?;
            let existing = storage.task_record_by_request(key, principal).await?;
            let task = if let Some(task) = existing { task } else {
                if plan["state"] != "running" { return Ok(()); }
                let input = storage.request(json!({"kind":"imageBatch.input","id":id,"index":index}),principal).await?;
                let request = json!({"kind":if input["snapshot"]["engine"]=="krea2" {"creative"}else{"anima"},
                    "requestKey":key,"input":input["taskInput"],"context":input["snapshot"]["context"]});
                match self.submit(storage.clone(), principal.into(), request).await {
                    Ok(value) => serde_json::from_value::<TaskRecord>(value)?,
                    Err(error) if error.code == "TASK_PROVIDER_BUSY" => { self.batch_pause().await?; continue; }
                    Err(error) if error.submission_not_accepted => {
                        self.batch_progress(storage, principal, id, &plan, index, json!({"status":"failed","error":error.message})).await?;
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            };
            let patch = if task.delivery_state == DeliveryState::Discarded {
                json!({"taskId":task.task_id,"submitted":true,"status":"cancelled","message":"已放弃接收此结果"})
            } else if task.status == TaskStatus::Succeeded && task.result_state == ResultState::Available {
                let (artwork, alias) = super::image_batch_artwork::save(storage, principal, &task).await?;
                Self::delivery(storage, principal, &task.task_id, "saved").await?;
                json!({"taskId":task.task_id,"submitted":true,"status":"succeeded","historyId":artwork,"imageId":alias,"message":"已入册"})
            } else if task.upstream_settled && matches!(task.status, TaskStatus::Failed | TaskStatus::Cancelled) {
                json!({"taskId":task.task_id,"submitted":true,"status":task.status,"error":task.error_code})
            } else {
                if task.result_state == ResultState::Unavailable {
                    return Err(ApiError::new(409,"BATCH_RESULT_UNAVAILABLE","原任务结果暂不可读取；已暂停批次，请在任务中心核对原结果。"));
                }
                if matches!(task.recovery_state, TaskRecoveryState::Unknown | TaskRecoveryState::Interrupted) {
                    return Err(ApiError::new(409,"BATCH_TASK_UNRESOLVED","原任务状态待核对；已暂停批次，请先在任务中心处理原任务。"));
                }
                let _ = self.reconcile(storage, principal, &task.task_id).await?;
                json!({"taskId":task.task_id,"submitted":true,"status":"accepted","message":"后台正在生成…"})
            };
            self.batch_progress(storage, principal, id, &plan, index, patch).await?;
            self.batch_pause().await?;
        }
    }
    async fn batch_progress(&self, storage: &Storage, principal: &str, id: &str, plan: &Value, index: usize, patch: Value) -> Result<()> {
        match storage.request(json!({"kind":"imageBatch.progress","id":id,"expectedRevision":plan["revision"],"index":index,"patch":patch}), principal).await {
            Ok(_) => Ok(()),
            Err(error) if error.code == "REVISION_CONFLICT" => Ok(()),
            Err(error) => Err(error),
        }
    }
    async fn batch_pause(&self) -> Result<()> {
        tokio::select! { _ = self.shutdown.cancelled() => self.check_running(), _ = tokio::time::sleep(Duration::from_secs(2)) => Ok(()) }
    }
}
fn needs_work(plan: &Value) -> bool {
    plan["state"] == "running" || plan["jobs"].as_array().is_some_and(|jobs| jobs.iter().any(|job| matches!(job["status"].as_str(), Some("accepted" | "running"))))
}
