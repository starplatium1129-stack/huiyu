//! Browser acceptance receipts. Execution and result retention stay in generation.
use super::*;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::{Mutex, Semaphore};

pub(super) struct Requests {
    epoch: String,
    active: Mutex<HashMap<String, CancellationToken>>,
    admission: Arc<Semaphore>,
}
impl Requests {
    pub fn new() -> Self {
        Self { epoch: uuid::Uuid::new_v4().to_string(), active: Mutex::new(HashMap::new()), admission: Arc::new(Semaphore::new(16)) }
    }
    pub async fn wait_for_acceptance(&self) { let _active = self.active.lock().await; }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    request_key: String,
    owner: String,
    family: String,
    fingerprint: String,
    epoch: String,
    job_id: Option<String>,
    cancel_requested: bool,
    error: Option<Rejection>,
}
#[derive(Serialize, Deserialize)]
struct Rejection { status: u16, code: String, message: String }

fn token(owner: &str, family: &str, key: &str) -> Result<String> {
    if key.is_empty() || key.len() > 160 || !key.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)) {
        return Err(ApiError::invalid("图片请求编号无效"));
    }
    Ok(crate::storage::json_fingerprint(&json!([owner, family, key])))
}
impl Service {
    fn receipt_path(&self, token: &str) -> PathBuf {
        self.config.runtime_root.join("jobs/image-requests").join(format!("{token}.json"))
    }
    async fn read_receipt(&self, identity: &str) -> Result<Option<Receipt>> {
        let path = self.receipt_path(identity);
        match tokio::fs::symlink_metadata(&path).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 16 * 1024 => {},
            _ => return Err(ApiError::new(503, "IMAGE_RECEIPT_UNAVAILABLE", "图片接收凭据不可读取，不能重新提交")),
        }
        let receipt: Receipt = serde_json::from_slice(&tokio::fs::read(path).await?)
            .map_err(|_| ApiError::new(503, "IMAGE_RECEIPT_UNAVAILABLE", "图片接收凭据已损坏，不能重新提交"))?;
        if token(&receipt.owner, &receipt.family, &receipt.request_key)? != identity {
            return Err(ApiError::new(503, "IMAGE_RECEIPT_UNAVAILABLE", "图片接收凭据身份不符，不能重新提交"));
        }
        Ok(Some(receipt))
    }
    async fn save_receipt(&self, token: &str, receipt: &Receipt) -> Result<()> {
        let path = self.receipt_path(token);
        let directory = path.parent().unwrap();
        tokio::fs::create_dir_all(directory).await?;
        for part in [directory.parent().unwrap(), directory] {
            if !tokio::fs::symlink_metadata(part).await.is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
                return Err(ApiError::new(503, "IMAGE_RECEIPT_UNAVAILABLE", "图片接收凭据目录不可用"));
            }
        }
        generation::write_job_record(&path, &serde_json::to_value(receipt)?).await
    }
    async fn receipt_value(&self, mut receipt: Receipt) -> Result<Value> {
        let waiting = if receipt.job_id.is_none() && receipt.error.is_none() && !receipt.cancel_requested {
            let token = token(&receipt.owner, &receipt.family, &receipt.request_key)?;
            let active = self.requests.active.lock().await;
            // Acceptance may have finished after the caller read its snapshot.
            if let Some(latest) = self.read_receipt(&token).await? { receipt = latest; }
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
        let token = token(owner, family, key)?;
        let active = self.requests.active.lock().await;
        let receipt = self.read_receipt(&token).await?;
        drop(active);
        match receipt {
            Some(receipt) => self.receipt_value(receipt).await,
            None => Ok(json!({"requestKey":key,"job":null})),
        }
    }
    pub(super) async fn accept_request(self: &Arc<Self>, mut body: Value, key: String, owner: String, family: &'static str, local: bool) -> Result<Value> {
        let token = token(&owner, family, &key)?;
        body.as_object_mut().ok_or_else(|| ApiError::invalid("图片输入必须为对象"))?.remove("requestKey");
        let fingerprint = crate::storage::json_fingerprint(&body);
        let mut active = self.requests.active.lock().await;
        if self.shutdown.is_cancelled() { return Err(closed()); }
        if let Some(receipt) = self.read_receipt(&token).await? {
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
        self.save_receipt(&token, &receipt).await?;
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
                if let Ok(Some(mut receipt)) = service.read_receipt(&operation).await {
                    // A checkpointed job remains authoritative even if the submit
                    // response failed after upstream transfer.
                    if receipt.job_id.is_none() {
                        receipt.error = Some(Rejection { status: error.status.as_u16(), code: error.code, message: error.message.chars().take(1000).collect() });
                        if let Err(error) = service.save_receipt(&operation, &receipt).await { eprintln!("image receipt: {}", error.code); }
                    }
                }
            }
            active.remove(&operation);
        });
        drop(active);
        self.receipt_value(receipt).await
    }
    pub(super) async fn cancel_request(&self, key: &str, owner: &str, family: &str) -> Result<Value> {
        let token = token(owner, family, key)?;
        let active = self.requests.active.lock().await;
        let mut receipt = self.read_receipt(&token).await?.unwrap_or(Receipt {
            request_key: key.into(), owner: owner.into(), family: family.into(), fingerprint: String::new(),
            epoch: self.requests.epoch.clone(), job_id: None, cancel_requested: true, error: None,
        });
        receipt.cancel_requested = true;
        self.save_receipt(&token, &receipt).await?;
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
            let mut receipt = service.read_receipt(&self.token).await?.ok_or_else(|| ApiError::new(503, "IMAGE_RECEIPT_UNAVAILABLE", "图片接收凭据丢失"))?;
            if receipt.cancel_requested { return Err(inputs::cancelled()); }
            receipt.job_id = Some(value["gatewayJobId"].as_str().ok_or_else(|| ApiError::invalid("缺少图片任务编号"))?.into());
            service.save_receipt(&self.token, &receipt).await
        })
    }
    fn submitting(&self, _: String) -> BoxFuture<'_, Result<()>> { Box::pin(async move { self.check() }) }
    fn observed(&self, _: String, _: Value) -> BoxFuture<'_, Result<()>> { Box::pin(async { Ok(()) }) }
    fn collect(&self, _: Vec<Output>) -> BoxFuture<'_, Result<()>> { Box::pin(async { Ok(()) }) }
}
