use super::{
    Duration, Error, Result, persona, request_body,
    settings::Settings,
    stream::{Event, Prepared, Protocol, ToolCall},
    transport::{self, Request, Transport},
    validation::{Api, ApiSource, Input},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

pub(super) async fn prepare(
    client: &Transport,
    settings: &Settings,
    mut input: Input,
    remote: bool,
    managed_auth: Option<&(String, String)>,
    admission: Option<&request_body::Admission>,
    cancel: &CancellationToken,
) -> Result<Prepared> {
    let source = input.api.take().unwrap();
    let public_only = remote && matches!(&source, ApiSource::Personal(_));
    let mut api = match source {
        ApiSource::Host => settings.read_host().await.ok_or_else(|| {
            Error::new(
                400,
                "HOST_CONFIG_MISSING",
                "站主尚未配置 API，请在控制面板的聊天设置中保存",
            )
        })?,
        ApiSource::Personal(api) => api,
    };
    if let Some((origin, key)) = managed_auth
        && api.model == "huiyu-local"
        && api.base_url == *origin
        && api.pathname == "/v1/chat/completions"
    {
        api.key = key.clone();
    }
    if api.vendor == "openai"
        && (input.tools || input.web_search)
        && ["gpt-6-astra", "gpt-6.1-sol"]
            .iter()
            .any(|model| api.model == *model || api.model.starts_with(&format!("{model}-")))
    {
        return Err(Error::new(
            400,
            "UNSUPPORTED_TOOL_MODEL",
            "此模型的工具调用需要 Responses 协议；请关闭房间工具和联网检索，或改用 GPT-6 Luna",
        ));
    }
    if api.vendor == "kimi"
        && (api.model.starts_with("kimi-k3") || api.model.starts_with("kimi-k2.7-code"))
    {
        return Err(Error::new(
            400,
            "UNSUPPORTED_CHAT_MODEL",
            "此 Kimi 模型需要跨轮完整思考上下文，当前房间尚未接入；请改用 Kimi K2.6",
        ));
    }
    if api.vendor == "deepseek"
        && (input.tools || input.web_search)
        && !input.reasoning.is_empty()
        && input.reasoning != "off"
    {
        return Err(Error::new(
            400,
            "UNSUPPORTED_TOOL_REASONING",
            "DeepSeek 思考工具模式需要跨轮完整思考上下文；请关闭思考，或关闭房间工具和联网检索",
        ));
    }
    let session_id = std::mem::take(&mut input.session_id);
    let body = request_body::encode(payload(input, &api), admission, cancel).await?;
    let response = client
        .send(
            target(&api, &api.pathname)?,
            Request {
                body: Some(body),
                key: &api.key,
                session_id: Some(&session_id),
                public_only,
                idle: Duration::from_secs(120),
                total: Duration::from_secs(600),
                accept: "text/event-stream, application/json",
            },
        )
        .await?;
    let response = transport::success(response, 64 * 1024, "自定义 API 返回")
        .await
        .map_err(|mut error| {
            if error.status.as_u16() == 403 && api.vendor == "opencode"
                && api.pathname.contains("/go/") && api.model == "deepseek-v4.1-flash-free"
            {
                error.message.push_str(" DeepSeek V4.1 Flash Free 当前列在普通 API 通道；请将服务改为 OpenCode Zen，保留 deepseek-v4.1-flash-free 模型，并填写该通道的密钥。");
            }
            error
        })?;
    let sse = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_lowercase().contains("text/event-stream"));
    Ok(Prepared {
        response,
        model: api.model,
        wait_ms: 0,
        protocol: if sse { Protocol::Sse } else { Protocol::Json },
        permit: None,
    })
}
pub(super) fn payload(input: Input, api: &Api) -> Value {
    let mut value = json!({"model":api.model,"stream":true});
    value["messages"] = Value::Array(input.messages);
    let thinking = !input.reasoning.is_empty() && input.reasoning != "off";
    if api.vendor == "deepseek" {
        value["thinking"] = json!({"type":if thinking{"enabled"}else{"disabled"}});
        if thinking {
            value["reasoning_effort"] = json!(match input.reasoning.as_str() {
                "low" => "low",
                "medium" => "high",
                _ => "max",
            });
        }
    } else if api.vendor == "openai"
        && (api.model.starts_with("gpt-6-luna") || api.model.starts_with("gpt-6-sol"))
    {
        // Chat Completions only supports Luna tool calls without reasoning.
        value["reasoning_effort"] = json!(if input.tools || input.web_search || !thinking {
            "none"
        } else {
            &input.reasoning
        });
    } else if api.vendor == "gemini" && api.model.starts_with("gemini-") {
        // Gemini 3 and 2.5 Pro cannot disable thinking. The UI explains that
        // "off" selects their lowest supported effort, never a false "none".
        let cannot_disable =
            api.model.starts_with("gemini-3") || api.model.starts_with("gemini-2.5-pro");
        if thinking {
            value["reasoning_effort"] = json!(input.reasoning);
        } else if cannot_disable {
            value["reasoning_effort"] = json!("low");
        } else if api.model.starts_with("gemini-2.5-") {
            value["reasoning_effort"] = json!("none");
        }
    } else if api.vendor == "qwen" && api.model.starts_with("qwen") {
        value["enable_thinking"] = json!(thinking);
    } else if api.vendor == "kimi" && api.model.starts_with("kimi-k2.6") {
        value["thinking"] = json!({"type":if thinking {"enabled"} else {"disabled"}});
    } else if api.vendor == "opencode" && !input.reasoning.is_empty() && input.reasoning != "off" {
        value["reasoning_effort"] = json!(input.reasoning);
    }
    let tools = persona::tools(input.tools, input.web_search);
    if !tools.is_empty() {
        value["tools"] = Value::Array(tools);
    }
    value
}
pub(super) async fn inspect(client: &Transport, api: &Api) -> Result<Value> {
    let pathname = api
        .pathname
        .strip_suffix("/chat/completions")
        .map(|prefix| format!("{prefix}/models"))
        .unwrap_or_else(|| api.pathname.clone());
    let response = client
        .send(
            target(api, &pathname)?,
            Request {
                body: None,
                key: &api.key,
                session_id: None,
                public_only: false,
                idle: Duration::from_secs(15),
                total: Duration::from_secs(15),
                accept: "application/json",
            },
        )
        .await?;
    let response = transport::success(response, 2 * 1024 * 1024, "API 连接测试返回").await?;
    let data: Value = serde_json::from_slice(transport::bounded(response, 2 * 1024 * 1024).await?.as_ref())
        .map_err(|_| Error::stream("INVALID_MODEL_LIST", "模型列表不是有效 JSON"))?;
    let items = data["data"]
        .as_array()
        .or_else(|| data["models"].as_array())
        .ok_or_else(|| Error::stream("INVALID_MODEL_LIST", "接口没有返回模型列表"))?;
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in items {
        let id = item
            .as_str()
            .or_else(|| item["id"].as_str())
            .or_else(|| item["name"].as_str())
            .unwrap_or("")
            .trim();
        if id.is_empty()
            || persona::length(id) > 200
            || id.chars().any(char::is_control)
            || (!api.key.is_empty() && id.contains(&api.key))
            || !seen.insert(id)
        {
            continue;
        }
        models.push(id.to_owned());
        if models.len() >= 1000 {
            break;
        }
    }
    let mut value = json!({"ok":true,"online":true,"vendor":api.vendor,"modelCount":models.len(),"models":null});
    value["models"] = Value::Array(models.into_iter().map(Value::String).collect());
    Ok(value)
}
fn target(api: &Api, path: &str) -> Result<url::Url> {
    url::Url::parse(&api.base_url)
        .and_then(|base| base.join(path))
        .map_err(|_| Error::invalid("API 地址格式无效"))
}

#[derive(Default)]
struct Tool {
    id: String,
    name: String,
    args: String,
    thought_signature: Option<String>,
}
#[derive(Default)]
pub(super) struct Decoder {
    vendor: String,
    calls: std::collections::BTreeMap<usize, Tool>,
    reasoning: String,
    pub terminal: bool,
    pub malformed: bool,
}
impl Decoder {
    pub fn new(vendor: String) -> Self {
        Self { vendor, ..Self::default() }
    }
    pub fn decode(&mut self, mut event: Value) -> Result<[Option<Event>; 2]> {
        if let Some(error) = response_error(&event, &self.vendor) {
            return Err(error);
        }
        let Some(choice) = event.get_mut("choices").and_then(Value::as_array_mut).and_then(|v| v.first_mut()) else {
            return Ok([None, None]);
        };
        let source = if choice["delta"]["tool_calls"].is_array() {
            "delta"
        } else {
            "message"
        };
        if let Some(deltas) = choice.get_mut(source)
            .and_then(|value| value.get_mut("tool_calls"))
            .and_then(Value::as_array_mut)
        {
            for (position, delta) in deltas.iter_mut().enumerate() {
                let index = match delta.get("index") {
                    None => position,
                    Some(value) => value
                        .as_u64()
                        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
                        .filter(|v| *v < 8)
                        .ok_or_else(|| Error::stream("STREAM_BUDGET", "工具数量或索引无效"))?
                        as usize,
                };
                if index >= 8 {
                    return Err(Error::stream("STREAM_BUDGET", "工具数量或索引无效"));
                }
                let call = self.calls.entry(index).or_default();
                if let Some(signature) = delta.get_mut("extra_content")
                    .and_then(|value| value.get_mut("google"))
                    .and_then(|value| value.get_mut("thought_signature"))
                {
                    let signature = match signature {
                        Value::String(signature) if !signature.is_empty() && signature.len() <= 64 * 1024 => signature,
                        _ => return Err(Error::stream("INVALID_SSE", "工具思考签名格式无效")),
                    };
                    call.thought_signature = Some(std::mem::take(signature));
                }
                if let Some(Value::String(id)) = delta.get_mut("id") {
                    if persona::length(id) > 128 {
                        return Err(Error::stream("STREAM_BUDGET", "工具 ID 超限"));
                    }
                    if !id.is_empty() {
                        call.id = std::mem::take(id);
                    }
                }
                if let Some(function) = delta.get("function") {
                    if function.get("arguments").is_some_and(|v| !v.is_string()) {
                        return Err(Error::stream("INVALID_SSE", "工具参数格式无效"));
                    }
                    let args = function["arguments"].as_str().unwrap_or("");
                    let name_length = match &function["name"] {
                        Value::String(name) => persona::length(name),
                        value => persona::length(&persona::string(value)),
                    };
                    if call.args.len() + args.len() > 4000
                        || persona::length(&call.name) + name_length > 128
                    {
                        return Err(Error::stream("STREAM_BUDGET", "工具参数超限"));
                    }
                    if let Some(name) = function["name"].as_str() {
                        call.name.push_str(name);
                    }
                    call.args.push_str(args);
                }
            }
        }
        if choice["finish_reason"]
            .as_str()
            .is_some_and(|s| ["stop", "length", "tool_calls", "content_filter"].contains(&s))
        {
            self.terminal = true;
        }
        let mut events = [None, None];
        let reasoning = take_string(choice.get_mut("delta").and_then(|v| v.get_mut("reasoning_content")))
            .or_else(|| take_string(choice.get_mut("delta").and_then(|v| v.get_mut("reasoning"))))
            .or_else(|| take_string(choice.get_mut("message").and_then(|v| v.get_mut("reasoning_content"))))
            .or_else(|| take_string(choice.get_mut("message").and_then(|v| v.get_mut("reasoning"))))
            .unwrap_or_default();
        if !reasoning.is_empty() {
            if self.reasoning.len() + reasoning.len() > 20000 {
                return Err(Error::stream("STREAM_BUDGET", "推理过程超限"));
            }
            self.reasoning.push_str(&reasoning);
            events[0] = Some(Event::Reasoning { content: reasoning });
        }
        let content = take_string(choice.get_mut("delta").and_then(|v| v.get_mut("content")))
            .or_else(|| take_string(choice.get_mut("message").and_then(|v| v.get_mut("content"))))
            .or_else(|| take_string(choice.get_mut("text")))
            .unwrap_or_default();
        if !content.is_empty() {
            events[1] = Some(Event::Token { content });
        }
        Ok(events)
    }
    pub fn finish(&mut self) -> Result<Vec<Event>> {
        // Validate the entire batch before publishing any effectful tool request.
        for call in self.calls.values() {
            if call.id.is_empty() || !persona::known_tool(&call.name) {
                return Err(Error::stream("INVALID_SSE", "工具调用不完整"));
            }
            if !serde_json::from_str::<Value>(&call.args).is_ok_and(|v| v.is_object()) {
                return Err(Error::stream("INVALID_SSE", "工具参数不完整"));
            }
        }
        let count = self.calls.len();
        let mut events = Vec::with_capacity(count + 1);
        for (position, (index, call)) in std::mem::take(&mut self.calls).into_iter().enumerate() {
            let reasoning = if position + 1 == count {
                std::mem::take(&mut self.reasoning)
            } else {
                self.reasoning.clone()
            };
            events.push(Event::ToolCall(Box::new(ToolCall {
                index,
                id: call.id,
                name: call.name,
                arguments: call.args,
                reasoning,
                thought_signature: call.thought_signature,
            })));
        }
        events.push(Event::Done);
        Ok(events)
    }
}

fn take_string(value: Option<&mut Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(std::mem::take(value)),
        _ => None,
    }
}

// Some compatible providers return HTTP 200 with a failed choice and partial text.
// Check before consuming content or declaring completion, including non-streaming calls.
pub(super) fn response_error(value: &Value, vendor: &str) -> Option<Error> {
    let choice = &value["choices"][0];
    let error = value.get("error").filter(|error| !error.is_null())
        .or_else(|| choice.get("error").filter(|error| !error.is_null()));
    if error.is_none() && choice["finish_reason"] != "error" { return None; }
    let error = error.unwrap_or(&Value::Null);
    let status = error["code"].as_u64().filter(|code| (400..600).contains(code))
        .map(|code| code as u16).unwrap_or(503);
    Some(transport::upstream_error(status, vendor, error, "API 回复中断"))
}
