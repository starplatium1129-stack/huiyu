use super::errors::siwc_error;
use super::super::{
    Error, Result, persona,
    stream::{Event, ToolCall},
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

#[derive(Default)]
struct PendingFunctionCall {
    call_id: String,
    name: String,
    args: String,
}

#[derive(Default)]
pub(in crate::chat) struct Decoder {
    calls: BTreeMap<usize, PendingFunctionCall>,
    item_indices: HashMap<String, usize>,
    next_index: usize,
    reasoning: String,
    pub completed: bool,
}

impl Decoder {
    pub(in crate::chat) fn has_tool_calls(&self) -> bool {
        !self.calls.is_empty()
    }

    pub(in crate::chat) fn decode(
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
