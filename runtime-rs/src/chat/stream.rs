use super::{Duration, Error, Result, compatible::Decoder, ollama::Permit};
use axum::{
    body::{Body, Bytes},
    response::{IntoResponse, Response},
};
use futures_util::{Stream, StreamExt};
use serde_json::{Value, json};
use std::{collections::VecDeque, convert::Infallible, pin::Pin};
use tokio_util::sync::CancellationToken;

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
struct Lines {
    source: Pin<Box<dyn Stream<Item = std::result::Result<Bytes, reqwest::Error>> + Send>>,
    buffer: Vec<u8>,
    total: usize,
    ended: bool,
    idle: Duration,
}
impl Lines {
    async fn next(&mut self) -> Result<Option<String>> {
        loop {
            let newline = self.buffer.iter().position(|b| *b == b'\n');
            let length = newline.unwrap_or(self.buffer.len());
            if length > 1024 * 1024 {
                return Err(Error::stream("STREAM_BUDGET", "响应超过单帧预算"));
            }
            if let Some(index) = newline {
                let mut bytes = self.buffer.drain(..=index).collect::<Vec<_>>();
                bytes.pop();
                return Ok(Some(String::from_utf8_lossy(&bytes).into_owned()));
            }
            if self.ended {
                return if self.buffer.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(
                        String::from_utf8_lossy(&std::mem::take(&mut self.buffer)).into_owned(),
                    ))
                };
            }
            match tokio::time::timeout(self.idle, self.source.next())
                .await
                .map_err(|_| Error::stream("UPSTREAM_TIMEOUT", "聊天流超时"))?
            {
                Some(Ok(chunk)) => {
                    self.total = self.total.saturating_add(chunk.len());
                    if self.total > 16 * 1024 * 1024 {
                        return Err(Error::stream("STREAM_BUDGET", "响应超过总字节预算"));
                    }
                    self.buffer.extend_from_slice(&chunk);
                }
                Some(Err(_)) => return Err(Error::stream("INCOMPLETE_STREAM", "聊天流中断")),
                None => self.ended = true,
            }
        }
    }
}
struct Events {
    lines: Lines,
    protocol: Protocol,
    decoder: Decoder,
    pending: VecDeque<Value>,
    json: String,
    finished: bool,
    shutdown: CancellationToken,
    _permit: Option<Permit>,
}
impl Events {
    async fn next(&mut self) -> Result<Option<Value>> {
        loop {
            if let Some(event) = self.pending.pop_front() {
                return Ok(Some(event));
            }
            if self.finished {
                return Ok(None);
            }
            let line = tokio::select! {line=self.lines.next()=>line?,_=self.shutdown.cancelled()=>{self.finished=true;return Ok(None);}};
            match self.protocol {
                Protocol::Ollama => match line {
                    Some(line) if line.trim().is_empty() => {}
                    Some(line) => {
                        let item: Value = serde_json::from_str(&line).map_err(|_| {
                            Error::stream(
                                "INVALID_NDJSON",
                                "Ollama returned an invalid stream event",
                            )
                        })?;
                        if !item.is_object()
                            || item.get("done").is_some_and(|v| !v.is_boolean())
                            || item["message"]
                                .get("content")
                                .is_some_and(|v| !v.is_string())
                        {
                            return Err(Error::stream("INVALID_NDJSON", "Invalid stream fields"));
                        }
                        if let Some(content) = item["message"]["content"]
                            .as_str()
                            .filter(|v| !v.is_empty())
                        {
                            self.pending
                                .push_back(json!({"type":"token","content":content}));
                        }
                        if item["done"] == true {
                            self.pending.push_back(json!({"type":"done"}));
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
                            Ok(event) => self.pending.extend(self.decoder.decode(&event)?),
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
                        let value: Value = serde_json::from_str(&self.json).map_err(|_| {
                            Error::stream("INVALID_JSON", "自定义 API 返回了无法识别的响应")
                        })?;
                        if value["choices"]
                            .as_array()
                            .and_then(|v| v.first())
                            .and_then(|v| v.get("message"))
                            .is_none_or(|v| v.is_null())
                        {
                            return Err(Error::stream("INVALID_JSON", "非流式响应缺少消息"));
                        }
                        self.pending.extend(self.decoder.decode(&value)?);
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
    Events {
        lines: Lines {
            source: prepared.response.bytes_stream().boxed(),
            buffer: Vec::new(),
            total: 0,
            ended: false,
            idle: Duration::from_secs(if matches!(prepared.protocol, Protocol::Ollama) {
                180
            } else {
                120
            }),
        },
        protocol: prepared.protocol,
        decoder: Decoder::default(),
        pending: VecDeque::from([json!({"type":"meta","model":prepared.model,"queueWaitMs":wait})]),
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
        if event["type"] == "done" {
            return if text.trim().is_empty() {
                Err(Error::stream("EMPTY_RESPONSE", "AI 返回空内容"))
            } else {
                Ok(text)
            };
        }
        if event["type"] == "token"
            && let Some(token) = event["content"].as_str()
        {
            if text.len().saturating_add(token.len()) > 1024 * 1024 {
                return Err(Error::stream("RESPONSE_TOO_LARGE", "AI 响应超过字节预算"));
            }
            text.push_str(token);
        }
    }
    Err(Error::stream("INCOMPLETE_STREAM", "AI 响应中断"))
}

pub(super) fn response(prepared: Prepared, shutdown: CancellationToken) -> Response {
    let wait = prepared.wait_ms;
    let events = events(prepared, shutdown);
    // Pull-based body retains the queue permit and upstream response. Disconnect
    // drops both immediately; no detached producer or unbounded channel survives.
    let stream = futures_util::stream::unfold(events, |mut events| async move {
        let next = match events.next().await {
            Ok(Some(value)) => value,
            Ok(None) => return None,
            Err(error) => {
                events.finished = true;
                events.pending.clear();
                json!({"type":"error","error":error.message})
            }
        };
        let mut bytes = serde_json::to_vec(&next).unwrap();
        bytes.push(b'\n');
        Some((Ok::<Bytes, Infallible>(bytes.into()), events))
    });
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
