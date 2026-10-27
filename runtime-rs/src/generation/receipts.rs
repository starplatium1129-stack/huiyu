//! Durable acceptance transitions shared by browser image and video requests.
use super::*;
use serde::{Deserialize, Serialize};
use std::{future::Future, path::PathBuf};
use tokio::sync::MutexGuard;
use tokio_util::task::TaskTracker;

pub(crate) struct Requests {
    directory: PathBuf,
    prefix: &'static str,
    subject: &'static str,
    pub epoch: String,
    active: Mutex<HashMap<String, CancellationToken>>,
    admission: Arc<Semaphore>,
}
pub(crate) struct Intent {
    token: String,
    key: String,
    owner: String,
    family: String,
}
pub(crate) enum Acceptance<'a> {
    Existing(Receipt),
    New(PendingAcceptance<'a>),
}
pub(crate) struct PendingAcceptance<'a> {
    receipt: Receipt,
    token: String,
    cancel: CancellationToken,
    permit: OwnedSemaphorePermit,
    active: MutexGuard<'a, HashMap<String, CancellationToken>>,
}
impl PendingAcceptance<'_> {
    /// Keep the receipt lock until work is tracked: close() waits on this same
    /// lock before closing the tracker, including the first durable write.
    pub fn spawn<F, Fut>(self, tasks: &TaskTracker, work: F) -> Receipt
    where
        F: FnOnce(String, CancellationToken) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let Self {
            receipt,
            token,
            cancel,
            permit,
            active,
        } = self;
        tasks.spawn(async move {
            let _permit = permit;
            work(token, cancel).await;
        });
        drop(active);
        receipt
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub request_key: String,
    pub owner: String,
    pub family: String,
    pub fingerprint: String,
    pub epoch: String,
    pub job_id: Option<String>,
    pub cancel_requested: bool,
    pub error: Option<Rejection>,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct Rejection {
    pub status: u16,
    pub code: String,
    pub message: String,
}
impl Requests {
    pub fn new(directory: PathBuf, prefix: &'static str, subject: &'static str) -> Self {
        Self {
            directory,
            prefix,
            subject,
            epoch: uuid::Uuid::new_v4().to_string(),
            active: Mutex::new(HashMap::new()),
            admission: Arc::new(Semaphore::new(16)),
        }
    }
    pub async fn wait_for_acceptance(&self) {
        let _active = self.active.lock().await;
    }
    fn token(&self, owner: &str, family: &str, key: &str) -> Result<String> {
        if key.is_empty()
            || key.len() > 160
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        {
            return Err(ApiError::invalid(format!("{}请求编号无效", self.subject)));
        }
        Ok(crate::storage::json_fingerprint(&json!([
            owner, family, key
        ])))
    }
    pub fn intent(&self, key: String, owner: String, family: &str) -> Result<Intent> {
        Ok(Intent {
            token: self.token(&owner, family, &key)?,
            key,
            owner,
            family: family.into(),
        })
    }
    pub async fn status(&self, key: &str, owner: &str, family: &str) -> Result<Option<Receipt>> {
        let token = self.token(owner, family, key)?;
        let _active = self.active.lock().await;
        self.read(&token).await
    }
    pub async fn refresh(&self, mut receipt: Receipt) -> Result<(Receipt, bool)> {
        let token = self.token(&receipt.owner, &receipt.family, &receipt.request_key)?;
        let active = self.active.lock().await;
        // A checkpoint or acceptance may have finished after the caller's read.
        if let Some(latest) = self.read(&token).await? {
            receipt = latest;
        }
        Ok((receipt, active.contains_key(&token)))
    }
    pub async fn begin<'a>(
        &'a self,
        intent: Intent,
        fingerprint: String,
        shutdown: &CancellationToken,
        closed: fn() -> ApiError,
        conflict_message: &str,
    ) -> Result<Acceptance<'a>> {
        let mut active = self.active.lock().await;
        if shutdown.is_cancelled() {
            return Err(closed());
        }
        if let Some(receipt) = self.read(&intent.token).await? {
            if receipt.cancel_requested && receipt.fingerprint.is_empty() {
                return Ok(Acceptance::Existing(receipt));
            }
            if receipt.fingerprint != fingerprint {
                return Err(ApiError::new(
                    409,
                    format!("{}_REQUEST_CONFLICT", self.prefix),
                    conflict_message,
                ));
            }
            // Only a known capacity rejection can re-enter with the same key;
            // accepted or uncertain work retains its original lookup identity.
            if !receipt.error.as_ref().is_some_and(|e| e.status == 429)
                || receipt.cancel_requested
                || active.contains_key(&intent.token)
            {
                return Ok(Acceptance::Existing(receipt));
            }
        }
        let permit = self.admission.clone().try_acquire_owned().map_err(|_| {
            ApiError::new(
                429,
                format!("{}_ACCEPTANCE_BUSY", self.prefix),
                format!("{}接收队列已满，请稍后查询原请求", self.subject),
            )
        })?;
        let cancel = shutdown.child_token();
        let receipt = Receipt {
            request_key: intent.key,
            owner: intent.owner,
            family: intent.family,
            fingerprint,
            epoch: self.epoch.clone(),
            job_id: None,
            cancel_requested: false,
            error: None,
        };
        self.save(&intent.token, &receipt).await?;
        active.insert(intent.token.clone(), cancel.clone());
        Ok(Acceptance::New(PendingAcceptance {
            receipt,
            token: intent.token,
            cancel,
            permit,
            active,
        }))
    }
    pub async fn finish(&self, token: &str, failure: Option<ApiError>) {
        let mut active = self.active.lock().await;
        if let Some(error) = failure
            && let Ok(Some(mut receipt)) = self.read(token).await
            && receipt.job_id.is_none()
        {
            // A checkpointed job remains authoritative after a failed submit
            // response; only a pre-checkpoint failure can become a rejection.
            receipt.error = Some(Rejection {
                status: error.status.as_u16(),
                code: error.code,
                message: error.message.chars().take(1000).collect(),
            });
            if let Err(error) = self.save(token, &receipt).await {
                eprintln!(
                    "{} receipt: {}",
                    self.prefix.to_ascii_lowercase(),
                    error.code
                );
            }
        }
        active.remove(token);
    }
    pub async fn cancel(&self, key: &str, owner: &str, family: &str) -> Result<Receipt> {
        let token = self.token(owner, family, key)?;
        let active = self.active.lock().await;
        let mut receipt = self.read(&token).await?.unwrap_or(Receipt {
            request_key: key.into(),
            owner: owner.into(),
            family: family.into(),
            fingerprint: String::new(),
            epoch: self.epoch.clone(),
            job_id: None,
            cancel_requested: true,
            error: None,
        });
        receipt.cancel_requested = true;
        self.save(&token, &receipt).await?;
        if let Some(cancel) = active.get(&token) {
            cancel.cancel();
        }
        Ok(receipt)
    }
    pub async fn checkpoint(
        &self,
        token: &str,
        cancel: &CancellationToken,
        value: &Value,
        cancelled: fn() -> ApiError,
        missing_job_message: &str,
    ) -> Result<()> {
        let _active = self.active.lock().await;
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        let mut receipt = self.read(token).await?.ok_or_else(|| {
            ApiError::new(
                503,
                format!("{}_RECEIPT_UNAVAILABLE", self.prefix),
                format!("{}接收凭据丢失", self.subject),
            )
        })?;
        if receipt.cancel_requested {
            return Err(cancelled());
        }
        receipt.job_id = Some(
            value["gatewayJobId"]
                .as_str()
                .ok_or_else(|| ApiError::invalid(missing_job_message))?
                .into(),
        );
        self.save(token, &receipt).await
    }
    fn unavailable(&self, message: &str) -> ApiError {
        ApiError::new(
            503,
            &format!("{}_RECEIPT_UNAVAILABLE", self.prefix),
            format!("{}接收凭据{}，不能重新提交", self.subject, message),
        )
    }
    async fn read(&self, identity: &str) -> Result<Option<Receipt>> {
        let path = self.directory.join(format!("{identity}.json"));
        match tokio::fs::symlink_metadata(&path).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Ok(meta)
                if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 16 * 1024 => {}
            _ => return Err(self.unavailable("不可读取")),
        }
        let receipt: Receipt = serde_json::from_slice(&tokio::fs::read(path).await?)
            .map_err(|_| self.unavailable("已损坏"))?;
        if self.token(&receipt.owner, &receipt.family, &receipt.request_key)? != identity {
            return Err(self.unavailable("身份不符"));
        }
        Ok(Some(receipt))
    }
    async fn save(&self, token: &str, receipt: &Receipt) -> Result<()> {
        tokio::fs::create_dir_all(&self.directory).await?;
        for part in [self.directory.parent().unwrap(), self.directory.as_path()] {
            if !tokio::fs::symlink_metadata(part)
                .await
                .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
            {
                return Err(self.unavailable("目录不可用"));
            }
        }
        write_job_record(&self.directory.join(format!("{token}.json")), receipt).await
    }
}
