use super::{
    Duration, Error, Result, request_body,
    settings::Settings,
    stream::{Prepared, Protocol},
    transport::{self, Request, Transport},
    validation::Input,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

pub(super) struct Ollama {
    slots: Arc<Semaphore>,
    active: Arc<Semaphore>,
    model: Mutex<String>,
}
pub(super) struct Permit {
    _slot: OwnedSemaphorePermit,
    _active: OwnedSemaphorePermit,
}
impl Ollama {
    pub fn new() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(16)),
            active: Arc::new(Semaphore::new(1)),
            model: Mutex::new(String::new()),
        }
    }
    pub fn queue_status(&self) -> Value {
        let active = 1 - self.active.available_permits();
        json!({"name":"ollama-chat","active":active,"pending":(16-self.slots.available_permits()).saturating_sub(active),"maxPending":16})
    }
    async fn models(&self, client: &Transport, settings: &Settings) -> Result<Vec<Value>> {
        let target = target(settings, "/api/tags")?;
        let response = client
            .send(
                target,
                Request {
                    body: None,
                    key: "",
                    session_id: None,
                    public_only: false,
                    idle: Duration::from_secs(3),
                    total: Duration::from_secs(3),
                    accept: "application/json",
                },
            )
            .await?;
        let response =
            transport::success(response, 2 * 1024 * 1024, "Ollama status request failed").await?;
        let mut data: Value =
            serde_json::from_slice(transport::bounded(response, 2 * 1024 * 1024).await?.as_ref())
                .map_err(|_| Error::stream("INVALID_JSON", "Ollama 模型列表不是有效 JSON"))?;
        Ok(data.get_mut("models")
            .and_then(Value::as_array_mut)
            .map(|models| {
                models
                    .drain(..)
                    .filter_map(|item| {
                        let name = name(&item);
                        if name.is_empty() || item["capabilities"].as_array().is_some_and(|caps| {
                            !caps.is_empty() && !caps.iter().any(|v| v == "completion")
                        }) { return None; }
                        let mut model = json!({"name":null,"size":item["size"].as_f64().unwrap_or(0.0),"parameters":item["details"]["parameter_size"].as_str().unwrap_or(""),"quantization":item["details"]["quantization_level"].as_str().unwrap_or("")});
                        model["name"] = name.into();
                        Some(model)
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
    fn preferred(&self, models: &[Value], settings: &Settings) -> String {
        if !settings.ollama_model.is_empty()
            && models.iter().any(|v| v["name"] == settings.ollama_model)
        {
            settings.ollama_model.clone()
        } else {
            models.first().and_then(|v| v["name"].as_str()).unwrap_or_default().into()
        }
    }
    pub async fn status(&self, client: &Transport, settings: &Settings) -> Value {
        let active = self.model.lock().unwrap().clone();
        match self.models(client, settings).await {
            Ok(models) => {
                let mut value = json!({"online":true,"model":self.preferred(&models,settings),"models":null,"queue":null,"activeModel":active});
                value["models"] = Value::Array(models);
                value["queue"] = self.queue_status();
                value
            }
            Err(error) => {
                json!({"online":false,"model":"","models":[],"queue":self.queue_status(),"activeModel":active,"error":error.message})
            }
        }
    }
    pub async fn prepare(
        &self,
        client: &Transport,
        settings: &Settings,
        input: Input,
        admission: Option<&request_body::Admission>,
        cancel: &CancellationToken,
    ) -> Result<Prepared> {
        let started = Instant::now();
        let slot = self.slots.clone().try_acquire_owned().map_err(|_| {
            Error::new(
                503,
                "QUEUE_FULL",
                "队列已满（ollama-chat，上限 16），请稍后再试",
            )
        })?;
        let active = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "聊天已停止")),
            result = tokio::time::timeout(
                Duration::from_secs(180),
                self.active.clone().acquire_owned(),
            ) => result
                .map_err(|_| Error::stream("QUEUE_TIMEOUT", "聊天排队超时，请稍后重试"))?
                .map_err(|_| Error::stream("ABORTED", "聊天已停止"))?,
        };
        let permit = Permit {
            _slot: slot,
            _active: active,
        };
        let wait_ms = started.elapsed().as_millis() as u64;
        let models = self.models(client, settings).await?;
        let selected = if !input.model.is_empty() && models.iter().any(|v| v["name"] == input.model) {
            input.model
        } else {
            self.preferred(&models, settings)
        };
        drop(models);
        if selected.is_empty() {
            return Err(Error::stream(
                "OLLAMA_MODEL_MISSING",
                "Ollama 中没有可用的对话模型",
            ));
        }
        let previous = self.model.lock().unwrap().clone();
        if !previous.is_empty() && previous != selected {
            let unload = request_body::encode(
                json!({"model":previous,"keep_alive":0,"stream":false}),
                None,
                cancel,
            )
            .await?;
            if let Ok(response) = client
                .send(
                    target(settings, "/api/generate")?,
                    Request {
                        body: Some(unload),
                        key: "",
                        session_id: None,
                        public_only: false,
                        idle: Duration::from_secs(8),
                        total: Duration::from_secs(8),
                        accept: "application/json",
                    },
                )
                .await
            {
                let _ = transport::bounded(response, 1024 * 1024).await;
            }
        }
        *self.model.lock().unwrap() = selected.clone();
        let mut body = json!({"model":selected,"stream":true,"think":false,"keep_alive":settings.keep_alive,
            "options":{"temperature":0.72,"top_p":0.88,"repeat_penalty":1.1,"num_predict":settings.num_predict,"num_ctx":settings.num_context}});
        body["messages"] = Value::Array(input.messages);
        let body = request_body::encode(body, admission, cancel).await?;
        let response = client
            .send(
                target(settings, "/api/chat")?,
                Request {
                    body: Some(body),
                    key: "",
                    session_id: None,
                    public_only: false,
                    idle: Duration::from_secs(180),
                    total: Duration::from_secs(600),
                    accept: "application/json",
                },
            )
            .await?;
        let response = transport::success(response, 1024 * 1024, "Ollama 对话失败").await?;
        Ok(Prepared {
            response,
            model: selected,
            wait_ms,
            protocol: Protocol::Ollama,
            permit: Some(permit),
        })
    }
}
fn name(item: &Value) -> String {
    super::persona::string(
        item.get("name")
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            .unwrap_or(&item["model"]),
    )
}
fn target(settings: &Settings, path: &str) -> Result<url::Url> {
    crate::upstream::local_url(&settings.ollama_host)
        .map_err(|_| Error::invalid("Ollama 地址无效"))?
        .join(path)
        .map_err(|_| Error::invalid("Ollama 地址无效"))
}
