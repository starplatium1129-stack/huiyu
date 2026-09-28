use super::*;
use crate::{config::Config, error::ApiError};
use tokio_util::sync::CancellationToken;

// Video rewriting shares the host configuration, transport and Ollama queue.
// It does not borrow persona/tool settings from a conversational chat request.
impl ChatService {
    pub(crate) async fn mechanical_status(
        &self,
        config: &Config,
        cancel: &CancellationToken,
    ) -> crate::error::Result<Value> {
        let work = async {
            let settings = self
                .settings
                .get_or_init(|| settings::Settings::read(config))
                .await;
            if let Some(api) = settings.read_host().await {
                return json!({"available":true,"source":"api","model":api.model,"label":format!("API · {}",api.model)});
            }
            let status = self.ollama.status(&self.transport, settings).await;
            if status["online"] == true
                && status["models"].as_array().is_some_and(|m| !m.is_empty())
            {
                let model = status["model"].as_str().unwrap_or("");
                json!({"available":true,"source":"ollama","model":model,"label":format!("Ollama · {model}")})
            } else {
                json!({"available":false,"source":null,"model":"","label":"","reason":"没有可用的 AI 模型：请在控制面板的聊天设置中配置 API，或启动本地 Ollama。"})
            }
        };
        tokio::select! { value=work=>Ok(value),_=cancel.cancelled()=>Err(cancelled()) }
    }

    pub(crate) async fn mechanical_complete(
        &self,
        config: &Config,
        messages: Vec<Value>,
        cancel: CancellationToken,
    ) -> crate::error::Result<String> {
        let work = async {
            let settings = self
                .settings
                .get_or_init(|| settings::Settings::read(config))
                .await;
            if let Some(api) = settings.read_host().await {
                let target = url::Url::parse(&api.base_url)
                    .and_then(|base| base.join(&api.pathname))
                    .map_err(|_| Error::invalid("站主 API 地址无效"))?;
                let mut body =
                    json!({"model":api.model,"messages":messages,"stream":false,"temperature":0.6});
                if api.vendor == "deepseek" {
                    body["thinking"] = json!({"type":"disabled"});
                }
                let response = self
                    .transport
                    .send(
                        target,
                        transport::Request {
                            body: Some(&body),
                            key: &api.key,
                            public_only: false,
                            idle: Duration::from_secs(120),
                            total: Duration::from_secs(120),
                            accept: "application/json",
                        },
                    )
                    .await?;
                let response = transport::success(response, 64 * 1024, "AI 上游返回").await?;
                let value: Value =
                    serde_json::from_slice(&transport::bounded(response, 1024 * 1024).await?)
                        .map_err(|_| {
                            Error::stream("INVALID_UPSTREAM_JSON", "AI 上游返回了无法解析的响应")
                        })?;
                return value["choices"][0]["message"]["content"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| Error::stream("EMPTY_RESPONSE", "AI 上游返回空内容"));
            }
            let input = validation::Input {
                model: String::new(),
                api: None,
                tools: false,
                web_search: false,
                reasoning: "off".into(),
                messages,
            };
            let prepared = self
                .ollama
                .prepare(&self.transport, settings, &input)
                .await?;
            stream::collect_text(prepared, cancel.clone()).await
        };
        tokio::select! {
            value=work=>value.map_err(|error|ApiError::new(error.status.as_u16(),error.code,error.message)),
            _=cancel.cancelled()=>Err(cancelled()),
        }
    }
}
fn cancelled() -> ApiError {
    ApiError::new(499, "ABORT_ERR", "AI 请求已取消")
}
