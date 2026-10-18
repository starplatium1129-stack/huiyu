//! Minimal acceptance identities shared by browser image and video requests.
use super::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub(crate) struct Requests {
    directory: PathBuf,
    prefix: &'static str,
    subject: &'static str,
    pub epoch: String,
    pub active: Mutex<HashMap<String, CancellationToken>>,
    pub admission: Arc<Semaphore>,
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
    pub fn token(&self, owner: &str, family: &str, key: &str) -> Result<String> {
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
    fn unavailable(&self, message: &str) -> ApiError {
        ApiError::new(
            503,
            &format!("{}_RECEIPT_UNAVAILABLE", self.prefix),
            format!("{}接收凭据{}，不能重新提交", self.subject, message),
        )
    }
    pub async fn read(&self, identity: &str) -> Result<Option<Receipt>> {
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
    pub async fn save(&self, token: &str, receipt: &Receipt) -> Result<()> {
        tokio::fs::create_dir_all(&self.directory).await?;
        for part in [self.directory.parent().unwrap(), self.directory.as_path()] {
            if !tokio::fs::symlink_metadata(part)
                .await
                .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
            {
                return Err(self.unavailable("目录不可用"));
            }
        }
        write_job_record(
            &self.directory.join(format!("{token}.json")),
            &serde_json::to_value(receipt)?,
        )
        .await
    }
}
