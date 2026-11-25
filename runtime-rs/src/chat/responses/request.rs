use super::TOOL_NAMESPACE;
use super::super::{persona, validation::Input};
use serde_json::{Value, json};

pub(super) fn payload(input: Input, model: &str) -> Value {
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
                            | "huiyu_drawing"
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
