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
                return complete_api(&self.transport, &api, messages, &cancel).await;
            }
            let input = validation::Input {
                model: String::new(),
                session_id: uuid::Uuid::new_v4().to_string(),
                api: None,
                tool_result_origin: None,
                tools: false,
                web_search: false,
                reasoning: "off".into(),
                messages,
            };
            let prepared = self
                .ollama
                .prepare(&self.transport, settings, input, None, &cancel)
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

// Keep non-conversational calls on the same provider parameter contract.
pub(super) async fn complete_api(
    client: &transport::Transport,
    api: &validation::Api,
    messages: Vec<Value>,
    cancel: &CancellationToken,
) -> Result<String> {
    let target = url::Url::parse(&api.base_url)
        .and_then(|base| base.join(&api.pathname))
        .map_err(|_| Error::invalid("站主 API 地址无效"))?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let input = validation::Input {
        model: api.model.clone(),
        session_id: session_id.clone(),
        api: None,
        tool_result_origin: None,
        tools: false,
        web_search: false,
        reasoning: "off".into(),
        messages,
    };
    let mut body = compatible::payload(input, api);
    body["stream"] = json!(false);
    let body = request_body::encode(body, None, cancel).await?;
    let response = client
        .send(
            target,
            transport::Request {
                body: Some(body),
                key: &api.key,
                session_id: Some(&session_id),
                public_only: false,
                idle: Duration::from_secs(120),
                total: Duration::from_secs(120),
                accept: "application/json",
            },
        )
        .await?;
    let response = transport::success(response, 64 * 1024, "AI 上游返回").await?;
    let mut value: Value =
        serde_json::from_slice(transport::bounded(response, 1024 * 1024).await?.as_ref())
            .map_err(|_| Error::stream("INVALID_UPSTREAM_JSON", "AI 上游返回了无法解析的响应"))?;
    if let Some(error) = compatible::response_error(&value, &api.vendor) {
        return Err(error);
    }
    let content = value
        .get_mut("choices")
        .and_then(Value::as_array_mut)
        .and_then(|choices| choices.first_mut())
        .and_then(|choice| choice.get_mut("message"))
        .and_then(|message| message.get_mut("content"))
        .map(Value::take);
    match content {
        Some(Value::String(content)) if !content.trim().is_empty() => Ok(content),
        _ => Err(Error::stream("EMPTY_RESPONSE", "AI 上游返回空内容")),
    }
}
