//! Browser acceptance receipts. Execution and result retention stay in generation.
use super::*;
pub(super) use crate::generation::receipts::Requests;
use crate::generation::receipts::{Acceptance, Receipt};
use futures_util::future::BoxFuture;

impl Service {
    async fn receipt_value(&self, mut receipt: Receipt) -> Result<Value> {
        let waiting =
            if receipt.job_id.is_none() && receipt.error.is_none() && !receipt.cancel_requested {
                let (latest, waiting) = self.requests.refresh(receipt).await?;
                receipt = latest;
                waiting
            } else {
                false
            };
        if let Some(error) = receipt.error {
            return Ok(json!({"requestKey":receipt.request_key,"job":null,"rejected":error}));
        }
        let job = match &receipt.job_id {
            Some(id) => Some(self.get_job(id, &receipt.owner, &receipt.family).await?),
            None if receipt.cancel_requested => {
                return Ok(
                    json!({"requestKey":receipt.request_key,"job":null,"rejected":{"status":409,"code":"IMAGE_REQUEST_CANCELLED","message":"图片请求已取消"}}),
                );
            }
            None if receipt.epoch != self.requests.epoch => {
                return Err(ApiError::new(
                    409,
                    "IMAGE_REQUEST_INTERRUPTED",
                    "接收期间服务已重启，请核对原任务；不会自动重新提交",
                ));
            }
            None => {
                if !waiting {
                    return Err(ApiError::new(
                        409,
                        "IMAGE_ACCEPTANCE_UNKNOWN",
                        "图片接收未完成且状态无法写稳，请核对原请求；不会重新提交",
                    ));
                }
                None
            }
        };
        let mut value = json!({"requestKey":receipt.request_key,"job":null});
        value["job"] = job.unwrap_or(Value::Null);
        Ok(value)
    }
    pub(super) async fn request_status(
        &self,
        key: &str,
        owner: &str,
        family: &str,
    ) -> Result<Value> {
        match self.requests.status(key, owner, family).await? {
            Some(receipt) => self.receipt_value(receipt).await,
            None => Ok(json!({"requestKey":key,"job":null})),
        }
    }
    pub(super) async fn accept_request(
        self: &Arc<Self>,
        body: Value,
        key: String,
        owner: String,
        family: &'static str,
        local: bool,
    ) -> Result<Value> {
        let (reply, result) = tokio::sync::oneshot::channel();
        let service = self.clone();
        // The owner includes the first durable write. Dropping HTTP observation
        // cannot leave a saved intent without transferring its preparation.
        self.uploads.spawn(async move {
            let value = service
                .accept_request_owned(body, key, owner, family, local)
                .await;
            let _ = reply.send(value);
        });
        result.await.map_err(|_| {
            ApiError::new(
                503,
                "IMAGE_ACCEPTANCE_UNKNOWN",
                "图片接收结果未知，请查询原请求",
            )
        })?
    }
    async fn accept_request_owned(
        self: &Arc<Self>,
        mut body: Value,
        key: String,
        owner: String,
        family: &'static str,
        local: bool,
    ) -> Result<Value> {
        let intent = self.requests.intent(key, owner.clone(), family)?;
        body.as_object_mut()
            .ok_or_else(|| ApiError::invalid("图片输入必须为对象"))?
            .remove("requestKey");
        let fingerprint = crate::storage::json_fingerprint(&body);
        let receipt = match self
            .requests
            .begin(
                intent,
                fingerprint,
                &self.shutdown,
                closed,
                "图片请求编号已绑定其他参数，请先核对原任务",
            )
            .await?
        {
            Acceptance::Existing(receipt) => receipt,
            Acceptance::New(pending) => {
                let service = self.clone();
                pending.spawn(&self.uploads, move |operation, cancel| async move {
                    let outcome = async {
                        let prepared = service
                            .prepare_owned(body, family, local, Some(&owner), cancel.clone())
                            .await?;
                        inputs::protect_and_restore(
                            &service.config,
                            &prepared.originals,
                            None,
                            &cancel,
                        )
                        .await?;
                        let hooks = Arc::new(ReceiptObservation {
                            service: Arc::downgrade(&service),
                            token: operation.clone(),
                            cancel,
                        });
                        service
                            .backend
                            .clone()
                            .submit(prepared.backend, owner, Some(hooks))
                            .await
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
        self.uploads.spawn(async move {
            let value = service.cancel_request_owned(&key, &owner, &family).await;
            let _ = reply.send(value);
        });
        result.await.map_err(|_| {
            ApiError::new(
                503,
                "IMAGE_CANCEL_UNKNOWN",
                "图片取消结果未知，请查询原请求",
            )
        })?
    }
    async fn cancel_request_owned(&self, key: &str, owner: &str, family: &str) -> Result<Value> {
        let receipt = self.requests.cancel(key, owner, family).await?;
        let job = match &receipt.job_id {
            Some(id) => Some(self.cancel(id, owner, family).await?),
            None => None,
        };
        let mut value = json!({"requestKey":key,"job":null,"cancelRequested":true});
        value["job"] = job.unwrap_or(Value::Null);
        Ok(value)
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
            Err(inputs::cancelled())
        } else {
            Ok(())
        }
    }
}
impl ExecutionHooks for ReceiptObservation {
    fn checkpoint(&self, value: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let service = self.service.upgrade().ok_or_else(closed)?;
            service
                .requests
                .checkpoint(
                    &self.token,
                    &self.cancel,
                    &value,
                    inputs::cancelled,
                    "缺少图片任务编号",
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
