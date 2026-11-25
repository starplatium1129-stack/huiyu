mod download;
mod transport;
mod uploads;
use super::super::*;
use super::{COMPLETION_HEADER, COMPLETION_WAIT, Completion};
use futures_util::{StreamExt, TryStreamExt, stream};
use reqwest::Method;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use transport::{RECEIPT_LIMIT, header_enabled, read_body};

const UPLOAD_PARALLELISM: usize = 2;

pub(in crate::images) struct Client {
    base: String,
    key: String,
    http: reqwest::Client,
    admission: Arc<Semaphore>,
    uploads: Semaphore,
    completion_supported: AtomicBool,
    reuse_supported: AtomicBool,
}

impl Client {
    pub fn check_family(family: &str) -> Result<()> {
        route(family).map(|_| ())
    }

    pub fn identity(&self) -> Value {
        use sha2::{Digest, Sha256};
        json!({"remote":self.base,"keyHash":hex::encode(Sha256::digest(self.key.as_bytes()))})
    }
    pub fn new(settings: &generation::native::Settings) -> Result<Self> {
        let http = crate::http_client::tune_proxy(reqwest::Client::builder())
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(8)
            .build()
            .map_err(|_| unavailable())?;
        Ok(Self {
            base: settings.remote_url.trim_end_matches('/').to_owned(),
            key: settings.remote_key.clone(),
            http,
            admission: Arc::new(Semaphore::new(4)),
            uploads: Semaphore::new(UPLOAD_PARALLELISM),
            completion_supported: AtomicBool::new(false),
            reuse_supported: AtomicBool::new(false),
        })
    }

    pub fn reserve(&self, cancel: &CancellationToken) -> Result<OwnedSemaphorePermit> {
        if cancel.is_cancelled() {
            return Err(inputs::cancelled());
        }
        self.admission.clone().try_acquire_owned().map_err(|_| {
            ApiError::new(429, "REMOTE_QUEUE_FULL", "远程绘图请求正在准备，请稍后重试")
        })
    }

    pub async fn status(&self, family: &str, cancel: &CancellationToken) -> Result<Value> {
        let mut value = self
            .json(
                Method::GET,
                &format!("/api/{}/status", route(family)?),
                None,
                cancel,
            )
            .await?;
        if value["provider"] != "native" {
            return Err(ApiError::new(
                409,
                "REMOTE_ENGINE_INVALID",
                "远端必须启用本机原生绘图引擎",
            ));
        }
        value["remote"] = json!(true);
        self.reuse_supported
            .store(value["inputReuse"] == true, Ordering::Relaxed);
        Ok(value)
    }

    pub async fn submit(
        &self,
        mut raw: Value,
        input: &Value,
        family: &str,
        originals: &[inputs::Original],
        owner: &str,
        hooks: Option<&dyn ExecutionHooks>,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let route = route(family)?;
        if cancel.is_cancelled() {
            return Err(inputs::cancelled());
        }
        self.prepare_uploads(&mut raw, originals, route, cancel)
            .await?;
        raw["seed"] = input["seed"].clone();
        let key = uuid::Uuid::new_v4().simple().to_string();
        if let Some(hooks) = hooks {
            hooks.checkpoint(json!({"gatewayJobId":key,"provider":"native","effectiveInput":input,"remoteFamily":family})).await?;
            hooks.submitting("native".into()).await?;
        }
        raw["requestKey"] = json!(remote_request_id(&key, owner)?);
        // Do not retry an uncertain POST: the saved key is the sole recovery identity.
        self.json(
            Method::POST,
            &format!("/api/{route}/jobs"),
            Some(&raw),
            cancel,
        )
        .await?;
        if let Some(hooks) = hooks {
            hooks
                .observed(key.clone(), json!({"gatewayJobId":key,"remote":true}))
                .await?;
        }
        Ok(json!({"id":key,"provider":"native","status":"queued"}))
    }

    async fn receipt(
        &self,
        id: &str,
        owner: &str,
        family: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let remote_id = remote_request_id(id, owner)?;
        let value = self
            .json(
                Method::GET,
                &format!("/api/{}/requests/{remote_id}", route(family)?),
                None,
                cancel,
            )
            .await?;
        if value["requestKey"] != remote_id {
            return Err(protocol());
        }
        if value["found"] != true {
            return Err(ApiError::new(
                503,
                "REMOTE_REQUEST_UNKNOWN",
                "远程端未找到原请求，提交结果尚未确认",
            ));
        }
        Ok(value)
    }

    pub async fn job(
        &self,
        id: &str,
        owner: &str,
        family: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let receipt = self.receipt(id, owner, family, cancel).await?;
        Self::job_from_receipt(&receipt, id, family)
    }

    pub async fn wait_for_completion(
        &self,
        id: &str,
        owner: &str,
        family: &str,
        cancel: &CancellationToken,
    ) -> Option<Completion> {
        if !self.completion_supported.load(Ordering::Relaxed) {
            return None;
        }
        let remote_id = remote_request_id(id, owner).ok()?;
        let route = route(family).ok()?;
        let request = self
            .request(
                Method::GET,
                &format!("/api/{route}/requests/{remote_id}/completion?receipt=1&progress=1"),
            )
            .timeout(COMPLETION_WAIT + Duration::from_secs(5));
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return None,
            response = request.send() => response.ok()?,
        };
        if !header_enabled(&response, "x-huiyu-image-protocol")
            || !header_enabled(&response, COMPLETION_HEADER)
        {
            return None;
        }
        match response.status() {
            reqwest::StatusCode::NO_CONTENT => Some(Completion::Signalled),
            status @ (reqwest::StatusCode::OK | reqwest::StatusCode::ACCEPTED) => {
                let receipt = read_body(response, RECEIPT_LIMIT, cancel)
                    .await
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                if let Some(receipt) = receipt
                    && receipt["ok"] == true
                    && receipt["found"] == true
                    && receipt["requestKey"] == remote_id
                    && ((status == reqwest::StatusCode::ACCEPTED && receipt["job"].is_object())
                        || receipt["rejected"].is_object()
                        || (receipt["job"]["upstreamSettled"] == true
                            && receipt["job"]["unknown"] == false))
                {
                    return Some(Completion::Receipt(receipt));
                }
                (status == reqwest::StatusCode::OK).then_some(Completion::Signalled)
            }
            _ => None,
        }
    }

    fn job_from_receipt(receipt: &Value, id: &str, family: &str) -> Result<Value> {
        if let Some(rejected) = receipt["rejected"].as_object() {
            let status = match rejected.get("code").and_then(Value::as_str) {
                Some("IMAGE_REQUEST_CANCELLED" | "CANCELLED") => "cancelled",
                _ => "failed",
            };
            return Ok(
                json!({"id":id,"provider":"native","status":status,"upstreamSettled":true,"unknown":false,"resultAvailable":false,"metadata":{},"code":rejected.get("code"),"error":rejected.get("message")}),
            );
        }
        if receipt["job"].is_null() {
            return Ok(
                json!({"id":id,"provider":"native","status":"queued","upstreamSettled":false,"unknown":false,"resultAvailable":false,"metadata":{},"progressText":"远程端正在准备"}),
            );
        }
        let mut job = receipt["job"].clone();
        if !job.is_object()
            || job["provider"] != "native"
            || !matches!(
                job["status"].as_str(),
                Some("queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled")
            )
            || !job["metadata"].is_object()
        {
            return Err(protocol());
        }
        job["id"] = json!(id);
        let result_url = if job["resultAvailable"] == true {
            Some(format!("/api/{}/jobs/{id}/result", route(family)?))
        } else {
            None
        };
        job["resultUrl"] = json!(result_url);
        job["metadata"]["resultUrl"] = json!(result_url);
        job["metadata"]["remote"] = json!(true);
        Ok(job)
    }

    pub async fn observe(
        &self,
        id: &str,
        owner: &str,
        family: &str,
        completed: Option<Value>,
        cancel: &CancellationToken,
    ) -> Result<Observation> {
        let receipt = match completed {
            Some(receipt) if receipt["requestKey"] == remote_request_id(id, owner)? => receipt,
            _ => self.receipt(id, owner, family, cancel).await?,
        };
        let mut job = Self::job_from_receipt(&receipt, id, family)?;
        let status = job["status"].as_str().ok_or_else(protocol)?.to_owned();
        let settled = job["upstreamSettled"] == true;
        let unknown = job["unknown"] == true;
        let outputs = if status == "succeeded" && settled && !unknown {
            vec![
                self.download_result(&receipt["job"], family, cancel)
                    .await?,
            ]
        } else {
            vec![]
        };
        let mut metadata = job["metadata"].take();
        metadata["gatewayJobId"] = json!(id);
        Ok(Observation {
            status,
            settled,
            unknown,
            error_code: job["code"].as_str().map(str::to_owned),
            metadata,
            outputs,
        })
    }

    pub async fn result(
        &self,
        id: &str,
        owner: &str,
        family: &str,
        cancel: &CancellationToken,
    ) -> Result<Output> {
        let receipt = self.receipt(id, owner, family, cancel).await?;
        self.download_result(&receipt["job"], family, cancel).await
    }

    pub async fn cancel(
        &self,
        id: &str,
        owner: &str,
        family: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let remote_id = remote_request_id(id, owner)?;
        let receipt = self
            .json(
                Method::DELETE,
                &format!("/api/{}/requests/{remote_id}", route(family)?),
                None,
                cancel,
            )
            .await?;
        if receipt["requestKey"] == remote_id && receipt["job"].is_object() {
            return Self::job_from_receipt(&receipt, id, family);
        }
        self.job(id, owner, family, cancel).await
    }
}

fn remote_request_id(id: &str, owner: &str) -> Result<String> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(protocol());
    }
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"huiyu-remote-image-request\0");
    hash.update((owner.len() as u64).to_be_bytes());
    hash.update(owner.as_bytes());
    hash.update(id.as_bytes());
    Ok(hex::encode(&hash.finalize()[..16]))
}

fn route(family: &str) -> Result<&'static str> {
    match family {
        "anima" => Ok("anima"),
        "krea2" => Ok("creative"),
        "qwen-image" => Ok("qwen"),
        "moss-image" => Ok("moss"),
        _ => Err(ApiError::new(
            501,
            "REMOTE_FAMILY_UNSUPPORTED",
            "远程原生绘图暂不支持该任务类型",
        )),
    }
}

fn unavailable() -> ApiError {
    ApiError::new(
        503,
        "REMOTE_UNAVAILABLE",
        "无法连接远程原生绘图服务，请检查地址、端口和网络",
    )
}
fn protocol() -> ApiError {
    ApiError::new(
        502,
        "REMOTE_RESPONSE_INVALID",
        "远程原生绘图服务返回的数据无效",
    )
}
