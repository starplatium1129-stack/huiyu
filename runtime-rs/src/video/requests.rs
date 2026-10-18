//! Browser acceptance owns an identity; execution and results stay in video.
use super::*;
use crate::generation::receipts::{Receipt, Rejection};
use futures_util::future::BoxFuture;

pub(super) const JOB: &str = "video";
pub(super) const BATCH: &str = "video-batch";
pub(super) enum RequestInput {
    Job(Value),
    Batch(Value),
    Retry {
        batch_id: String,
        indices: Vec<usize>,
    },
}
impl RequestInput {
    fn family(&self) -> &'static str {
        if matches!(self, Self::Job(_)) {
            JOB
        } else {
            BATCH
        }
    }
    fn fingerprint(&self) -> String {
        crate::storage::json_fingerprint(&match self {
            Self::Job(input) => json!({"kind":"video","input":input}),
            Self::Batch(input) => json!({"kind":"batch","input":input}),
            Self::Retry { batch_id, indices } => {
                json!({"kind":"retry","batchId":batch_id,"indices":indices})
            }
        })
    }
}
impl Service {
    async fn receipt_value(&self, mut receipt: Receipt) -> Result<Value> {
        let token = self
            .requests
            .token(&receipt.owner, &receipt.family, &receipt.request_key)?;
        let active = self.requests.active.lock().await;
        if let Some(latest) = self.requests.read(&token).await? {
            receipt = latest;
        }
        let waiting = active.contains_key(&token);
        drop(active);
        let field = if receipt.family == JOB {
            "job"
        } else {
            "batch"
        };
        if let Some(error) = receipt.error {
            return Ok(json!({"requestKey":receipt.request_key,field:null,"rejected":error}));
        }
        if receipt.cancel_requested && receipt.job_id.is_none() {
            return Ok(
                json!({"requestKey":receipt.request_key,field:null,"rejected":{"status":409,"code":"VIDEO_REQUEST_CANCELLED","message":"视频请求已取消"}}),
            );
        }
        // A retry records the source ID before mutating it. Do not publish its
        // old failed projection as the accepted retry while that mutation waits.
        let value = if waiting {
            None
        } else {
            match &receipt.job_id {
                Some(id) => Some(if receipt.family == JOB {
                    self.get_job(id, &receipt.owner).await?
                } else {
                    self.get_batch(id, &receipt.owner).await?
                }),
                None if receipt.epoch != self.requests.epoch => {
                    return Err(error(
                        409,
                        "VIDEO_REQUEST_INTERRUPTED",
                        "接收期间服务已重启，请核对原任务；不会重新提交",
                    ));
                }
                None => {
                    return Err(error(
                        409,
                        "VIDEO_ACCEPTANCE_UNKNOWN",
                        "视频接收结果无法确认，请核对原请求；不会重新提交",
                    ));
                }
            }
        };
        Ok(json!({"requestKey":receipt.request_key,field:value}))
    }
    pub(super) async fn request_status(
        &self,
        key: &str,
        owner: &str,
        family: &str,
    ) -> Result<Value> {
        let token = self.requests.token(owner, family, key)?;
        let active = self.requests.active.lock().await;
        let receipt = self.requests.read(&token).await?;
        drop(active);
        match receipt {
            Some(receipt) => self.receipt_value(receipt).await,
            None => {
                let field = if family == JOB { "job" } else { "batch" };
                Ok(json!({"requestKey":key,field:null}))
            }
        }
    }
    pub(super) async fn accept_request(
        self: &Arc<Self>,
        input: RequestInput,
        key: String,
        owner: String,
        local: bool,
    ) -> Result<Value> {
        let (reply, result) = tokio::sync::oneshot::channel();
        let service = self.clone();
        // Observation may leave even during the first intent write. The service
        // owns that write and its execution handoff through the existing tracker.
        self.tasks.spawn(async move {
            let value = service.accept_request_owned(input, key, owner, local).await;
            let _ = reply.send(value);
        });
        result.await.map_err(|_| {
            error(
                503,
                "VIDEO_ACCEPTANCE_UNKNOWN",
                "视频接收结果未知，请查询原请求",
            )
        })?
    }
    async fn accept_request_owned(
        self: &Arc<Self>,
        input: RequestInput,
        key: String,
        owner: String,
        local: bool,
    ) -> Result<Value> {
        let family = input.family();
        let token = self.requests.token(&owner, family, &key)?;
        let fingerprint = input.fingerprint();
        let mut active = self.requests.active.lock().await;
        if self.shutdown.is_cancelled() {
            return Err(error(503, "SERVICE_CLOSED", "视频服务已关闭"));
        }
        if let Some(receipt) = self.requests.read(&token).await? {
            if receipt.cancel_requested && receipt.fingerprint.is_empty() {
                drop(active);
                return self.receipt_value(receipt).await;
            }
            if receipt.fingerprint != fingerprint {
                return Err(error(
                    409,
                    "VIDEO_REQUEST_CONFLICT",
                    "视频请求编号已绑定其他操作，请先核对原任务",
                ));
            }
            if !receipt.error.as_ref().is_some_and(|e| e.status == 429)
                || receipt.cancel_requested
                || active.contains_key(&token)
            {
                drop(active);
                return self.receipt_value(receipt).await;
            }
        }
        let permit = self
            .requests
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                error(
                    429,
                    "VIDEO_ACCEPTANCE_BUSY",
                    "视频接收队列已满，请稍后查询原请求",
                )
            })?;
        let cancel = self.shutdown.child_token();
        let receipt = Receipt {
            request_key: key,
            owner: owner.clone(),
            family: family.into(),
            fingerprint,
            epoch: self.requests.epoch.clone(),
            job_id: None,
            cancel_requested: false,
            error: None,
        };
        self.requests.save(&token, &receipt).await?;
        active.insert(token.clone(), cancel.clone());
        let service = self.clone();
        let operation = token.clone();
        self.tasks.spawn(async move {
            let _permit = permit;
            let hooks = Arc::new(ReceiptObservation {
                service: Arc::downgrade(&service),
                token: operation.clone(),
                cancel: cancel.clone(),
            });
            let outcome = async {
                match input {
                    RequestInput::Job(body) => {
                        let prepared = service
                            .prepare_owned(body, local, Some(&owner), cancel.clone())
                            .await?;
                        inputs::protect_restore(
                            &service.config,
                            &prepared.originals,
                            None,
                            &cancel,
                        )
                        .await?;
                        service
                            .backend
                            .clone()
                            .submit(prepared.backend, owner, Some(hooks))
                            .await
                    }
                    RequestInput::Batch(body) => {
                        let prepared = service
                            .prepare_batch_owned(body, local, Some(&owner), cancel)
                            .await?;
                        service
                            .clone()
                            .submit_batch_accepting(prepared, owner, None, Some(hooks.as_ref()))
                            .await
                    }
                    RequestInput::Retry { batch_id, indices } => {
                        service
                            .clone()
                            .retry_shots_accepting(&batch_id, &owner, indices, hooks.as_ref())
                            .await
                    }
                }
            }
            .await;
            let mut active = service.requests.active.lock().await;
            if let Err(error) = outcome {
                if let Ok(Some(mut receipt)) = service.requests.read(&operation).await {
                    // Only a pre-checkpoint failure proves that no execution was
                    // transferred. An ID always keeps the original lookup path.
                    if receipt.job_id.is_none() {
                        receipt.error = Some(Rejection {
                            status: error.status.as_u16(),
                            code: error.code,
                            message: error.message.chars().take(1000).collect(),
                        });
                        if let Err(error) = service.requests.save(&operation, &receipt).await {
                            eprintln!("video receipt: {}", error.code);
                        }
                    }
                }
            }
            active.remove(&operation);
        });
        drop(active);
        self.receipt_value(receipt).await
    }
    pub(super) async fn cancel_request(
        self: &Arc<Self>,
        key: &str,
        owner: &str,
        family: &str,
    ) -> Result<Value> {
        let (reply, result) = tokio::sync::oneshot::channel();
        let service = self.clone();
        let (key, owner, family) = (key.to_owned(), owner.to_owned(), family.to_owned());
        self.tasks.spawn(async move {
            let value = service.cancel_request_owned(&key, &owner, &family).await;
            let _ = reply.send(value);
        });
        result.await.map_err(|_| {
            error(
                503,
                "VIDEO_CANCEL_UNKNOWN",
                "视频取消结果未知，请查询原请求",
            )
        })?
    }
    async fn cancel_request_owned(&self, key: &str, owner: &str, family: &str) -> Result<Value> {
        let token = self.requests.token(owner, family, key)?;
        let active = self.requests.active.lock().await;
        let mut receipt = self.requests.read(&token).await?.unwrap_or(Receipt {
            request_key: key.into(),
            owner: owner.into(),
            family: family.into(),
            fingerprint: String::new(),
            epoch: self.requests.epoch.clone(),
            job_id: None,
            cancel_requested: true,
            error: None,
        });
        receipt.cancel_requested = true;
        self.requests.save(&token, &receipt).await?;
        if let Some(cancel) = active.get(&token) {
            cancel.cancel();
        }
        drop(active);
        let value = match &receipt.job_id {
            Some(id) => Some(if family == JOB {
                self.cancel(id, owner).await?
            } else {
                self.cancel_batch(id, owner).await?
            }),
            None => None,
        };
        let field = if family == JOB { "job" } else { "batch" };
        Ok(json!({"requestKey":key,field:value,"cancelRequested":true}))
    }
}
struct ReceiptObservation {
    service: std::sync::Weak<Service>,
    token: String,
    cancel: CancellationToken,
}
impl ReceiptObservation {
    fn check(&self) -> Result<()> {
        if self.cancel.is_cancelled() {
            Err(error(499, "VIDEO_REQUEST_CANCELLED", "视频请求已取消"))
        } else {
            Ok(())
        }
    }
}
impl ExecutionHooks for ReceiptObservation {
    fn checkpoint(&self, value: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let service = self
                .service
                .upgrade()
                .ok_or_else(|| error(503, "SERVICE_CLOSED", "视频服务已关闭"))?;
            let _active = service.requests.active.lock().await;
            self.check()?;
            let mut receipt = service
                .requests
                .read(&self.token)
                .await?
                .ok_or_else(|| error(503, "VIDEO_RECEIPT_UNAVAILABLE", "视频接收凭据丢失"))?;
            if receipt.cancel_requested {
                return Err(error(499, "VIDEO_REQUEST_CANCELLED", "视频请求已取消"));
            }
            receipt.job_id = Some(
                value["gatewayJobId"]
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("缺少视频任务编号"))?
                    .into(),
            );
            service.requests.save(&self.token, &receipt).await
        })
    }
    fn submitting(&self, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.check() })
    }
    fn observed(&self, _: String, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn collect(&self, _: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
}
