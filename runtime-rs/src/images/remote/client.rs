use super::super::*;
use super::{COMPLETION_HEADER, COMPLETION_WAIT};
use futures_util::{StreamExt, TryStreamExt, stream};
use reqwest::Method;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const UPLOAD_PARALLELISM: usize = 2;

pub(in crate::images) struct Client {
    base: String,
    key: String,
    http: reqwest::Client,
    admission: Arc<Semaphore>,
    uploads: Semaphore,
    completion_supported: AtomicBool,
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
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| unavailable())?;
        Ok(Self {
            base: settings.remote_url.trim_end_matches('/').to_owned(),
            key: settings.remote_key.clone(),
            http,
            admission: Arc::new(Semaphore::new(4)),
            uploads: Semaphore::new(UPLOAD_PARALLELISM),
            completion_supported: AtomicBool::new(false),
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

    async fn bytes(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        content_type: &str,
        max: usize,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .header("x-token", &self.key)
            .timeout(Duration::from_secs(if path.ends_with("/status") {
                4
            } else {
                60
            }));
        if let Some(body) = body {
            request = request.header("content-type", content_type).body(body);
        }
        let response = tokio::select! {
            _ = cancel.cancelled() => return Err(inputs::cancelled()),
            response = request.send() => response.map_err(|_| unavailable())?,
        };
        if !header_enabled(&response, "x-huiyu-image-protocol") {
            return Err(ApiError::new(
                502,
                "REMOTE_PROTOCOL_MISMATCH",
                "该地址不是兼容的绘遇远程绘图端口",
            ));
        }
        let status = response.status();
        if status.is_success() {
            self.completion_supported.store(
                header_enabled(&response, COMPLETION_HEADER),
                Ordering::Relaxed,
            );
        }
        let length = response.content_length();
        if length.is_some_and(|n| n > max as u64) {
            return Err(ApiError::new(
                502,
                "REMOTE_RESPONSE_INVALID",
                "远程绘图返回的数据过大",
            ));
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::with_capacity(if status.is_success() {
            length.unwrap_or_default() as usize
        } else {
            0
        });
        loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => return Err(inputs::cancelled()),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else { break };
            let chunk = chunk.map_err(|_| unavailable())?;
            if bytes.len().saturating_add(chunk.len()) > max {
                return Err(ApiError::new(
                    502,
                    "REMOTE_RESPONSE_INVALID",
                    "远程绘图返回的数据过大",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let message = value["error"]
                .as_str()
                .unwrap_or("请检查远程绘图服务、地址和连接密钥")
                .replace(&self.key, "[redacted]");
            return Err(ApiError::new(
                status.as_u16(),
                "REMOTE_REQUEST_FAILED",
                message.chars().take(300).collect::<String>(),
            ));
        }
        Ok(bytes)
    }

    async fn json(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let body = body.map(serde_json::to_vec).transpose()?;
        let bytes = self
            .bytes(
                method,
                path,
                body,
                "application/json",
                2 * 1024 * 1024,
                cancel,
            )
            .await?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| protocol())?;
        if value["ok"] != true {
            return Err(protocol());
        }
        Ok(value)
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
        if !originals.is_empty() {
            let path = format!("/api/{route}/images/raw");
            let path = path.as_str();
            let mut uploads = stream::iter(0..originals.len())
                .map(|index| async move {
                    let original = &originals[index];
                    self.upload(original, path, cancel)
                        .await
                        .map(|name| (original.name.as_str(), name))
                })
                .buffer_unordered(UPLOAD_PARALLELISM);
            while let Some((original, name)) = uploads.try_next().await? {
                replace_name(&mut raw, original, &name);
            }
        }
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

    async fn upload(
        &self,
        original: &inputs::Original,
        path: &str,
        cancel: &CancellationToken,
    ) -> Result<String> {
        let _permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(inputs::cancelled()),
            permit = self.uploads.acquire() => permit.map_err(|_| unavailable())?,
        };
        original.input.check()?;
        let bytes = tokio::select! {
            _ = cancel.cancelled() => return Err(inputs::cancelled()),
            bytes = tokio::fs::read(original.input.path()) => bytes?,
        };
        use sha2::{Digest, Sha256};
        original.input.check()?;
        if bytes.len() as u64 != original.input.bytes
            || hex::encode(Sha256::digest(&bytes)) != original.input.hash
        {
            return Err(error("TASK_INPUT_CHANGED", "输入快照发生变化"));
        }
        let uploaded = self
            .bytes(
                Method::POST,
                path,
                Some(bytes),
                "application/octet-stream",
                65536,
                cancel,
            )
            .await?;
        let response: Value = serde_json::from_slice(&uploaded).map_err(|_| protocol())?;
        response["name"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .map(str::to_owned)
            .ok_or_else(protocol)
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
    ) -> bool {
        if !self.completion_supported.load(Ordering::Relaxed) {
            return false;
        }
        let (Ok(remote_id), Ok(route)) = (remote_request_id(id, owner), route(family)) else {
            return false;
        };
        let request = self
            .http
            .get(format!("{}/api/{route}/requests/{remote_id}/completion", self.base))
            .header("x-token", &self.key)
            .timeout(COMPLETION_WAIT + Duration::from_secs(5));
        tokio::select! {
            biased;
            _ = cancel.cancelled() => false,
            response = request.send() => response.is_ok_and(|response|
                response.status() == reqwest::StatusCode::NO_CONTENT
                    && header_enabled(&response, "x-huiyu-image-protocol")
                    && header_enabled(&response, COMPLETION_HEADER)),
        }
    }

    fn job_from_receipt(receipt: &Value, id: &str, family: &str) -> Result<Value> {
        if let Some(rejected) = receipt["rejected"].as_object() {
            return Ok(
                json!({"id":id,"provider":"native","status":"failed","upstreamSettled":true,"unknown":false,"resultAvailable":false,"metadata":{},"code":rejected.get("code"),"error":rejected.get("message")}),
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
        cancel: &CancellationToken,
    ) -> Result<Observation> {
        let receipt = self.receipt(id, owner, family, cancel).await?;
        let job = Self::job_from_receipt(&receipt, id, family)?;
        let status = job["status"].as_str().ok_or_else(protocol)?.to_owned();
        let settled = job["upstreamSettled"] == true;
        let unknown = job["unknown"] == true;
        let outputs = if status == "succeeded" && settled && !unknown {
            vec![self.download_result(&receipt["job"], family, cancel).await?]
        } else {
            vec![]
        };
        let mut metadata = job["metadata"].clone();
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

    async fn download_result(
        &self,
        job: &Value,
        family: &str,
        cancel: &CancellationToken,
    ) -> Result<Output> {
        let job_id = job["id"]
            .as_str()
            .filter(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(protocol)?;
        if job["status"] != "succeeded" {
            return Err(ApiError::new(409, "RESULT_NOT_READY", "远程结果尚未就绪"));
        }
        let bytes = self
            .bytes(
                Method::GET,
                &format!("/api/{}/jobs/{job_id}/result", route(family)?),
                None,
                "",
                32 * 1024 * 1024,
                cancel,
            )
            .await?;
        if crate::image_decode::sniff(&bytes).map(|x| x.0) != Some("image/png") {
            return Err(protocol());
        }
        let bytes = Arc::new(bytes);
        crate::image_decode::validate(bytes.clone(), cancel).await?;
        Ok(Output::Bytes {
            bytes,
            mime: "image/png".into(),
        })
    }

    pub async fn cancel(
        &self,
        id: &str,
        owner: &str,
        family: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let remote_id = remote_request_id(id, owner)?;
        self.json(
            Method::DELETE,
            &format!("/api/{}/requests/{remote_id}", route(family)?),
            None,
            cancel,
        )
        .await?;
        self.job(id, owner, family, cancel).await
    }
}

fn header_enabled(response: &reqwest::Response, header: &str) -> bool {
    response.headers().get(header).is_some_and(|value| value == "1")
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

fn replace_name(input: &mut Value, old: &str, new: &str) {
    for key in ["initImage", "maskImage", "penLines"] {
        if input[key] == old {
            input[key] = json!(new);
        }
    }
    if input["sketchControl"]["image"] == old {
        input["sketchControl"]["image"] = json!(new);
    }
    if let Some(references) = input["referenceImages"].as_array_mut() {
        for value in references {
            if *value == old {
                *value = json!(new);
            }
        }
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
