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
    pub api: Option<ApiSource>,
    pub tools: bool,
    pub web_search: bool,
    pub reasoning: String,
    pub messages: Vec<Value>,
}

pub(super) fn api(input: &Value) -> Result<Api> {
    let base = string(&input["baseUrl"]).trim().to_owned();
    let model = string(&input["model"]).trim().to_owned();
    let key = string(&input["apiKey"]).trim().to_owned();
    if base.is_empty() || length(&base) > 500 {
        return Err(Error::invalid("API 地址不能为空或过长"));
    }
    if model.is_empty() || length(&model) > 200 {
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
    parsed.set_path(&(parsed.path().trim_end_matches('/').to_owned() + "/"));
    let target = parsed
        .join("chat/completions")
        .map_err(|_| Error::invalid("API 地址格式无效"))?;
    Ok(Api {
        base_url: target.origin().ascii_serialization(),
        pathname: target.path().into(),
        model,
        key,
        vendor: if host == "api.deepseek.com" {
            "deepseek"
        } else if host == "opencode.ai" && target.path().starts_with("/zen/") {
            "opencode"
        } else {
            "custom"
        }
        .into(),
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
        output.push(json!({"id":id,"type":"function","function":{"name":name,"arguments":args}}));
    }
    let mut result = json!({"role":"assistant","content":content,"tool_calls":output});
    if !reasoning.is_empty() {
        result["reasoning_content"] = reasoning.into();
    }
    Ok(result)
}

fn multimodal(parts: &[Value]) -> Result<Value> {
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
                let url = string(&part["image_url"]["url"]);
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
                output.push(json!({"type":"image_url","image_url":{"url":url}}));
            }
            _ => return Err(Error::invalid("多模态消息包含未知内容类型")),
        }
    }
    Ok(output.into())
}

pub(super) fn chat(body: &Value, local: Option<&str>) -> Result<Input> {
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
    let raw = body["messages"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::invalid("对话记录必须包含 1—24 条消息"))?;
    let mut tools = Vec::new();
    let mut texts = Vec::new();
    for item in raw {
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
            && let Some(parts) = item["content"].as_array()
        {
            kept.push(json!({"role":"user","content":multimodal(parts)?}));
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
        api,
        tools: body["companionTools"] == true,
        web_search: body["webSearch"] == true,
        reasoning,
        messages,
    })
}
