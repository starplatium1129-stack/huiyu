use super::{
    Duration, Error, Result, persona, request_body,
    settings::Settings,
    stream::{Prepared, Protocol},
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
    let body = request_body::encode(payload(input, &api), cancel).await?;
    let response = client
        .send(
            target(&api, &api.pathname)?,
            Request {
                body: Some(body),
                key: &api.key,
                public_only,
                idle: Duration::from_secs(120),
                total: Duration::from_secs(600),
                accept: "text/event-stream, application/json",
            },
        )
        .await?;
    let response = transport::success(response, 64 * 1024, "自定义 API 返回").await?;
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
        value["tools"] = json!(tools);
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
                public_only: false,
                idle: Duration::from_secs(15),
                total: Duration::from_secs(15),
                accept: "application/json",
            },
        )
        .await?;
    let response = transport::success(response, 2 * 1024 * 1024, "API 连接测试返回").await?;
    let data: Value = serde_json::from_slice(&transport::bounded(response, 2 * 1024 * 1024).await?)
        .map_err(|_| Error::stream("INVALID_MODEL_LIST", "模型列表不是有效 JSON"))?;
    let items = data["data"]
        .as_array()
        .or_else(|| data["models"].as_array())
        .ok_or_else(|| Error::stream("INVALID_MODEL_LIST", "接口没有返回模型列表"))?;
    let mut models = Vec::new();
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
            || models.iter().any(|model| model == id)
        {
            continue;
        }
        models.push(id.to_owned());
        if models.len() >= 1000 {
            break;
        }
    }
    Ok(
        json!({"ok":true,"online":true,"vendor":api.vendor,"modelCount":models.len(),"models":models}),
    )
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
    calls: std::collections::BTreeMap<usize, Tool>,
    reasoning: String,
    pub terminal: bool,
    pub malformed: bool,
}
impl Decoder {
    pub fn decode(&mut self, event: &Value) -> Result<Vec<Value>> {
        if event.get("error").is_some_and(|error| !error.is_null()) {
            return Err(Error::stream("INVALID_SSE", "自定义 API 返回了流错误"));
        }
        let Some(choice) = event["choices"].as_array().and_then(|v| v.first()) else {
            return Ok(Vec::new());
        };
        let source = if choice["delta"]["tool_calls"].is_array() {
            &choice["delta"]["tool_calls"]
        } else {
            &choice["message"]["tool_calls"]
        };
        if let Some(deltas) = source.as_array() {
            for (position, delta) in deltas.iter().enumerate() {
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
                if let Some(signature) = delta["extra_content"]["google"].get("thought_signature") {
                    let signature = signature
                        .as_str()
                        .filter(|value| !value.is_empty() && value.len() <= 64 * 1024)
                        .ok_or_else(|| Error::stream("INVALID_SSE", "工具思考签名格式无效"))?;
                    call.thought_signature = Some(signature.into());
                }
                if let Some(id) = delta["id"].as_str() {
                    if persona::length(id) > 128 {
                        return Err(Error::stream("STREAM_BUDGET", "工具 ID 超限"));
                    }
                    if !id.is_empty() {
                        call.id = id.into();
                    }
                }
                if let Some(function) = delta.get("function") {
                    if function.get("arguments").is_some_and(|v| !v.is_string()) {
                        return Err(Error::stream("INVALID_SSE", "工具参数格式无效"));
                    }
                    let args = function["arguments"].as_str().unwrap_or("");
                    let name = persona::string(&function["name"]);
                    if call.args.len() + args.len() > 4000
                        || persona::length(&call.name) + persona::length(&name) > 128
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
        let mut events = Vec::new();
        let reasoning = choice["delta"]["reasoning_content"]
            .as_str()
            .or_else(|| choice["delta"]["reasoning"].as_str())
            .or_else(|| choice["message"]["reasoning_content"].as_str())
            .or_else(|| choice["message"]["reasoning"].as_str())
            .unwrap_or("");
        if !reasoning.is_empty() {
            if self.reasoning.len() + reasoning.len() > 20000 {
                return Err(Error::stream("STREAM_BUDGET", "推理过程超限"));
            }
            self.reasoning.push_str(reasoning);
            events.push(json!({"type":"reasoning","content":reasoning}));
        }
        let content = choice["delta"]["content"]
            .as_str()
            .or_else(|| choice["message"]["content"].as_str())
            .or_else(|| choice["text"].as_str())
            .unwrap_or("");
        if !content.is_empty() {
            events.push(json!({"type":"token","content":content}));
        }
        Ok(events)
    }
    pub fn finish(&self) -> Result<Vec<Value>> {
        // Validate the entire batch before publishing any effectful tool request.
        for call in self.calls.values() {
            if call.id.is_empty() || !persona::known_tool(&call.name) {
                return Err(Error::stream("INVALID_SSE", "工具调用不完整"));
            }
            if !serde_json::from_str::<Value>(&call.args).is_ok_and(|v| v.is_object()) {
                return Err(Error::stream("INVALID_SSE", "工具参数不完整"));
            }
        }
        let mut events = self.calls.iter().map(|(index, call)| {
            let mut event = json!({"type":"tool-call","index":index,"id":call.id,"name":call.name,"arguments":call.args,"reasoning":self.reasoning});
            if let Some(signature) = &call.thought_signature { event["thoughtSignature"] = json!(signature); }
            event
        }).collect::<Vec<_>>();
        events.push(json!({"type":"done"}));
        Ok(events)
    }
}
