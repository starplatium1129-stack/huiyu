use super::{
    Duration, Error, Result, persona,
    settings::Settings,
    stream::{Prepared, Protocol},
    transport::{self, Request, Transport},
    validation::{Api, ApiSource, Input},
};
use serde_json::{Value, json};

pub(super) async fn prepare(
    client: &Transport,
    settings: &Settings,
    input: &Input,
    remote: bool,
) -> Result<Prepared> {
    let source = input.api.as_ref().unwrap();
    let api = match source {
        ApiSource::Host => settings.read_host().await.ok_or_else(|| {
            Error::new(
                400,
                "HOST_CONFIG_MISSING",
                "站主尚未配置 API，请在控制面板的聊天设置中保存",
            )
        })?,
        ApiSource::Personal(api) => api.clone(),
    };
    let body = payload(input, &api);
    let response = client
        .send(
            target(&api, &api.pathname)?,
            Request {
                body: Some(&body),
                key: &api.key,
                public_only: remote && matches!(source, ApiSource::Personal(_)),
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
pub(super) fn payload(input: &Input, api: &Api) -> Value {
    let mut value = json!({"model":api.model,"messages":input.messages,"stream":true});
    if api.vendor == "deepseek" {
        value["thinking"] = json!({"type":if input.reasoning=="off"{"disabled"}else{"enabled"}});
        if input.reasoning != "off" {
            value["reasoning_effort"] = json!(if input.reasoning == "low" {
                "high"
            } else {
                "max"
            });
        }
    } else if api.vendor == "opencode" && !input.reasoning.is_empty() && input.reasoning != "off" {
        value["reasoning_effort"] = json!(input.reasoning);
    }
    if input.web_search {
        if api.model.to_lowercase().starts_with("gemini-") {
            value["tools"] = json!([{"google_search":{}}]);
        } else if ["deepseek", "opencode"].contains(&api.vendor.as_str()) {
            value["web_search"] = json!(true);
        }
    }
    if input.tools {
        value["tools"] = persona::TOOLS.clone();
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
    let response = transport::success(response, 512 * 1024, "API 连接测试返回").await?;
    let data: Value = serde_json::from_slice(&transport::bounded(response, 512 * 1024).await?)
        .map_err(|_| Error::stream("INVALID_JSON", "模型列表不是有效 JSON"))?;
    let models = data["data"]
        .as_array()
        .or_else(|| data["models"].as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    persona::string(
                        item.get("id")
                            .filter(|v| v.as_str().is_some_and(|v| !v.is_empty()))
                            .unwrap_or(&item["name"]),
                    )
                    .trim()
                    .to_owned()
                })
                .filter(|s| !s.is_empty())
                .take(200)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
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
        let mut events=self.calls.iter().map(|(index,call)|json!({"type":"tool-call","index":index,"id":call.id,"name":call.name,"arguments":call.args,"reasoning":self.reasoning})).collect::<Vec<_>>();
        events.push(json!({"type":"done"}));
        Ok(events)
    }
}
