//! Browser acceptance receipts. Execution and result retention stay in generation.
use super::*;
use futures_util::future::BoxFuture;
use crate::generation::receipts::{Receipt, Rejection};
pub(super) use crate::generation::receipts::Requests;

impl Service {
    async fn receipt_value(&self, mut receipt: Receipt) -> Result<Value> {
        let waiting = if receipt.job_id.is_none() && receipt.error.is_none() && !receipt.cancel_requested {
            let token = self.requests.token(&receipt.owner, &receipt.family, &receipt.request_key)?;
            let active = self.requests.active.lock().await;
            // Acceptance may have finished after the caller read its snapshot.
            if let Some(latest) = self.requests.read(&token).await? { receipt = latest; }
            active.contains_key(&token)
        } else { false };
        if let Some(error) = receipt.error {
            return Ok(json!({"requestKey":receipt.request_key,"job":null,"rejected":error}));
        }
        let job = match &receipt.job_id {
            Some(id) => Some(self.get_job(id, &receipt.owner, &receipt.family).await?),
            None if receipt.cancel_requested => return Ok(json!({"requestKey":receipt.request_key,"job":null,"rejected":{"status":409,"code":"IMAGE_REQUEST_CANCELLED","message":"图片请求已取消"}})),
            None if receipt.epoch != self.requests.epoch => return Err(ApiError::new(409, "IMAGE_REQUEST_INTERRUPTED", "接收期间服务已重启，请核对原任务；不会自动重新提交")),
            None => {
                if !waiting {
                    return Err(ApiError::new(409, "IMAGE_ACCEPTANCE_UNKNOWN", "图片接收未完成且状态无法写稳，请核对原请求；不会重新提交"));
                }
                None
            },
        };
        Ok(json!({"requestKey":receipt.request_key,"job":job}))
    }
    pub(super) async fn request_status(&self, key: &str, owner: &str, family: &str) -> Result<Value> {
        let token = self.requests.token(owner, family, key)?;
        let active = self.requests.active.lock().await;
        let receipt = self.requests.read(&token).await?;
        drop(active);
        match receipt {
            Some(receipt) => self.receipt_value(receipt).await,
            None => Ok(json!({"requestKey":key,"job":null})),
        }
    }
    pub(super) async fn accept_request(self: &Arc<Self>, body: Value, key: String, owner: String, family: &'static str, local: bool) -> Result<Value> {
        let (reply, result) = tokio::sync::oneshot::channel();
        let service = self.clone();
        // The owner includes the first durable write. Dropping HTTP observation
        // cannot leave a saved intent without transferring its preparation.
        self.uploads.spawn(async move {
            let value = service.accept_request_owned(body, key, owner, family, local).await;
            let _ = reply.send(value);
        });
        result.await.map_err(|_| ApiError::new(503, "IMAGE_ACCEPTANCE_UNKNOWN", "图片接收结果未知，请查询原请求"))?
    }
    async fn accept_request_owned(self: &Arc<Self>, mut body: Value, key: String, owner: String, family: &'static str, local: bool) -> Result<Value> {
        let token = self.requests.token(&owner, family, &key)?;
        body.as_object_mut().ok_or_else(|| ApiError::invalid("图片输入必须为对象"))?.remove("requestKey");
        let fingerprint = crate::storage::json_fingerprint(&body);
        let mut active = self.requests.active.lock().await;
        if self.shutdown.is_cancelled() { return Err(closed()); }
        if let Some(receipt) = self.requests.read(&token).await? {
            if receipt.cancel_requested && receipt.fingerprint.is_empty() {
                drop(active);
                return self.receipt_value(receipt).await;
            }
            if receipt.fingerprint != fingerprint {
                return Err(ApiError::new(409, "IMAGE_REQUEST_CONFLICT", "图片请求编号已绑定其他参数，请先核对原任务"));
            }
            // A known capacity rejection never submitted upstream. Batch admission
            // may retry that same key; uncertain or accepted requests never re-enter.
            if !receipt.error.as_ref().is_some_and(|e| e.status == 429) || receipt.cancel_requested || active.contains_key(&token) {
                drop(active);
                return self.receipt_value(receipt).await;
            }
        }
        let permit = self.requests.admission.clone().try_acquire_owned()
            .map_err(|_| ApiError::new(429, "IMAGE_ACCEPTANCE_BUSY", "图片接收队列已满，请稍后查询原请求"))?;
        let cancel = self.shutdown.child_token();
        let receipt = Receipt { request_key: key, owner: owner.clone(), family: family.into(), fingerprint,
            epoch: self.requests.epoch.clone(), job_id: None, cancel_requested: false, error: None };
        self.requests.save(&token, &receipt).await?;
        active.insert(token.clone(), cancel.clone());
        let service = self.clone();
        let operation = token.clone();
        self.uploads.spawn(async move {
            let _permit = permit;
            let outcome = async {
                let prepared = service.prepare_owned(body, family, local, Some(&owner), cancel.clone()).await?;
                inputs::protect_and_restore(&service.config, &prepared.originals, None, &cancel).await?;
                let hooks = Arc::new(ReceiptObservation { service: Arc::downgrade(&service), token: operation.clone(), cancel });
                service.backend.clone().submit(prepared.backend, owner, Some(hooks)).await
            }.await;
            let mut active = service.requests.active.lock().await;
            if let Err(error) = outcome {
                if let Ok(Some(mut receipt)) = service.requests.read(&operation).await {
                    // A checkpointed job remains authoritative even if the submit
                    // response failed after upstream transfer.
                    if receipt.job_id.is_none() {
                        receipt.error = Some(Rejection { status: error.status.as_u16(), code: error.code, message: error.message.chars().take(1000).collect() });
                        if let Err(error) = service.requests.save(&operation, &receipt).await { eprintln!("image receipt: {}", error.code); }
                    }
                }
            }
            active.remove(&operation);
        });
        drop(active);
        self.receipt_value(receipt).await
    }
    pub(super) async fn cancel_request(self: &Arc<Self>, key: &str, owner: &str, family: &str) -> Result<Value> {
        let (reply, result) = tokio::sync::oneshot::channel();
        let service = self.clone();
        let (key, owner, family) = (key.to_owned(), owner.to_owned(), family.to_owned());
        self.uploads.spawn(async move {
            let value = service.cancel_request_owned(&key, &owner, &family).await;
            let _ = reply.send(value);
        });
        result.await.map_err(|_| ApiError::new(503, "IMAGE_CANCEL_UNKNOWN", "图片取消结果未知，请查询原请求"))?
    }
    async fn cancel_request_owned(&self, key: &str, owner: &str, family: &str) -> Result<Value> {
        let token = self.requests.token(owner, family, key)?;
        let active = self.requests.active.lock().await;
        let mut receipt = self.requests.read(&token).await?.unwrap_or(Receipt {
            request_key: key.into(), owner: owner.into(), family: family.into(), fingerprint: String::new(),
            epoch: self.requests.epoch.clone(), job_id: None, cancel_requested: true, error: None,
        });
        receipt.cancel_requested = true;
        self.requests.save(&token, &receipt).await?;
        if let Some(cancel) = active.get(&token) { cancel.cancel(); }
        drop(active);
        let job = match &receipt.job_id { Some(id) => Some(self.cancel(id, owner, family).await?), None => None };
        Ok(json!({"requestKey":key,"job":job,"cancelRequested":true}))
    }
}
struct ReceiptObservation { service: std::sync::Weak<Service>, token: String, cancel: CancellationToken }
impl ReceiptObservation {
    fn check(&self) -> Result<()> { if self.cancel.is_cancelled() { Err(inputs::cancelled()) } else { Ok(()) } }
}
impl ExecutionHooks for ReceiptObservation {
    fn checkpoint(&self, value: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let service = self.service.upgrade().ok_or_else(closed)?;
            let _active = service.requests.active.lock().await;
            self.check()?;
            let mut receipt = service.requests.read(&self.token).await?.ok_or_else(|| ApiError::new(503, "IMAGE_RECEIPT_UNAVAILABLE", "图片接收凭据丢失"))?;
            if receipt.cancel_requested { return Err(inputs::cancelled()); }
            receipt.job_id = Some(value["gatewayJobId"].as_str().ok_or_else(|| ApiError::invalid("缺少图片任务编号"))?.into());
            service.requests.save(&self.token, &receipt).await
        })
    }
    fn submitting(&self, _: String) -> BoxFuture<'_, Result<()>> { Box::pin(async move { self.check() }) }
    fn observed(&self, _: String, _: Value) -> BoxFuture<'_, Result<()>> { Box::pin(async { Ok(()) }) }
    fn collect(&self, _: Vec<Output>) -> BoxFuture<'_, Result<()>> { Box::pin(async { Ok(()) }) }
}
