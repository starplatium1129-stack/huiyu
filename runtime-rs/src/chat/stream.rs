use super::{
    Duration, Error, Result,
    compatible::Decoder,
    ollama::Permit,
    responses::{self, Decoder as ResponsesDecoder, Session as ResponsesSession},
};
use axum::{
    body::{Body, Bytes},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
mod lines;
mod sse;
pub(super) mod japanese_voice;
use japanese_voice::JapaneseVoice;
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
    JapaneseSpeechMode {
        #[serde(rename = "speechFirst")]
        speech_first: bool,
    },
    JapaneseSpeechChunk {
        content: String,
    },
    JapaneseSpeech {
        content: String,
    },
    Drawing {
        drawing: serde_json::Map<String, Value>,
    },
    ToolCall(Box<ToolCall>),
    KeepAlive,
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

pub(super) enum Protocol {
    Ollama,
    Sse,
    ResponsesSse(Box<ResponsesSession>),
    Json,
}
pub(super) struct Prepared {
    pub response: reqwest::Response,
    pub model: String,
    pub wait_ms: u64,
    pub protocol: Protocol,
    pub permit: Option<Permit>,
    pub japanese_voice: bool,
}
struct Events {
    lines: Lines,
    protocol: Protocol,
    decoder: Decoder,
    responses: ResponsesDecoder,
    sse: sse::Frames,
    pending: VecDeque<Event>,
    json: String,
    finished: bool,
    reject_refusals: bool,
    shutdown: CancellationToken,
    _permit: Option<Permit>,
    japanese_voice: Option<JapaneseVoice>,
    voice_events: VecDeque<Event>,
}
impl Events {
    async fn next(&mut self) -> Result<Option<Event>> {
        loop {
            if let Some(event) = self.voice_events.pop_front() {
                return Ok(Some(event));
            }
            if let Some(event) = self.pending.pop_front() {
                match event {
                    Event::Token { content } => {
                        if let Some(voice) = self.japanese_voice.as_mut() {
                            // Tool deltas may arrive before the decoder publishes validated calls.
                            let speak = !self.decoder.has_tool_calls()
                                && !self.responses.has_tool_calls()
                                && !self
                                    .pending
                                    .iter()
                                    .any(|event| matches!(event, Event::ToolCall(_)));
                            voice.push(content, &mut self.voice_events, speak);
                            continue;
                        }
                        return Ok(Some(Event::Token { content }));
                    }
                    Event::Done => {
                        if let Some(voice) = self.japanese_voice.take() {
                            voice.finish(&mut self.voice_events);
                            self.voice_events.push_back(Event::Done);
                            continue;
                        }
                        return Ok(Some(Event::Done));
                    }
                    event => return Ok(Some(event)),
                }
            }
            if self.finished {
                return Ok(None);
            }
            let session_cancel = async {
                match &self.protocol {
                    Protocol::ResponsesSse(session) => session.cancel.cancelled().await,
                    _ => std::future::pending().await,
                }
            };
            let line = tokio::select! {
                _ = self.shutdown.cancelled() => return Err(Error::stream("ABORTED", "聊天已停止")),
                _ = session_cancel => return Err(responses::session_ended()),
                line = self.lines.next() => line?,
            };
            match &self.protocol {
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
                        match self.sse.push(&line)? {
                            Some(sse::Frame::Event(event)) => {
                                self.check_compatible_refusal(&event)?;
                                self.pending.extend(self.decoder.decode(event)?.into_iter().flatten());
                            }
                            Some(sse::Frame::Done) => self.finish()?,
                            None => {}
                        }
                    } else {
                        self.sse.end(self.decoder.terminal)?;
                        self.finish()?;
                    }
                }
                Protocol::ResponsesSse(session) => {
                    if let Some(line) = line {
                        match self.sse.push(&line)? {
                            Some(sse::Frame::Event(event)) => {
                                if self.reject_refusals && responses_refusal(&event) {
                                    return Err(vision_refusal());
                                }
                                let decoded = match self.responses.decode(event, session.request_id.as_deref()) {
                                    Ok(events) => events,
                                    Err(error) => {
                                        session.recover(&error).await?;
                                        return Err(error);
                                    }
                                };
                                if self.responses.completed {
                                    self.finished = true;
                                }
                                self.pending.extend(decoded);
                            }
                            Some(sse::Frame::Done) => {
                                if !self.responses.completed {
                                    return Err(Error::stream(
                                        "INCOMPLETE_STREAM",
                                        "ChatGPT 响应未收到完成事件即结束",
                                    ));
                                }
                                self.finished = true;
                            }
                            None => {}
                        }
                    } else {
                        self.sse.end(self.responses.completed)?;
                        if !self.responses.completed {
                            return Err(Error::stream(
                                "INCOMPLETE_STREAM",
                                "ChatGPT 响应未收到完成事件即结束",
                            ));
                        }
                        self.finished = true;
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
                        self.check_compatible_refusal(&value)?;
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
    fn check_compatible_refusal(&self, value: &Value) -> Result<()> {
        let choice = &value["choices"][0];
        if self.reject_refusals
            && (choice["finish_reason"] == "content_filter"
                || [&choice["message"]["refusal"], &choice["delta"]["refusal"]]
                    .iter()
                    .any(|refusal| refusal.as_str().is_some_and(|text| !text.trim().is_empty())))
        {
            return Err(vision_refusal());
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<()> {
        self.pending.extend(self.decoder.finish()?);
        self.finished = true;
        Ok(())
    }
}

fn responses_refusal(event: &Value) -> bool {
    fn contains_refusal(parts: &Value) -> bool {
        parts.as_array().into_iter().flatten().any(|part| part["type"] == "refusal")
    }
    event["type"].as_str().is_some_and(|kind| kind.starts_with("response.refusal."))
        || event["part"]["type"] == "refusal"
        || contains_refusal(&event["item"]["content"])
        || event["response"]["output"].as_array().into_iter().flatten()
            .any(|item| contains_refusal(&item["content"]))
}

fn vision_refusal() -> Error {
    Error::stream("VISION_REFUSAL", "视觉服务拒绝描述此图")
}

fn events(prepared: Prepared, shutdown: CancellationToken) -> Events {
    let wait = prepared.wait_ms;
    let vendor = super::validation::vendor(prepared.response.url());
    let mut pending = VecDeque::from([Event::Meta {
        model: prepared.model,
        queue_wait_ms: wait,
    }]);
    if prepared.japanese_voice {
        pending.push_back(Event::JapaneseSpeechMode { speech_first: true });
    }
    Events {
        lines: Lines::new(
            prepared.response.bytes_stream().boxed(),
            Duration::from_secs(if matches!(prepared.protocol, Protocol::Ollama) {
                180
            } else {
                120
            }),
            matches!(prepared.protocol, Protocol::Sse | Protocol::ResponsesSse(_)),
        ),
        protocol: prepared.protocol,
        decoder: Decoder::new(vendor),
        responses: ResponsesDecoder::default(),
        sse: sse::Frames::default(),
        pending,
        json: String::new(),
        finished: false,
        reject_refusals: false,
        shutdown,
        _permit: prepared.permit,
        japanese_voice: prepared.japanese_voice.then(JapaneseVoice::default),
        voice_events: VecDeque::new(),
    }
}

pub(super) async fn collect_text(prepared: Prepared, cancel: CancellationToken) -> Result<String> {
    collect_text_events(events(prepared, cancel)).await
}

pub(super) async fn collect_vision(prepared: Prepared, cancel: CancellationToken) -> Result<String> {
    let mut stream = events(prepared, cancel);
    stream.reject_refusals = true;
    collect_text_events(stream).await
}

async fn collect_text_events(mut events: Events) -> Result<String> {
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

pub(super) async fn collect_channel(
    prepared: Prepared,
    cancel: CancellationToken,
) -> Result<(String, Vec<ToolCall>)> {
    let mut events = events(prepared, cancel);
    let mut text = String::new();
    let mut calls = Vec::new();
    while let Some(event) = events.next().await? {
        match event {
            Event::Done => return Ok((text, calls)),
            Event::Token { content } if text.len() + content.len() <= 64 * 1024 => {
                text.push_str(&content);
            }
            Event::ToolCall(call) if calls.len() < 8 => calls.push(*call),
            Event::Token { .. } | Event::ToolCall(_) => {
                return Err(Error::stream("RESPONSE_TOO_LARGE", "消息回复过长"));
            }
            _ => {}
        }
    }
    Err(Error::stream("INCOMPLETE_STREAM", "消息回复中断"))
}

pub(super) fn response(prepared: Prepared, shutdown: CancellationToken) -> Response {
    let wait = prepared.wait_ms;
    let cancel = shutdown.child_token();
    let events = futures_util::stream::try_unfold(
        events(prepared, cancel.clone()),
        |mut events| async move { Ok(events.next().await?.map(|event| (event, events))) },
    );
    from_events(events, wait, cancel)
}

pub(super) fn from_events(
    events: impl futures_util::Stream<Item = Result<Event>> + Send + 'static,
    wait: u64,
    cancel: CancellationToken,
) -> Response {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    let guard = cancel.clone().drop_guard();
    let (send, receive) = tokio::sync::mpsc::channel(4);
    let (finished, terminal) = tokio::sync::oneshot::channel();
    // A connected client can stop polling the body. Keep the deadline outside
    // that body so blocked delivery still releases the Ollama queue and upstream.
    tokio::spawn(async move {
        let relay = async move {
            futures_util::pin_mut!(events);
            while let Some(event) = events.next().await {
                let value = event.map_err(|error| (error.message, Some(error.code), error.upstream))?;
                let mut bytes = serde_json::to_vec(&value).unwrap();
                bytes.push(b'\n');
                drop(value);
                send.send(Bytes::from(bytes))
                    .await
                    .map_err(|_| ("聊天连接已关闭".to_owned(), None, None))?;
            }
            Ok(())
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(("聊天已停止".to_owned(), Some("ABORTED".to_owned()), None)),
            _ = tokio::time::sleep_until(deadline) => Err(("聊天流超时".to_owned(), Some("UPSTREAM_TIMEOUT".to_owned()), None)),
            result = relay => result,
        };
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
                        let (message, code, upstream) = match result {
                            Ok(Err(error)) => error,
                            _ => ("聊天流中断".to_owned(), None, None),
                        };
                        let mut payload = json!({"type":"error","error":message});
                        if let Some(code) = code {
                            payload["code"] = Value::String(code);
                        }
                        if let Some(upstream) = upstream {
                            payload["upstream"] = json!(upstream);
                        }
                        let mut bytes = serde_json::to_vec(&payload).unwrap();
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
