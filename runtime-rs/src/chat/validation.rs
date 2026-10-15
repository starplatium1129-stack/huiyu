use super::{
    Error, Result,
    persona::{self, length, string},
};
use serde_json::{Value, json};
use url::Url;

#[derive(Clone)]
pub(super) struct Api {
    pub base_url: String,
    pub pathname: String,
    pub model: String,
    pub key: String,
    pub vendor: String,
}
pub(super) enum ApiSource {
    Host,
    Personal(Api),
}
pub(super) struct Input {
    pub model: String,
    pub session_id: String,
    pub api: Option<ApiSource>,
    pub tools: bool,
    pub web_search: bool,
    pub reasoning: String,
    pub messages: Vec<Value>,
}

pub(super) fn api(input: &Value) -> Result<Api> {
    parse_api(input, true)
}

// GET /models does not need a selected model. Saving and chatting still do.
pub(super) fn inspect_api(input: &Value) -> Result<Api> {
    parse_api(input, false)
}

pub(super) fn vendor(target: &Url) -> String {
    let host = target.host_str().unwrap_or("");
    match host {
        "api.deepseek.com" => "deepseek",
        "api.openai.com" => "openai",
        "openrouter.ai" if target.path().starts_with("/api/v1/") => "openrouter",
        "api.siliconflow.cn" => "siliconflow",
        "generativelanguage.googleapis.com" if target.path().starts_with("/v1beta/openai/") => {
            "gemini"
        }
        "api.moonshot.cn" | "api.moonshot.ai" => "kimi",
        "dashscope.aliyuncs.com" | "dashscope-intl.aliyuncs.com"
        | "dashscope-us.aliyuncs.com" | "cn-hongkong.dashscope.aliyuncs.com" => "qwen",
        "opencode.ai"
            if target.path().starts_with("/zen/") || target.path().starts_with("/inference/") =>
        {
            "opencode"
        }
        _ if host.ends_with(".maas.aliyuncs.com")
            && target.path().starts_with("/compatible-mode/") =>
        {
            "qwen"
        }
        _ => "custom",
    }
    .into()
}

fn parse_api(input: &Value, require_model: bool) -> Result<Api> {
    let base = string(&input["baseUrl"]).trim().to_owned();
    let model = string(&input["model"]).trim().to_owned();
    let key = string(&input["apiKey"]).trim().to_owned();
    if base.is_empty() || length(&base) > 500 {
        return Err(Error::invalid("API 地址不能为空或过长"));
    }
    if (require_model && model.is_empty()) || length(&model) > 200 {
        return Err(Error::invalid("API 模型名不能为空或过长"));
    }
    if length(&key) > 1000 {
        return Err(Error::invalid("API Key 过长"));
    }
    let mut parsed = Url::parse(&base).map_err(|_| Error::invalid("API 地址格式无效"))?;
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let local = ["127.0.0.1", "localhost", "::1", "[::1]"].contains(&host.as_str());
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local) {
        return Err(Error::invalid(
            "远程 API 必须使用 HTTPS；本机地址可以使用 HTTP",
        ));
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(Error::invalid("API 地址不能包含账号、查询参数或锚点"));
    }
    let path = parsed.path().trim_end_matches('/');
    // Accept a copied chat endpoint without appending it a second time.
    let path = path
        .strip_suffix("/chat/completions")
        .unwrap_or(path)
        .to_owned();
    parsed.set_path(&(path + "/"));
    let target = parsed
        .join("chat/completions")
        .map_err(|_| Error::invalid("API 地址格式无效"))?;
    Ok(Api {
        base_url: target.origin().ascii_serialization(),
        pathname: target.path().into(),
        model,
        key,
        vendor: vendor(&target),
    })
}

fn tool_message(raw: &Value) -> Result<Value> {
    let role = string(&raw["role"]);
    if role == "tool" {
        let id = string(&raw["tool_call_id"]);
        let content = string(&raw["content"]);
        if id.is_empty() || length(&id) > 128 {
            return Err(Error::invalid("工具结果 ID 无效"));
        }
        if length(&content) > 60000 {
            return Err(Error::invalid("工具结果过长"));
        }
        return Ok(json!({"role":"tool","tool_call_id":id,"content":content}));
    }
    let calls = raw["tool_calls"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 8)
        .ok_or_else(|| Error::invalid("assistant 工具调用消息格式错误"))?;
    let content = string(&raw["content"]);
    let reasoning = string(&raw["reasoning_content"]);
    if length(&content) > 1200 {
        return Err(Error::invalid("工具调用消息内容过长"));
    }
    if length(&reasoning) > 20000 {
        return Err(Error::invalid("推理过程过长"));
    }
    let mut output = Vec::new();
    for call in calls {
        let id = string(&call["id"]);
        let name = string(&call["function"]["name"]);
        let args = string(&call["function"]["arguments"]);
        if id.is_empty() || length(&id) > 128 {
            return Err(Error::invalid("工具调用 ID 无效"));
        }
        if !persona::known_tool(&name) {
            return Err(Error::invalid(format!("未知的工具调用：{name}")));
        }
        if length(&args) > 4000 {
            return Err(Error::invalid("工具调用参数过长"));
        }
        let mut item = json!({"id":id,"type":"function","function":{"name":name,"arguments":args}});
        if let Some(signature) = call["extra_content"]["google"].get("thought_signature") {
            let signature = signature
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 64 * 1024)
                .ok_or_else(|| Error::invalid("工具思考签名格式无效"))?;
            item["extra_content"] = json!({"google":{"thought_signature":signature}});
        }
        output.push(item);
    }
    let mut result = json!({"role":"assistant","content":content,"tool_calls":output});
    if !reasoning.is_empty() {
        result["reasoning_content"] = reasoning.into();
    }
    Ok(result)
}

fn multimodal(parts: &mut [Value]) -> Result<Value> {
    if parts.is_empty() || parts.len() > 8 {
        return Err(Error::invalid("多模态消息格式错误"));
    }
    let mut output = Vec::new();
    let mut images = 0;
    for part in parts {
        match part["type"].as_str() {
            Some("text") => {
                let text = string(&part["text"]).trim().to_owned();
                if text.is_empty() || length(&text) > 1200 {
                    return Err(Error::invalid("多模态文本过长"));
                }
                output.push(json!({"type":"text","text":text}));
            }
            Some("image_url") => {
                let url = if let Some(Value::String(url)) = part
                    .get_mut("image_url")
                    .and_then(|image| image.get_mut("url"))
                {
                    std::mem::take(url)
                } else {
                    string(&part["image_url"]["url"])
                };
                if length(&url) > 12 * 1024 * 1024
                    || !["png", "jpeg", "webp", "gif"]
                        .iter()
                        .any(|mime| url.starts_with(&format!("data:image/{mime};base64,")))
                {
                    return Err(Error::invalid("图片消息只接受工作区图片的 data URL"));
                }
                images += 1;
                if images > 4 {
                    return Err(Error::invalid("图片消息过多（单条最多 4 张）"));
                }
                let mut image = json!({"type":"image_url","image_url":{"url":null}});
                image["image_url"]["url"] = url.into();
                output.push(image);
            }
            _ => return Err(Error::invalid("多模态消息包含未知内容类型")),
        }
    }
    Ok(output.into())
}

pub(super) fn chat(body: &mut Value, local: Option<&str>) -> Result<Input> {
    let session_id = match body.get("sessionId") {
        None => uuid::Uuid::new_v4().to_string(),
        Some(Value::String(id))
            if !id.is_empty()
                && id.len() <= 128
                && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)) =>
        {
            id.clone()
        }
        _ => return Err(Error::invalid("聊天会话 ID 格式无效")),
    };
    let character = string(&body["character"]);
    let character = if character.is_empty() {
        "nene"
    } else {
        &character
    };
    if !["nene", "natsume"].contains(&character) && local.is_none() {
        return Err(Error::invalid("不支持的聊天角色"));
    }
    let system = persona::build(character, body, local)?;
    let raw = body
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::invalid("对话记录必须包含 1—24 条消息"))?;
    let mut tools = Vec::new();
    let mut texts = Vec::new();
    for item in raw.iter_mut() {
        let role = string(&item["role"]);
        if role == "tool"
            || (role == "assistant" && item["tool_calls"].as_array().is_some_and(|v| !v.is_empty()))
        {
            tools.push(tool_message(item)?);
        } else {
            texts.push(item);
        }
    }
    let mut kept = Vec::new();
    let mut used = 0;
    for item in texts.into_iter().rev().take(24) {
        let role = string(&item["role"]);
        if role == "user"
            && let Some(parts) = item.get_mut("content").and_then(Value::as_array_mut)
        {
            let mut message = json!({"role":"user","content":null});
            message["content"] = multimodal(parts)?;
            kept.push(message);
            continue;
        }
        let text = string(&item["content"]).trim().to_owned();
        let len = length(&text);
        if !["user", "assistant"].contains(&role.as_str()) || text.is_empty() || len > 1200 {
            return Err(Error::invalid("对话消息格式错误或内容过长"));
        }
        if used + len > 12000 && !kept.is_empty() {
            break;
        }
        used += len;
        kept.push(json!({"role":role,"content":text}));
    }
    if kept.is_empty() && tools.is_empty() {
        return Err(Error::invalid("对话记录必须包含有效的消息"));
    }
    kept.reverse();
    let mut messages = vec![json!({"role":"system","content":system})];
    messages.extend(kept);
    messages.extend(tools);
    let api = if body["provider"] == "api" {
        Some(if body["hostConfig"] == true {
            ApiSource::Host
        } else {
            ApiSource::Personal(api(&body["api"])?)
        })
    } else {
        None
    };
    let reasoning = string(&body["reasoning"]);
    if !reasoning.is_empty() && !["low", "medium", "high", "off"].contains(&reasoning.as_str()) {
        return Err(Error::invalid("推理强度必须是 off / low / medium / high"));
    }
    Ok(Input {
        model: string(&body["model"]),
        session_id,
        api,
        tools: body["companionTools"] == true,
        web_search: body["webSearch"] == true,
        reasoning,
        messages,
    })
}
