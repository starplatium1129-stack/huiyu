use super::{Error, Result, validation::Api};
use serde_json::{Value, json};
use std::{env, path::PathBuf};
use tokio::io::AsyncWriteExt;

pub(super) struct Settings {
    pub runtime: PathBuf,
    pub ollama_host: String,
    pub ollama_model: String,
    pub keep_alive: String,
    pub num_predict: u64,
    pub num_context: u64,
}
impl Settings {
    pub async fn read(config: &crate::config::Config) -> Self {
        let runtime = config.runtime_root.clone();
        let saved: Value = match tokio::fs::read(runtime.join("config.json")).await {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        };
        let host = env::var("OLLAMA_HOST")
            .ok()
            .or_else(|| saved["ollamaHost"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "http://127.0.0.1:11434".into());
        let host = crate::upstream::local_url(&host)
            .map(|url| url.to_string())
            .unwrap_or_else(|_| "http://127.0.0.1:11434".into());
        Self {
            runtime,
            ollama_host: host,
            ollama_model: env::var("OLLAMA_MODEL")
                .ok()
                .or_else(|| saved["ollamaModel"].as_str().map(str::to_owned))
                .unwrap_or_default(),
            keep_alive: env::var("OLLAMA_KEEP_ALIVE").unwrap_or_else(|_| "10m".into()),
            num_predict: number("OLLAMA_NUM_PREDICT", 300, 32, 2048),
            num_context: number("OLLAMA_NUM_CTX", 4096, 1024, 32768),
        }
    }
    fn file(&self) -> PathBuf {
        self.runtime.join("state/chat_api_config.json")
    }
    pub async fn read_host(&self) -> Option<Api> {
        let bytes = tokio::fs::read(self.file()).await.ok()?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        let base_url = value["baseUrl"].as_str()?.trim().to_owned();
        let model = value["model"].as_str()?.trim().to_owned();
        if base_url.is_empty() || model.is_empty() {
            return None;
        }
        let pathname = value["pathname"]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                url::Url::parse(&(base_url.trim_end_matches('/').to_owned() + "/"))
                    .ok()?
                    .join("chat/completions")
                    .ok()
                    .map(|v| v.path().into())
            })?;
        Some(Api {
            vendor: if base_url.contains("api.deepseek.com") {
                "deepseek"
            } else if base_url.contains("opencode.ai") {
                "opencode"
            } else {
                "custom"
            }
            .into(),
            base_url,
            pathname,
            model,
            key: value["apiKey"].as_str().unwrap_or("").trim().into(),
        })
    }
    pub async fn write_host(&self, api: &Api) -> Result<()> {
        let file = self.file();
        let parent = file.parent().unwrap();
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| io_error())?;
        let temp = parent.join(format!("chat_api_config.{}.tmp", uuid::Uuid::new_v4()));
        let result=async {
            let mut options=tokio::fs::OpenOptions::new();options.write(true).create_new(true);
            #[cfg(unix)] {options.mode(0o600);}
            let mut output=options.open(&temp).await.map_err(|_|io_error())?;
            let bytes=serde_json::to_vec_pretty(&json!({"baseUrl":api.base_url,"pathname":api.pathname,"model":api.model,"apiKey":api.key})).unwrap();
            output.write_all(&bytes).await.map_err(|_|io_error())?;
            output.flush().await.map_err(|_|io_error())?;
            output.sync_all().await.map_err(|_|io_error())?;
            drop(output);
            tokio::fs::rename(&temp,&file).await.map_err(|_|io_error())
        }.await;
        let _ = tokio::fs::remove_file(temp).await;
        result
    }
    pub async fn delete_host(&self) -> Result<()> {
        match tokio::fs::remove_file(self.file()).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(io_error()),
        }
    }
}
fn number(key: &str, default: u64, min: u64, max: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .map(|v| v.round().clamp(min as f64, max as f64) as u64)
        .unwrap_or(default)
}
fn io_error() -> Error {
    Error::new(503, "HOST_CONFIG_UNAVAILABLE", "聊天托管配置暂不可用")
}
pub(super) fn public(api: Option<&Api>) -> Value {
    match api {
        Some(api) => {
            json!({"ok":true,"configured":true,"baseUrl":api.base_url,"model":api.model,"updatedAt":null})
        }
        None => json!({"ok":true,"configured":false}),
    }
}
