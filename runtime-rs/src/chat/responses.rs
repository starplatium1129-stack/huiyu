use super::{
    ChatService, Duration, Error, Result, UpstreamFailure, persona, request_body,
    settings::Settings,
    stream::{Event, Prepared, Protocol, ToolCall},
    transport::{self, Request},
    validation::Input,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
};
use tokio_util::sync::CancellationToken;
use url::Url;

const RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const RESPONSES_ORIGIN: &str = "https://api.openai.com";
const TOOL_NAMESPACE: &str = "huiyu";

pub(super) struct Session {
    chat: Arc<ChatService>,
    runtime: PathBuf,
    client_id: String,
    saved_at: Option<String>,
    pub request_id: Option<String>,
    pub cancel: CancellationToken,
}

impl Session {
    pub async fn recover(&self, error: &Error) -> Result<()> {
        let Some(upstream) = &error.upstream else {
            return Ok(());
        };
        self.chat
            .chatgpt
            .handle_upstream_failure(
                &self.runtime,
                &self.client_id,
                self.saved_at.as_deref(),
                upstream_code(&upstream.body),
            )
            .await
    }
}

pub(super) async fn prepare(
    chat: &Arc<ChatService>,
    settings: &Settings,
    input: Input,
    client_id: Option<&str>,
    admission: Option<&request_body::Admission>,
    cancel: &CancellationToken,
) -> Result<Prepared> {
    if let Some(origin) = &input.tool_result_origin
        && origin != RESPONSES_ORIGIN
    {
        return Err(Error::new(
            409,
            "TOOL_DESTINATION_CHANGED",
            "API 接收地址已改变，工具结果未发送；请重新发起并授权",
        ));
    }

    let client = &chat.transport;
    let session = chat
        .chatgpt
        .ensure_access_token(client, settings, client_id, true, cancel)
        .await?;
    let model = session.model;
    if model.is_empty() {
        return Err(Error::new(
            400,
            "CHATGPT_MODEL_MISSING",
            "请先在聊天设置中选择一个 ChatGPT 模型。",
        ));
    }
    if !input.model.is_empty() && input.model != model {
        return Err(Error::new(
            409,
            "CHATGPT_SELECTION_CHANGED",
            "ChatGPT 模型已切换，请确认后重新发送。",
        ));
    }

    let body = request_body::encode(payload(input, &model), admission, cancel).await?;
    let target = Url::parse(RESPONSES_URL).map_err(|_| Error::invalid("Responses 地址无效"))?;
    let mut context = Session {
        chat: Arc::clone(chat),
        runtime: settings.runtime.clone(),
        client_id: session.client_id,
        saved_at: session.saved_at,
        request_id: None,
        cancel: session.cancel,
    };
    let mut retried = false;
    let response = loop {
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "聊天已停止")),
            _ = context.cancel.cancelled() => return Err(session_ended()),
            result = client.send(target.clone(), Request {
                body: Some(body.clone()),
                key: &session.access_token,
                session_id: None,
                public_only: false,
                idle: Duration::from_secs(120),
                total: Duration::from_secs(600),
                accept: "text/event-stream, application/json",
            }) => result?,
        };
        context.request_id = request_id(response.headers());
        if response.status().is_success() {
            break response;
        }
        let status = response.status().as_u16();
        let retry_delay = response.headers().get("retry-after").map_or(
            Some(Duration::from_millis(500)),
            |value| {
                let seconds = value.to_str().ok()?.parse::<u64>().ok()?;
                (seconds <= 2).then(|| Duration::from_secs(seconds).max(Duration::from_millis(500)))
            },
        );
        let bytes = transport::bounded(response, 64 * 1024).await?;
        let body: Value = serde_json::from_slice(bytes.as_ref()).unwrap_or_default();
        let temporary = status == 503
            && (body.get("detail").is_some()
                || matches!(
                    upstream_code(&body),
                    "subscription_sharing_usage_unavailable"
                        | "subscription_sharing_user_unavailable"
                ));
        if temporary
            && !retried
            && let Some(delay) = retry_delay
        {
            retried = true;
            tokio::select! {
                _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "聊天已停止")),
                _ = context.cancel.cancelled() => return Err(session_ended()),
                _ = tokio::time::sleep(delay) => continue,
            }
        }
        let error = siwc_error(status, body, context.request_id.as_deref());
        context.recover(&error).await?;
        return Err(error);
    };

    Ok(Prepared {
        response,
        model,
        wait_ms: 0,
        protocol: Protocol::ResponsesSse(Box::new(context)),
        permit: None,
        japanese_voice: false,
    })
}

pub(super) fn session_ended() -> Error {
    Error::new(
        401,
        "CHATGPT_REAUTH_REQUIRED",
        "当前 ChatGPT 会话已结束，请检查账号后重试。",
    )
}

fn payload(input: Input, model: &str) -> Value {
    let mut instructions: Option<String> = None;
    let mut items = Vec::new();

    for message in input.messages {
        let role = message["role"].as_str().unwrap_or("");
        match role {
            "system" => {
                let text = message["content"].as_str().unwrap_or("").trim();
                if text.is_empty() {
                    continue;
                }
                if instructions.is_none() {
                    instructions = Some(text.to_owned());
                } else {
                    // SIWC preview rejects role: "system" inside input; use developer role.
                    items.push(json!({
                        "type": "message",
                        "role": "developer",
                        "content": text,
                    }));
                }
            }
            "user" => {
                if let Some(parts) = message["content"].as_array() {
                    let mut content_items = Vec::new();
                    for part in parts {
                        match part["type"].as_str() {
                            Some("text") => {
                                if let Some(text) = part["text"].as_str()
                                    && !text.is_empty()
                                {
                                    content_items.push(json!({
                                        "type": "input_text",
                                        "text": text,
                                    }));
                                }
                            }
                            Some("image_url") => {
                                if let Some(url) = part["image_url"]["url"].as_str()
                                    && !url.is_empty()
                                {
                                    content_items.push(json!({
                                        "type": "input_image",
                                        "image_url": url,
                                        "detail": "auto",
                                    }));
                                }
                            }
                            _ => {}
                        }
                    }
                    if !content_items.is_empty() {
                        items.push(json!({
                            "type": "message",
                            "role": "user",
                            "content": content_items,
                        }));
                    }
                } else if let Some(text) = message["content"].as_str()
                    && !text.is_empty()
                {
                    items.push(json!({
                        "type": "message",
                        "role": "user",
                        "content": text,
                    }));
                }
            }
            "assistant" => {
                if let Some(text) = message["content"].as_str()
                    && !text.is_empty()
                {
                    items.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": text,
                    }));
                }
                if let Some(calls) = message["tool_calls"].as_array() {
                    for call in calls {
                        let call_id = call["id"].as_str().unwrap_or("");
                        let name = call["function"]["name"].as_str().unwrap_or("");
                        let arguments = call["function"]["arguments"].as_str().unwrap_or("{}");
                        if !call_id.is_empty() && !name.is_empty() {
                            items.push(json!({
                                "type": "function_call",
                                "call_id": call_id,
                                "name": name,
                                "namespace": TOOL_NAMESPACE,
                                "arguments": arguments,
                            }));
                        }
                    }
                }
            }
            "tool" => {
                let call_id = message["tool_call_id"].as_str().unwrap_or("");
                let output = message["content"].as_str().unwrap_or("");
                if !call_id.is_empty() {
                    items.push(json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": output,
                    }));
                }
            }
            _ => {}
        }
    }

    // SIWC Responses API requires store: false and stream: true, and forbids unsupported fields.
    let mut body = json!({
        "model": model,
        "input": items,
        "store": false,
        "stream": true,
    });
    if let Some(instructions) = instructions {
        body["instructions"] = Value::String(instructions);
    }
    if matches!(input.reasoning.as_str(), "low" | "medium" | "high") {
        body["reasoning"] = json!({ "effort": input.reasoning });
    }

    let raw_tools = if input.channel_tools {
        persona::channel_tools(input.tools, input.channel_voice)
    } else {
        let mut raw_tools = persona::tools(input.tools, input.web_search);
        if input.card_tools {
            raw_tools.retain(|tool| {
                matches!(
                    tool["function"]["name"].as_str(),
                    Some(
                        "search_web"
                            | "generate_character_image"
                            | "search_drawing_catalog"
                            | "generate_drawing_batch"
                            | "generate_image_from_reference"
                    )
                )
            });
        }
        raw_tools
    };
    if !raw_tools.is_empty() {
        let tools: Vec<Value> = raw_tools
            .into_iter()
            .filter_map(|tool| {
                let function = tool.get("function")?;
                let name = function.get("name")?.as_str()?;
                let description = function
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let parameters = function
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| json!({"type":"object","properties":{}}));
                Some(json!({
                    "type": "function",
                    "name": name,
                    "description": description,
                    "parameters": parameters,
                    "strict": false,
                }))
            })
            .collect();
        if !tools.is_empty() {
            body["tools"] = json!([{
                "type": "namespace",
                "name": TOOL_NAMESPACE,
                "description": "Local Huiyu room and search tools.",
                "tools": tools,
            }]);
        }
    }

    body
}

#[derive(Default)]
struct PendingFunctionCall {
    call_id: String,
    name: String,
    args: String,
}

#[derive(Default)]
pub(super) struct Decoder {
    calls: BTreeMap<usize, PendingFunctionCall>,
    item_indices: HashMap<String, usize>,
    next_index: usize,
    reasoning: String,
    pub completed: bool,
}

impl Decoder {
    pub(super) fn decode(
        &mut self,
        mut event: Value,
        request_id: Option<&str>,
    ) -> Result<Vec<Event>> {
        let kind = event["type"].as_str().unwrap_or("").to_owned();
        match kind.as_str() {
            "response.output_text.delta" | "response.refusal.delta" => {
                if let Some(Value::String(delta)) = event.get_mut("delta")
                    && !delta.is_empty()
                {
                    return Ok(vec![Event::Token {
                        content: std::mem::take(delta),
                    }]);
                }
                Ok(Vec::new())
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(Value::String(delta)) = event.get_mut("delta")
                    && !delta.is_empty()
                {
                    if self.reasoning.len() + delta.len() > 20_000 {
                        return Err(Error::stream("STREAM_BUDGET", "推理过程超限"));
                    }
                    self.reasoning.push_str(delta);
                    return Ok(vec![Event::Reasoning {
                        content: std::mem::take(delta),
                    }]);
                }
                Ok(Vec::new())
            }
            "response.output_item.added" | "response.output_item.done" => {
                if event["item"]["type"].as_str() == Some("function_call") {
                    let index = self.resolve_index(
                        event.get("output_index").and_then(Value::as_u64),
                        event["item"]["id"].as_str(),
                    )?;
                    let entry = self.calls.entry(index).or_default();
                    if let Some(call_id) = event["item"]["call_id"].as_str()
                        && !call_id.is_empty()
                    {
                        if persona::length(call_id) > 128 {
                            return Err(Error::stream("STREAM_BUDGET", "工具 ID 超限"));
                        }
                        entry.call_id = call_id.to_owned();
                    }
                    if let Some(name) = event["item"]["name"].as_str()
                        && !name.is_empty()
                    {
                        if persona::length(name) > 128 {
                            return Err(Error::stream("STREAM_BUDGET", "工具名称超限"));
                        }
                        entry.name = name.to_owned();
                    }
                    if let Some(arguments) = event["item"]["arguments"].as_str()
                        && !arguments.is_empty()
                        && (kind == "response.output_item.done" || entry.args.is_empty())
                    {
                        if arguments.len() > 4000 {
                            return Err(Error::stream("STREAM_BUDGET", "工具参数超限"));
                        }
                        entry.args = arguments.to_owned();
                    }
                }
                Ok(Vec::new())
            }
            "response.function_call_arguments.delta" => {
                let index = self.resolve_index(
                    event.get("output_index").and_then(Value::as_u64),
                    event.get("item_id").and_then(Value::as_str),
                )?;
                if let Some(delta) = event["delta"].as_str()
                    && !delta.is_empty()
                {
                    let entry = self.calls.entry(index).or_default();
                    if entry.args.len() + delta.len() > 4000 {
                        return Err(Error::stream("STREAM_BUDGET", "工具参数超限"));
                    }
                    entry.args.push_str(delta);
                }
                Ok(Vec::new())
            }
            "response.function_call_arguments.done" => {
                let index = self.resolve_index(
                    event.get("output_index").and_then(Value::as_u64),
                    event.get("item_id").and_then(Value::as_str),
                )?;
                if let Some(arguments) = event["arguments"].as_str() {
                    if arguments.len() > 4000 {
                        return Err(Error::stream("STREAM_BUDGET", "工具参数超限"));
                    }
                    let entry = self.calls.entry(index).or_default();
                    entry.args = arguments.to_owned();
                }
                if let Some(name) = event["name"].as_str()
                    && !name.is_empty()
                {
                    let entry = self.calls.entry(index).or_default();
                    if entry.name.is_empty() {
                        entry.name = name.to_owned();
                    }
                }
                Ok(Vec::new())
            }
            "response.completed" => {
                if let Some(outputs) = event["response"]["output"].as_array()
                    && self.calls.is_empty()
                {
                    for (idx, item) in outputs.iter().enumerate() {
                        if item["type"].as_str() != Some("function_call") {
                            continue;
                        }
                        if self.calls.len() >= 8 {
                            return Err(Error::stream("STREAM_BUDGET", "工具数量超限"));
                        }
                        let call_id = item["call_id"].as_str().unwrap_or("");
                        let name = item["name"].as_str().unwrap_or("");
                        let args = item["arguments"].as_str().unwrap_or("{}");
                        if persona::length(call_id) > 128
                            || persona::length(name) > 128
                            || args.len() > 4000
                        {
                            return Err(Error::stream("STREAM_BUDGET", "工具调用超限"));
                        }
                        self.calls.insert(
                            idx,
                            PendingFunctionCall {
                                call_id: call_id.to_owned(),
                                name: name.to_owned(),
                                args: args.to_owned(),
                            },
                        );
                    }
                }
                self.completed = true;
                self.finish()
            }
            "response.failed" => {
                let error = event
                    .get_mut("response")
                    .and_then(|response| response.get_mut("error"))
                    .map(Value::take)
                    .unwrap_or_default();
                Err(siwc_error(200, json!({ "error": error }), request_id))
            }
            "response.incomplete" => Err(Error::stream(
                "CHATGPT_INCOMPLETE",
                "ChatGPT 回复未完成即中断，请重试。",
            )),
            "error" => Err(siwc_error(200, event, request_id)),
            _ => Ok(Vec::new()),
        }
    }

    fn resolve_index(&mut self, output_index: Option<u64>, item_id: Option<&str>) -> Result<usize> {
        if let Some(id) = item_id
            && let Some(&existing) = self.item_indices.get(id)
        {
            return Ok(existing);
        }
        let index = match output_index {
            Some(idx) if idx < 32 => idx as usize,
            Some(_) => return Err(Error::stream("STREAM_BUDGET", "工具索引无效")),
            None => {
                let idx = self.next_index;
                self.next_index += 1;
                idx
            }
        };
        if !self.calls.contains_key(&index) && self.calls.len() >= 8 {
            return Err(Error::stream("STREAM_BUDGET", "工具数量超限"));
        }
        if let Some(id) = item_id
            && !id.is_empty()
        {
            self.item_indices.insert(id.to_owned(), index);
        }
        Ok(index)
    }

    fn finish(&mut self) -> Result<Vec<Event>> {
        for call in self.calls.values() {
            if call.call_id.is_empty() || !persona::known_tool(&call.name) {
                return Err(Error::stream("INVALID_SSE", "工具调用不完整"));
            }
            if !serde_json::from_str::<Value>(&call.args).is_ok_and(|value| value.is_object()) {
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
                id: call.call_id,
                name: call.name,
                arguments: call.args,
                reasoning,
                thought_signature: None,
            })));
        }
        events.push(Event::Done);
        Ok(events)
    }
}

pub(super) fn request_id(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("openai-request-id")
        .or_else(|| headers.get("x-request-id"))
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(str::to_owned)
}

fn upstream_error(body: &Value) -> &Value {
    body.get("error")
        .filter(|value| value.is_object())
        .unwrap_or(body)
}

pub(super) fn upstream_code(body: &Value) -> &str {
    upstream_error(body)["code"].as_str().unwrap_or("")
}

pub(super) fn siwc_error(status: u16, body: Value, request_id: Option<&str>) -> Error {
    let error = upstream_error(&body);
    let raw_code = upstream_code(&body);
    let param = error["param"].as_str().filter(|value| !value.is_empty());
    let (http_status, code, mut message) = match raw_code {
        "subscription_sharing_usage_limit_exceeded" => (
            429,
            "CHATGPT_USAGE_LIMIT",
            "ChatGPT 订阅额度已达上限，请前往 ChatGPT 用量设置查看或调整限额。".to_owned(),
        ),
        "subscription_sharing_user_not_eligible" => (
            403,
            "CHATGPT_NOT_ELIGIBLE",
            "当前 ChatGPT 账号或工作区暂不支持订阅额度共享。".to_owned(),
        ),
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => (
            503,
            "CHATGPT_USAGE_UNAVAILABLE",
            "ChatGPT 额度服务暂时不可用，凭据已保留，请稍后重试。".to_owned(),
        ),
        "subscription_sharing_unsupported_capability" => {
            let suffix = param
                .map(|p| format!("（不支持的参数或能力：{p}）"))
                .unwrap_or_default();
            (
                400,
                "CHATGPT_UNSUPPORTED_CAPABILITY",
                format!(
                    "当前请求包含 ChatGPT 订阅通道暂不支持的能力或模型{suffix}，请调整设置或切换模型。"
                ),
            )
        }
        "subscription_sharing_route_not_supported" => (
            403,
            "CHATGPT_ROUTE_UNSUPPORTED",
            "该请求路径不受 ChatGPT 订阅额度通道支持。".to_owned(),
        ),
        "subscription_sharing_invalid_user" => (
            401,
            "CHATGPT_REAUTH_REQUIRED",
            "ChatGPT 登录状态无效或已断开，请在聊天设置中重新登录。".to_owned(),
        ),
        "chatpass_v2_scope_not_authorized" | "chatpass_v2_invalid_authorization_context" => (
            403,
            "CHATGPT_SCOPE_DENIED",
            "当前授权未包含 ChatGPT 订阅额度权限，请在聊天设置中重新授权。".to_owned(),
        ),
        "context_length_exceeded" => (
            400,
            "UPSTREAM_CONTEXT_LIMIT",
            "对话长度超过模型上下文限制，请开启新分支或缩短输入。".to_owned(),
        ),
        "rate_limit_exceeded" => (
            429,
            "CHATGPT_RATE_LIMIT",
            "ChatGPT 请求过于频繁，请稍后重试。".to_owned(),
        ),
        _ => match status {
            401 => (
                401,
                "CHATGPT_REAUTH_REQUIRED",
                "ChatGPT 登录认证未通过，请检查账号或重新登录。".to_owned(),
            ),
            403 => (
                403,
                "CHATGPT_FORBIDDEN",
                "OpenAI 拒绝了本次订阅额度请求，请检查账号权限、可用地区或订阅状态。".to_owned(),
            ),
            429 => (
                429,
                "CHATGPT_RATE_LIMIT",
                "ChatGPT 请求暂时受限，请稍后重试或查看用量。".to_owned(),
            ),
            400 | 422 => (
                400,
                "CHATGPT_BAD_REQUEST",
                "ChatGPT 拒绝了本次请求参数，请核对所选模型或关闭暂不支持的功能。".to_owned(),
            ),
            200 => (
                503,
                "CHATGPT_UPSTREAM_ERROR",
                "ChatGPT 在生成回复时返回错误，请稍后重试。".to_owned(),
            ),
            _ => (
                503,
                "CHATGPT_UPSTREAM_UNAVAILABLE",
                format!("ChatGPT 推理服务暂不可用（HTTP {status}），请稍后重试。"),
            ),
        },
    };
    if let Some(req_id) = request_id {
        message.push_str(&format!("（请求 ID：{req_id}）"));
    }
    let mut error = Error::new(
        if status == 200 { http_status } else { status },
        code,
        message,
    );
    error.upstream = Some(Box::new(UpstreamFailure {
        status,
        request_id: request_id.map(str::to_owned),
        body,
    }));
    error
}
