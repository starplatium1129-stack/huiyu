use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

const BLOCKING_THRESHOLD: usize = 512 * 1024;

pub(super) struct Decoder {
    slots: Arc<Semaphore>,
    workers: TaskTracker,
    closed: std::sync::Mutex<bool>,
    #[cfg(test)]
    registration_pause: std::sync::Mutex<Option<RegistrationPause>>,
}
#[cfg(test)]
struct RegistrationPause {
    entered: tokio::sync::oneshot::Sender<()>,
    resume: tokio::sync::oneshot::Receiver<()>,
}
impl Default for Decoder {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(2)),
            workers: TaskTracker::new(),
            closed: std::sync::Mutex::new(false),
            #[cfg(test)]
            registration_pause: std::sync::Mutex::new(None),
        }
    }
}
pub(super) struct WebuiImage {
    pub bytes: Vec<u8>,
    pub seed: Option<u64>,
}
fn cancelled(request: &CancellationToken, shutdown: &CancellationToken) -> Result<()> {
    if shutdown.is_cancelled() {
        Err(closed())
    } else if request.is_cancelled() {
        Err(ApiError::new(499, "ABORT_ERR", "上游解码已取消"))
    } else {
        Ok(())
    }
}
impl Decoder {
    async fn run<T: Send + 'static>(
        &self,
        size: usize,
        request: &CancellationToken,
        shutdown: &CancellationToken,
        decode: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        cancelled(request, shutdown)?;
        if self.slots.is_closed() {
            return Err(closed());
        }
        if size < BLOCKING_THRESHOLD {
            let _work = {
                let closing = self.closed.lock().unwrap();
                if *closing {
                    return Err(closed());
                }
                self.workers.token()
            };
            let result = decode();
            cancelled(request, shutdown)?;
            return result;
        }
        let scope = request.child_token();
        let _scope = scope.clone().drop_guard();
        let permit = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return Err(closed()),
            _ = scope.cancelled() => return Err(ApiError::new(499, "ABORT_ERR", "上游解码已取消")),
            permit = self.slots.clone().acquire_owned() => permit.map_err(|_| closed())?,
        };
        let worker_scope = scope.clone();
        let worker_shutdown = shutdown.clone();
        #[cfg(test)]
        {
            let pause = self.registration_pause.lock().unwrap().take();
            if let Some(pause) = pause {
                let _ = pause.entered.send(());
                let _ = pause.resume.await;
            }
        }
        // CPU work cannot be forcibly stopped. Its permit stays with the worker,
        // including after its caller disconnects, until bounded decoding ends.
        let worker = {
            let closing = self.closed.lock().unwrap();
            if *closing {
                return Err(closed());
            }
            // Registration and tracker closure share this scope. TaskTracker
            // permits registration after close, so checking its state alone
            // would let shutdown miss a worker admitted just before closure.
            self.workers.spawn_blocking(move || {
                let _permit = permit;
                cancelled(&worker_scope, &worker_shutdown)?;
                let result = decode();
                cancelled(&worker_scope, &worker_shutdown)?;
                result
            })
        };
        let result = tokio::select! {
            biased;
            _ = shutdown.cancelled() => return Err(closed()),
            _ = scope.cancelled() => return Err(ApiError::new(499, "ABORT_ERR", "上游解码已取消")),
            result = worker => result.map_err(|_| ApiError::new(502, "UPSTREAM_DECODE_FAILED", "上游解码未完成"))?,
        };
        cancelled(request, shutdown)?;
        result
    }
    pub async fn close(&self) {
        {
            let mut closing = self.closed.lock().unwrap();
            *closing = true;
            self.slots.close();
            self.workers.close();
        }
        self.workers.wait().await;
    }
    pub async fn json(
        &self,
        provider: &str,
        status: u16,
        bytes: Vec<u8>,
        request: &CancellationToken,
        shutdown: &CancellationToken,
    ) -> Result<Value> {
        if bytes.len() > constants::MAX_JSON {
            return Err(ApiError::new(
                502,
                "UPSTREAM_RESPONSE_TOO_LARGE",
                "上游响应过大",
            ));
        }
        let webui = provider == "webui";
        let size = if webui { bytes.len() } else { 0 };
        self.run(size, request, shutdown, move || {
            if bytes.is_empty() {
                Ok(Value::Null)
            } else if !(200..300).contains(&status) {
                Ok(serde_json::from_slice(&bytes).unwrap_or_else(|_| {
                    Value::String(String::from_utf8(bytes).unwrap_or_else(|error| {
                        String::from_utf8_lossy(error.as_bytes()).into_owned()
                    }))
                }))
            } else {
                serde_json::from_slice(&bytes).map_err(|_| {
                    ApiError::new(
                        502,
                        if webui {
                            "INVALID_UPSTREAM_RESPONSE"
                        } else {
                            "COMFY_INVALID_RESPONSE"
                        },
                        "上游返回无效 JSON",
                    )
                })
            }
        })
        .await
    }
    pub async fn image(&self, mut value: Value, cancel: &CancellationToken) -> Result<WebuiImage> {
        let image = value
            .get_mut("images")
            .and_then(Value::as_array_mut)
            .and_then(|images| images.first_mut())
            .map(Value::take);
        let Some(Value::String(image)) =
            image.filter(|image| image.as_str().is_some_and(|s| !s.is_empty()))
        else {
            return Err(ApiError::new(502, "SD_NO_IMAGE", "WebUI 未返回图片"));
        };
        let info = value
            .get_mut("info")
            .map(Value::take)
            .unwrap_or(Value::Null);
        let size = image
            .len()
            .saturating_add(info.as_str().map(str::len).unwrap_or(0));
        if size > constants::MAX_JSON {
            return Err(ApiError::new(
                502,
                "UPSTREAM_RESPONSE_TOO_LARGE",
                "上游响应过大",
            ));
        }
        self.run(size, cancel, cancel, move || {
            let bytes = STANDARD
                .decode(image)
                .map_err(|_| ApiError::new(502, "SD_INVALID_IMAGE", "WebUI 返回无效图片编码"))?;
            let info = match info {
                Value::String(text) => serde_json::from_str::<Value>(&text).unwrap_or(Value::Null),
                info => info,
            };
            Ok(WebuiImage {
                bytes,
                seed: info["seed"]
                    .as_u64()
                    .filter(|s| *s <= 9_007_199_254_740_991),
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests;
