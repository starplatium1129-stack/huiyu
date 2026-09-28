use super::*;
impl Service {
    pub async fn cancel_batch(&self, id: &str, owner: &str) -> Result<Value> {
        let batch = self.batch(id, owner).await?;
        let ids = {
            let mut s = batch.state.lock().await;
            s.cancel.cancel();
            if s.status == "done" {
                return Ok(batch_public_after_unlock(s, &batch).await);
            }
            s.status = "cancelling".into();
            let mut ids = Vec::new();
            for shot in &mut s.shots {
                if shot.status == "pending" {
                    shot.status = "cancelled".into()
                } else if let Some(id) = &shot.gateway
                    && shot.status != "succeeded"
                {
                    ids.push(id.clone());
                }
            }
            ids
        };
        for id in ids {
            let _ = self.cancel(&id, owner).await;
        }
        let settled = self.reconcile_live(&batch).await?;
        {
            let mut s = batch.state.lock().await;
            s.status = if settled { "cancelled" } else { "paused" }.into();
            s.unknown = !settled;
            s.error_code = (!settled).then(|| "BATCH_UPSTREAM_UNKNOWN".into());
        }
        batch.save().await?;
        Ok(batch.public().await)
    }
    async fn reconcile_live(&self, batch: &Batch) -> Result<bool> {
        let shots = batch.state.lock().await.shots.clone();
        let mut settled = true;
        for (index, shot) in shots.iter().enumerate() {
            if shot.intent.is_none() || shot.status == "succeeded" {
                continue;
            }
            let Some(id) = &shot.gateway else {
                settled = false;
                continue;
            };
            let observation = match self.query(id, &batch.owner).await {
                Ok(observation) => observation,
                Err(e) if matches!(e.status.as_u16(), 404 | 410) => {
                    settled = false;
                    continue;
                }
                Err(e) => return Err(e),
            };
            if observation.settled && !observation.unknown {
                let mut s = batch.state.lock().await;
                s.shots[index].status = observation.status;
                s.shots[index].code = observation.error_code;
                if let Some(o) = observation.outputs.into_iter().next() {
                    s.shots[index].result = Some(o);
                }
            } else {
                settled = false;
            }
        }
        Ok(settled)
    }
    pub async fn batch_action(
        self: Arc<Self>,
        id: &str,
        owner: &str,
        action: &str,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let scope = cancel.child_token();
        let _guard = scope.clone().drop_guard();
        let (id, owner, action) = (id.to_string(), owner.to_string(), action.to_string());
        let (reply, result) = tokio::sync::oneshot::channel();
        let service = self.clone();
        self.tasks.spawn(async move {
            let value = service
                .batch_action_inner(&id, &owner, &action, scope)
                .await;
            let _ = reply.send(value);
        });
        result
            .await
            .map_err(|_| error(503, "BATCH_ACTION_UNKNOWN", "分镜操作结果未知，请查询任务"))?
    }
    async fn batch_action_inner(
        self: Arc<Self>,
        id: &str,
        owner: &str,
        action: &str,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let batch = self.batch(id, owner).await?;
        match action {
            "concat" => {
                self.concat_batch(batch.clone(), cancel).await?;
            }
            "continue" => {
                let _gate = batch.serial.lock().await;
                if batch.state.lock().await.status != "paused" {
                    return Err(error(409, "BATCH_RESUME_UNSAFE", "分镜尚未完成核对"));
                }
                if !self.reconcile_live(&batch).await? {
                    return Err(error(
                        409,
                        "BATCH_RECOVERY_REVIEW",
                        "已提交分镜尚未确认完成",
                    ));
                }
                let shots = batch.state.lock().await.shots.clone();
                if shots
                    .iter()
                    .any(|s| s.intent.is_some() && s.status != "succeeded")
                {
                    return Err(error(
                        409,
                        "BATCH_RECOVERY_REVIEW",
                        "已提交分镜需要显式替换，不能重放",
                    ));
                }
                if let Some(h) = &batch.hooks {
                    for shot in &shots {
                        resume::restore(&self.config, &shot.input, h.as_ref(), &cancel).await?;
                    }
                }
                if batch.input["linkLastFrame"] == true
                    && let Some(index) = shots.iter().position(|s| s.intent.is_none())
                    && index > 0
                    && !generation::truthy(&shots[index].input["references"])
                {
                    let previous = &shots[index - 1];
                    let name = if let Some(name) = &previous.tail {
                        Some(name.clone())
                    } else if let Some(output) = &previous.result {
                        transcode::tail(&self, output, cancel.clone()).await.ok()
                    } else {
                        None
                    };
                    if let Some(name) = name {
                        let mut s = batch.state.lock().await;
                        s.shots[index - 1].tail = Some(name.clone());
                        let key = if generation::truthy(&s.shots[index].input["image"]) {
                            "lastFrame"
                        } else {
                            "image"
                        };
                        s.shots[index].input[key] = json!(name);
                    }
                }
                {
                    let mut s = batch.state.lock().await;
                    if cancel.is_cancelled() {
                        return Err(error(499, "VIDEO_BATCH_CANCELLED", "继续操作已取消"));
                    }
                    for shot in &mut s.shots {
                        if shot.intent.is_none() {
                            shot.status = "pending".into();
                        }
                    }
                    s.cancel = self.shutdown.child_token();
                    s.status = "running".into();
                    s.unknown = false;
                    s.error_code = None;
                }
                batch.save().await?;
                drop(_gate);
                self.kick(batch.clone(), None);
            }
            _ => return Err(error(400, "TASK_ACTION_INVALID", "不支持的分镜操作")),
        }
        Ok(batch.public().await)
    }
    pub async fn retry_shot(self: Arc<Self>, id: &str, owner: &str, index: usize) -> Result<Value> {
        let batch = self.batch(id, owner).await?;
        if batch.hooks.is_some() {
            return Err(error(
                409,
                "BATCH_RECOVERY_REVIEW",
                "持久任务重抽需创建新的任务键",
            ));
        }
        let _gate = batch.serial.lock().await;
        let _concat = batch
            .concat_serial
            .try_lock()
            .map_err(|_| error(409, "BATCH_CONCAT_RUNNING", "请先完成或取消当前拼接"))?;
        let shot = batch
            .state
            .lock()
            .await
            .shots
            .get(index)
            .cloned()
            .ok_or_else(|| error(404, "SHOT_NOT_FOUND", "分镜不存在"))?;
        if shot.intent.is_some() {
            let id = shot.gateway.as_deref().ok_or_else(|| {
                error(
                    409,
                    "BATCH_RECOVERY_REVIEW",
                    "分镜已有提交意图但任务身份未知",
                )
            })?;
            let observation = self.query(id, owner).await?;
            if !observation.settled || observation.unknown {
                return Err(error(
                    409,
                    "BATCH_RECOVERY_REVIEW",
                    "分镜上游尚未确认终止，不能重抽",
                ));
            }
        }
        {
            let mut s = batch.state.lock().await;
            let shot = s
                .shots
                .get_mut(index)
                .ok_or_else(|| error(404, "SHOT_NOT_FOUND", "分镜不存在"))?;
            if !["failed", "cancelled"].contains(&shot.status.as_str()) {
                return Err(error(
                    409,
                    "BATCH_SHOT_NOT_RETRYABLE",
                    "只有失败或取消的分镜可以重抽",
                ));
            }
            shot.status = "pending".into();
            shot.intent = None;
            shot.gateway = None;
            shot.upstream = None;
            shot.error = None;
            shot.code = None;
            shot.result = None;
            if let Some(Output::File { path, .. }) = s.concat.take() {
                let _ = tokio::fs::remove_file(path).await;
            }
            s.concat_stage = "none";
            s.cancel = self.shutdown.child_token();
            s.status = "running".into();
        }
        drop(_gate);
        drop(_concat);
        self.kick(batch.clone(), None);
        Ok(batch.public().await)
    }
    async fn concat_batch(&self, batch: Arc<Batch>, cancel: CancellationToken) -> Result<()> {
        let _gate = tokio::select! {g=batch.concat_serial.lock()=>g,_=cancel.cancelled()=>return Err(error(499,"VIDEO_BATCH_CANCELLED","拼接已取消"))};
        let (outputs, canvas, scope, index) = {
            let mut s = batch.state.lock().await;
            if let Some(output) = s.concat.clone() {
                let index = s.shots.len();
                drop(s);
                if let Some(h) = &batch.hooks {
                    h.collect_indexed(vec![(index, output)]).await?;
                }
                return batch.save().await;
            }
            let outputs = s
                .shots
                .iter()
                .filter(|s| s.status == "succeeded")
                .filter_map(|s| s.result.clone())
                .collect::<Vec<_>>();
            if outputs.len() < 2 {
                return Err(error(
                    409,
                    "BATCH_CONCAT_NEEDS_SHOTS",
                    "至少需要两个成功分镜才能拼接",
                ));
            }
            if s.status == "done" && s.cancel.is_cancelled() {
                s.cancel = self.shutdown.child_token();
            }
            s.concat_stage = "processing";
            (
                outputs,
                s.shots[0].input.clone(),
                s.cancel.child_token(),
                s.shots.len(),
            )
        };
        let _drop = scope.clone().drop_guard();
        if let Err(e) = batch.save().await {
            batch.state.lock().await.concat_stage = "none";
            return Err(e);
        }
        let work = transcode::concat(self, &batch.id, &outputs, &canvas, scope.clone());
        tokio::pin!(work);
        let result = tokio::select! {result=&mut work=>result,_=cancel.cancelled()=>{scope.cancel();work.await}};
        match result {
            Ok(output) => {
                let mut s = batch.state.lock().await;
                s.concat = Some(output.clone());
                s.concat_stage = "available";
                drop(s);
                if let Some(h) = &batch.hooks
                    && let Err(e) = h.collect_indexed(vec![(index, output)]).await
                {
                    let _ = batch.save().await;
                    return Err(e);
                }
                batch.save().await
            }
            Err(e) => {
                batch.state.lock().await.concat_stage = "none";
                let _ = batch.save().await;
                Err(e)
            }
        }
    }
}
async fn batch_public_after_unlock(s: tokio::sync::MutexGuard<'_, State>, batch: &Batch) -> Value {
    drop(s);
    batch.public().await
}
