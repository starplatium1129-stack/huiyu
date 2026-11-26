use super::{
    Error, Result,
    persona::{self, length, string, trimmed_string},
};
use serde_json::{Value, json};
use url::Url;

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
#[derive(Clone, Default)]
pub(in crate::chat) struct SamplingOptions {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<u32>,
    pub frequency_penalty: Option<f64>,
    pub presence_penalty: Option<f64>,
}

pub(super) struct Input {
    pub model: String,
    pub session_id: String,
    pub api: Option<ApiSource>,
    pub tool_result_origin: Option<String>,
    pub tools: bool,
    pub channel_tools: bool,
    pub channel_voice: bool,
    pub japanese_voice: bool,
    pub card_tools: bool,
    pub web_search: bool,
    pub reasoning: String,
    pub sampling: SamplingOptions,
    pub disable_bubble_split: bool,
    pub matched_lore: Vec<String>,
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
        "dashscope.aliyuncs.com"
        | "dashscope-intl.aliyuncs.com"
        | "dashscope-us.aliyuncs.com"
        | "cn-hongkong.dashscope.aliyuncs.com" => "qwen",
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
    let base = trimmed_string(&input["baseUrl"]);
    let model = trimmed_string(&input["model"]);
    let key = trimmed_string(&input["apiKey"]);
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
        let mut result = json!({"role":"tool","tool_call_id":null,"content":null});
        result["tool_call_id"] = Value::String(id);
        result["content"] = Value::String(content);
        return Ok(result);
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
        let mut item =
            json!({"id":null,"type":"function","function":{"name":null,"arguments":null}});
        item["id"] = Value::String(id);
        item["function"]["name"] = Value::String(name);
        item["function"]["arguments"] = Value::String(args);
        if let Some(signature) = call["extra_content"]["google"].get("thought_signature") {
            let signature = signature
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 64 * 1024)
                .ok_or_else(|| Error::invalid("工具思考签名格式无效"))?;
            item["extra_content"] = json!({"google":{"thought_signature":signature}});
        }
        output.push(item);
    }
    let mut result = json!({"role":"assistant","content":null,"tool_calls":null});
    result["content"] = Value::String(content);
    result["tool_calls"] = Value::Array(output);
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
                let text = trimmed_string(&part["text"]);
                if text.is_empty() || length(&text) > persona::MAX_MESSAGE_LENGTH {
                    return Err(Error::invalid("多模态文本过长"));
                }
                let mut item = json!({"type":"text","text":null});
                item["text"] = Value::String(text);
                output.push(item);
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
                // UTF-16 units cannot exceed UTF-8 bytes.
                if (url.len() > 12 * 1024 * 1024 && length(&url) > 12 * 1024 * 1024)
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

fn bounded_float(value: &Value, min: f64, max: f64, label: &str) -> Result<Option<f64>> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(num) = value.as_f64() else {
        return Err(Error::invalid(format!("{label} 必须是数字")));
    };
    if !num.is_finite() || num < min || num > max {
        return Err(Error::invalid(format!("{label} 超出允许范围（{min} ~ {max}）")));
    }
    Ok(Some(num))
}

fn parse_context_budget(body: &Value) -> Result<(usize, usize)> {
    let Some(budget) = body.get("contextBudget").filter(|v| !v.is_null()) else {
        return Ok((persona::HISTORY_LIMIT, persona::TEXT_LIMIT));
    };
    if !budget.is_object() {
        return Err(Error::invalid("上下文预算格式错误"));
    }
    let max_messages = match budget.get("maxMessages").filter(|v| !v.is_null()) {
        None => persona::HISTORY_LIMIT,
        Some(v) => {
            let n = v.as_u64().ok_or_else(|| Error::invalid("最大消息条数必须是整数"))?;
            if !(8..=persona::MAX_HISTORY_LIMIT as u64).contains(&n) {
                return Err(Error::invalid("最大消息条数必须在 8 到 120 之间"));
            }
            n as usize
        }
    };
    let max_chars = match budget.get("maxChars").filter(|v| !v.is_null()) {
        None => persona::TEXT_LIMIT,
        Some(v) => {
            let n = v.as_u64().ok_or_else(|| Error::invalid("上下文字符预算必须是整数"))?;
            if !(4000..=persona::MAX_TEXT_LIMIT as u64).contains(&n) {
                return Err(Error::invalid("上下文字符预算必须在 4000 到 120000 之间"));
            }
            n as usize
        }
    };
    Ok((max_messages, max_chars))
}

fn parse_sampling(body: &Value) -> Result<SamplingOptions> {
    let Some(sampling) = body.get("sampling").filter(|v| !v.is_null()) else {
        return Ok(SamplingOptions::default());
    };
    if !sampling.is_object() {
        return Err(Error::invalid("采样参数格式错误"));
    }
    let max_tokens = match sampling.get("maxTokens").filter(|v| !v.is_null()) {
        None => None,
        Some(v) => {
            let n = v.as_u64().ok_or_else(|| Error::invalid("最大输出长度必须是整数"))?;
            if !(64..=16384).contains(&n) {
                return Err(Error::invalid("最大输出长度必须在 64 到 16384 之间"));
            }
            Some(n as u32)
        }
    };
    Ok(SamplingOptions {
        temperature: bounded_float(&sampling["temperature"], 0.0, 2.0, "Temperature")?,
        top_p: bounded_float(&sampling["topP"], 0.0, 1.0, "Top P")?,
        max_tokens,
        frequency_penalty: bounded_float(&sampling["frequencyPenalty"], -2.0, 2.0, "Frequency Penalty")?,
        presence_penalty: bounded_float(&sampling["presencePenalty"], -2.0, 2.0, "Presence Penalty")?,
    })
}

fn parse_rp_options(body: &Value, history_limit: usize) -> Result<persona::RpOptions> {
    let mut rp = persona::RpOptions::default();
    if let Some(preset) = body.get("rpPreset").filter(|v| !v.is_null()) {
        if !preset.is_object() {
            return Err(Error::invalid("RP 预设格式错误"));
        }
        let prefix = string(&preset["systemPrefix"]);
        let post = string(&preset["postHistory"]);
        if length(&prefix) > 4000 || length(&post) > 4000 {
            return Err(Error::invalid("RP 预设提示词不能超过 4000 字"));
        }
        rp.system_prefix = prefix;
        rp.post_history = post;
        rp.disable_bubble_split = preset["disableBubbleSplit"] == true;
        rp.status_bar_enabled = preset["statusBarEnabled"] == true;
    }
    if let Some(note) = body.get("authorNote").filter(|v| !v.is_null()) {
        if !note.is_object() {
            return Err(Error::invalid("作者注释格式错误"));
        }
        let text = string(&note["text"]);
        if length(&text) > 2000 {
            return Err(Error::invalid("作者注释不能超过 2000 字"));
        }
        let depth = match note.get("depth").filter(|v| !v.is_null()) {
            None => 2usize,
            Some(v) => v
                .as_u64()
                .filter(|&d| d <= 24)
                .ok_or_else(|| Error::invalid("作者注释深度必须在 0 到 24 之间"))?
                as usize,
        };
        if !text.trim().is_empty() {
            rp.author_note = Some((depth.min(history_limit), text));
        }
    }
    if let Some(aff) = body.get("affection").filter(|v| !v.is_null()) {
        if !aff.is_object() {
            return Err(Error::invalid("好感度参数格式错误"));
        }
        let score = aff["score"]
            .as_u64()
            .filter(|&s| s <= 100)
            .ok_or_else(|| Error::invalid("好感度分值必须在 0 到 100 之间"))? as u8;
        let level = aff["level"]
            .as_u64()
            .filter(|&l| (1..=5).contains(&l))
            .ok_or_else(|| Error::invalid("好感度等级必须在 1 到 5 之间"))? as u8;
        let title = trimmed_string(&aff["title"]);
        let description = trimmed_string(&aff["description"]);
        if title.is_empty() || length(&title) > 32 || length(&description) > 160 {
            return Err(Error::invalid("好感度等级说明格式错误或过长"));
        }
        rp.affection = Some(persona::AffectionContext {
            score,
            level,
            title,
            description,
        });
    }
    if let Some(scene) = body.get("sceneState").filter(|v| !v.is_null()) {
        if !scene.is_object() {
            return Err(Error::invalid("现场状态参数格式错误"));
        }
        let location = trimmed_string(&scene["location"]);
        let outfit = trimmed_string(&scene["outfit"]);
        let mood = trimmed_string(&scene["mood"]);
        if length(&location) > 80 || length(&outfit) > 160 || length(&mood) > 40 {
            return Err(Error::invalid("现场状态字段过长"));
        }
        if !location.is_empty() || !outfit.is_empty() || !mood.is_empty() {
            rp.scene_state = Some(persona::SceneStateContext {
                location,
                outfit,
                mood,
            });
        }
    }
    if let Some(summary) = body.get("storySummary").filter(|v| !v.is_null()) {
        let summary = trimmed_string(summary);
        if length(&summary) > 3000 {
            return Err(Error::invalid("前情提要摘要不能超过 3000 字"));
        }
        rp.story_summary = summary;
    }
    if let Some(raw_lore) = body.get("lorebooks").filter(|v| !v.is_null()) {
        if !raw_lore.is_object() {
            return Err(Error::invalid("世界书参数格式错误"));
        }
        let book: persona::ExternalLorebook = serde_json::from_value(raw_lore.clone())
            .map_err(|_| Error::invalid("世界书条目格式错误"))?;
        if book.entries.len() > 200 {
            return Err(Error::invalid("世界书条目最多 200 条"));
        }
        if book.entries.iter().any(|entry| length(&entry.content) > 4000) {
            return Err(Error::invalid("单条世界书内容不能超过 4000 字"));
        }
        rp.external_lore = Some(book);
    }
    Ok(rp)
}

pub(super) fn chat(
    body: &mut Value,
    local: Option<&str>,
    imported: Option<&persona::CardData>,
) -> Result<Input> {
    let session_id = match body.get("sessionId") {
        None => uuid::Uuid::new_v4().to_string(),
        Some(Value::String(id))
            if !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)) =>
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
    let (history_limit, text_limit) = parse_context_budget(body)?;
    let sampling = parse_sampling(body)?;
    let rp = parse_rp_options(body, history_limit)?;
    let continue_mode = body["continueMode"] == true;
    let disable_bubble_split = rp.disable_bubble_split;
    let mut prompt = persona::build_with_options(
        character,
        body,
        local,
        imported,
        &rp,
        history_limit,
        text_limit,
    )?;
    let matched_lore = std::mem::take(&mut prompt.matched_lore);
    let raw = body
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::invalid("对话记录必须包含有效消息"))?;
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
    for item in texts.into_iter().rev().take(history_limit) {
        let role = string(&item["role"]);
        if role == "user"
            && let Some(parts) = item.get_mut("content").and_then(Value::as_array_mut)
        {
            let mut message = json!({"role":"user","content":null});
            message["content"] = multimodal(parts)?;
            kept.push(message);
            continue;
        }
        let text = trimmed_string(&item["content"]);
        let len = length(&text);
        if !["user", "assistant"].contains(&role.as_str())
            || text.is_empty()
            || len > persona::MAX_MESSAGE_LENGTH
        {
            return Err(Error::invalid("对话消息格式错误或内容过长"));
        }
        if used + len > text_limit && !kept.is_empty() {
            break;
        }
        used += len;
        let mut message = json!({"role":null,"content":null});
        message["role"] = Value::String(role);
        message["content"] = Value::String(text);
        kept.push(message);
    }
    if kept.is_empty() && tools.is_empty() {
        return Err(Error::invalid("对话记录必须包含有效的消息"));
    }
    kept.reverse();
    kept.extend(tools);
    if continue_mode
        && kept
            .last()
            .is_some_and(|msg| msg["role"].as_str() == Some("assistant"))
    {
        kept.push(json!({
            "role": "user",
            "content": "[从你上一条回复末尾的断句处直接无缝续写，绝不重复已写过的句子，保持同一人称、时态、语气与排版格式；若开启了状态栏，只在续写完全结束时输出一次 <status> 块。]"
        }));
    }
    let messages = prompt.messages(kept);
    let api = if body["provider"] == "api" {
        Some(if body["hostConfig"] == true {
            ApiSource::Host
        } else {
            ApiSource::Personal(api(&body["api"])?)
        })
    } else {
        None
    };
    let tool_result_origin = match body.get("toolResultOrigin") {
        None | Some(Value::Null) => None,
        Some(Value::String(origin))
            if origin.len() <= 500
                && Url::parse(origin).is_ok_and(|url| {
                    matches!(url.scheme(), "http" | "https")
                        && url.origin().ascii_serialization() == *origin
                }) =>
        {
            Some(origin.clone())
        }
        _ => return Err(Error::invalid("工具结果的 API 接收地址无效")),
    };
    let reasoning = string(&body["reasoning"]);
    if !reasoning.is_empty() && !["low", "medium", "high", "off"].contains(&reasoning.as_str()) {
        return Err(Error::invalid("推理强度必须是 off / low / medium / high"));
    }
    Ok(Input {
        channel_tools: false,
        channel_voice: false,
        japanese_voice: false,
        card_tools: imported.is_some(),
        model: string(&body["model"]),
        session_id,
        api,
        tool_result_origin,
        tools: body["companionTools"] == true,
        web_search: body["webSearch"] == true,
        reasoning,
        sampling,
        disable_bubble_split,
        matched_lore,
        messages,
    })
}
