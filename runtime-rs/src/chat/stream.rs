use super::{Duration, Error, Result, compatible::Decoder, ollama::Permit};
use axum::{
    body::{Body, Bytes},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
mod lines;
use lines::Lines;
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::VecDeque, convert::Infallible};
use tokio_util::sync::CancellationToken;

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub(super) enum Event {
    Meta {
        model: String,
        #[serde(rename = "queueWaitMs")]
        queue_wait_ms: u64,
    },
    Reasoning {
        content: String,
    },
    Token {
        content: String,
    },
    ToolCall(Box<ToolCall>),
    Done,
}
#[derive(Serialize)]
pub(super) struct ToolCall {
    pub(super) index: usize,
    pub(super) id: String,
    pub(super) name: String,
    pub(super) arguments: String,
    pub(super) reasoning: String,
    #[serde(rename = "thoughtSignature", skip_serializing_if = "Option::is_none")]
    pub(super) thought_signature: Option<String>,
}

#[derive(Clone, Copy)]
pub(super) enum Protocol {
    Ollama,
    Sse,
    Json,
}
pub(super) struct Prepared {
    pub response: reqwest::Response,
    pub model: String,
    pub wait_ms: u64,
    pub protocol: Protocol,
    pub permit: Option<Permit>,
}
struct Events {
    lines: Lines,
    protocol: Protocol,
    decoder: Decoder,
    pending: VecDeque<Event>,
    json: String,
    finished: bool,
    shutdown: CancellationToken,
    _permit: Option<Permit>,
}
impl Events {
    async fn next(&mut self) -> Result<Option<Event>> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }
            if self.finished {
                return Ok(None);
            }
            let line = tokio::select! {line=self.lines.next()=>line?,_=self.shutdown.cancelled()=>return Err(Error::stream("ABORTED", "聊天已停止"))};
            match self.protocol {
                Protocol::Ollama => match line {
                    Some(line) if line.trim().is_empty() => {}
                    Some(line) => {
                        let mut item: Value = serde_json::from_str(&line).map_err(|_| {
                            Error::stream(
                                "INVALID_NDJSON",
                                "Ollama returned an invalid stream event",
                            )
                        })?;
                        if item.get("error").is_some_and(|error| !error.is_null()) {
                            return Err(Error::stream("INVALID_NDJSON", "Ollama 返回了流错误"));
                        }
                        if !item.is_object()
                            || item.get("done").is_some_and(|v| !v.is_boolean())
                            || item["message"]
                                .get("content")
                                .is_some_and(|v| !v.is_string())
                        {
                            return Err(Error::stream("INVALID_NDJSON", "Invalid stream fields"));
                        }
                        if let Some(Value::String(content)) = item
                            .get_mut("message")
                            .and_then(|message| message.get_mut("content"))
                            && !content.is_empty()
                        {
                            self.pending.push_back(Event::Token {
                                content: std::mem::take(content),
                            });
                        }
                        if item["done"] == true {
                            self.pending.push_back(Event::Done);
                            self.finished = true;
                        }
                    }
                    None => {
                        return Err(Error::stream(
                            "INCOMPLETE_STREAM",
                            "Ollama stream ended without done",
                        ));
                    }
                },
                Protocol::Sse => {
                    if let Some(line) = line {
                        let Some(payload) = line.trim().strip_prefix("data:").map(str::trim) else {
                            continue;
                        };
                        if payload.is_empty() {
                            continue;
                        }
                        if payload == "[DONE]" {
                            self.decoder.terminal = true;
                            self.finish()?;
                            continue;
                        }
                        match serde_json::from_str::<Value>(payload) {
                            Ok(event) => self
                                .pending
                                .extend(self.decoder.decode(event)?.into_iter().flatten()),
                            Err(_) => self.decoder.malformed = true,
                        }
                    } else {
                        if !self.decoder.terminal {
                            return Err(Error::stream("INVALID_SSE", "自定义 API 返回了畸形 SSE"));
                        }
                        self.finish()?;
                    }
                }
                Protocol::Json => {
                    if let Some(line) = line {
                        self.json.push_str(&line);
                        self.json.push('\n');
                    } else {
                        if self.json.trim().is_empty() {
                            return Err(Error::stream("INCOMPLETE_STREAM", "上游返回空响应"));
                        }
                        let source = std::mem::take(&mut self.json);
                        let value: Value = serde_json::from_str(&source).map_err(|_| {
                            Error::stream("INVALID_JSON", "自定义 API 返回了无法识别的响应")
                        })?;
                        let missing_message = value["choices"]
                            .as_array()
                            .and_then(|v| v.first())
                            .and_then(|v| v.get("message"))
                            .is_none_or(|v| v.is_null());
                        let decoded = self.decoder.decode(value)?;
                        if missing_message {
                            return Err(Error::stream("INVALID_JSON", "非流式响应缺少消息"));
                        }
                        self.pending.extend(decoded.into_iter().flatten());
                        self.finish()?;
                    }
                }
            }
        }
    }
    fn finish(&mut self) -> Result<()> {
        if self.decoder.malformed {
            return Err(Error::stream("INVALID_SSE", "自定义 API 返回了畸形 SSE"));
        }
        self.pending.extend(self.decoder.finish()?);
        self.finished = true;
        Ok(())
    }
}

fn events(prepared: Prepared, shutdown: CancellationToken) -> Events {
    let wait = prepared.wait_ms;
    let vendor = super::validation::vendor(prepared.response.url());
    Events {
        lines: Lines::new(
            prepared.response.bytes_stream().boxed(),
            Duration::from_secs(if matches!(prepared.protocol, Protocol::Ollama) {
                180
            } else {
                120
            }),
        ),
        protocol: prepared.protocol,
        decoder: Decoder::new(vendor),
        pending: VecDeque::from([Event::Meta {
            model: prepared.model,
            queue_wait_ms: wait,
        }]),
        json: String::new(),
        finished: false,
        shutdown,
        _permit: prepared.permit,
    }
}

pub(super) async fn collect_text(prepared: Prepared, cancel: CancellationToken) -> Result<String> {
    let mut events = events(prepared, cancel);
    let mut text = String::new();
    while let Some(event) = events.next().await? {
        match event {
            Event::Done => {
                return if text.trim().is_empty() {
                    Err(Error::stream("EMPTY_RESPONSE", "AI 返回空内容"))
                } else {
                    Ok(text)
                };
            }
            Event::Token { content: token } => {
                if text.len().saturating_add(token.len()) > 1024 * 1024 {
                    return Err(Error::stream("RESPONSE_TOO_LARGE", "AI 响应超过字节预算"));
                }
                text.push_str(&token);
            }
            _ => {}
        }
    }
    Err(Error::stream("INCOMPLETE_STREAM", "AI 响应中断"))
}

pub(super) fn response(prepared: Prepared, shutdown: CancellationToken) -> Response {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    let wait = prepared.wait_ms;
    let cancel = shutdown.child_token();
    let guard = cancel.clone().drop_guard();
    let mut events = events(prepared, cancel.clone());
    let (send, receive) = tokio::sync::mpsc::channel(4);
    let (finished, terminal) = tokio::sync::oneshot::channel();
    // A connected client can stop polling the body. Keep the deadline outside
    // that body so blocked delivery still releases the Ollama queue and upstream.
    tokio::spawn(async move {
        let relay = async {
            while let Some(value) = events.next().await.map_err(|error| error.message)? {
                let mut bytes = serde_json::to_vec(&value).unwrap();
                bytes.push(b'\n');
                drop(value);
                send.send(Bytes::from(bytes))
                    .await
                    .map_err(|_| "聊天连接已关闭".to_owned())?;
            }
            Ok(())
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("聊天已停止".to_owned()),
            _ = tokio::time::sleep_until(deadline) => Err("聊天流超时".to_owned()),
            result = relay => result,
        };
        drop(events);
        let _ = finished.send(result);
    });
    // The terminal result has its own slot: a full data channel must not hide
    // timeout/cancellation as a clean EOF when the reader eventually resumes.
    let stream = futures_util::stream::unfold(
        (receive, Some(terminal), guard),
        |(mut receive, mut terminal, guard)| async move {
            let bytes = if let Some(bytes) = receive.recv().await {
                bytes
            } else {
                match terminal.take()?.await {
                    Ok(Ok(())) => return None,
                    result => {
                        let message = match result {
                            Ok(Err(message)) => message,
                            _ => "聊天流中断".to_owned(),
                        };
                        let mut bytes =
                            serde_json::to_vec(&json!({"type":"error","error":message})).unwrap();
                        bytes.push(b'\n');
                        Bytes::from(bytes)
                    }
                }
            };
            Some((Ok::<Bytes, Infallible>(bytes), (receive, terminal, guard)))
        },
    );
    let mut response = Body::from_stream(stream).into_response();
    let headers = response.headers_mut();
    headers.insert(
        "content-type",
        "application/x-ndjson; charset=utf-8".parse().unwrap(),
    );
    headers.insert("cache-control", "no-store".parse().unwrap());
    headers.insert("x-accel-buffering", "no".parse().unwrap());
    headers.insert("x-chat-queue-wait", wait.to_string().parse().unwrap());
    response
}
