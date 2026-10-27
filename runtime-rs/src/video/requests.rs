//! Browser acceptance owns an identity; execution and results stay in video.
use super::*;
use crate::generation::receipts::{Acceptance, Receipt};
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
    fn fingerprint(&mut self) -> String {
        let (kind, input) = match self {
            Self::Job(input) => ("video", input),
            Self::Batch(input) => ("batch", input),
            Self::Retry { batch_id, indices } => {
                return crate::storage::json_fingerprint(
                    &json!({"kind":"retry","batchId":batch_id,"indices":indices}),
                );
            }
        };
        // Hash synchronously, restoring the same owned recipe before acceptance
        // can yield or transfer it. Large batch inputs need no detached copy.
        let mut frozen = json!({"kind":kind,"input":null});
        frozen["input"] = input.take();
        let fingerprint = crate::storage::json_fingerprint(&frozen);
        *input = frozen["input"].take();
        fingerprint
    }
}
impl Service {
    async fn receipt_value(&self, receipt: Receipt) -> Result<Value> {
        let (receipt, waiting) = self.requests.refresh(receipt).await?;
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
        let mut response = json!({"requestKey":receipt.request_key,field:null});
        response[field] = value.unwrap_or(Value::Null);
        Ok(response)
    }
    pub(super) async fn request_status(
        &self,
        key: &str,
        owner: &str,
        family: &str,
    ) -> Result<Value> {
        match self.requests.status(key, owner, family).await? {
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
        mut input: RequestInput,
        key: String,
        owner: String,
        local: bool,
    ) -> Result<Value> {
        let family = input.family();
        let intent = self.requests.intent(key, owner.clone(), family)?;
        let fingerprint = input.fingerprint();
        let receipt = match self
            .requests
            .begin(
                intent,
                fingerprint,
                &self.shutdown,
                || error(503, "SERVICE_CLOSED", "视频服务已关闭"),
                "视频请求编号已绑定其他操作，请先核对原任务",
            )
            .await?
        {
            Acceptance::Existing(receipt) => receipt,
            Acceptance::New(pending) => {
                let service = self.clone();
                pending.spawn(&self.tasks, move |operation, cancel| async move {
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
                                    .submit_batch_accepting(
                                        prepared,
                                        owner,
                                        None,
                                        Some(hooks.as_ref()),
                                    )
                                    .await
                            }
                            RequestInput::Retry { batch_id, indices } => {
                                service
                                    .clone()
                                    .retry_shots_accepting(
                                        &batch_id,
                                        &owner,
                                        indices,
                                        hooks.as_ref(),
                                    )
                                    .await
                            }
                        }
                    }
                    .await;
                    service.requests.finish(&operation, outcome.err()).await;
                })
            }
        };
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
        let receipt = self.requests.cancel(key, owner, family).await?;
        let value = match &receipt.job_id {
            Some(id) => Some(if family == JOB {
                self.cancel(id, owner).await?
            } else {
                self.cancel_batch(id, owner).await?
            }),
            None => None,
        };
        let field = if family == JOB { "job" } else { "batch" };
        let mut response = json!({"requestKey":key,field:null,"cancelRequested":true});
        response[field] = value.unwrap_or(Value::Null);
        Ok(response)
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
            service
                .requests
                .checkpoint(
                    &self.token,
                    &self.cancel,
                    &value,
                    || error(499, "VIDEO_REQUEST_CANCELLED", "视频请求已取消"),
                    "缺少视频任务编号",
                )
                .await
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
