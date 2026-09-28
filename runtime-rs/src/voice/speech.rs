use super::{
    config::Settings,
    payload::{Validated, fix_wav},
    queue::{Permit, Queue, Reservation, cancelled},
};
use crate::{
    error::{ApiError, Result},
    upstream::LocalUpstream,
};
use axum::{
    body::{Body, Bytes},
    http::HeaderValue,
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

type SharedResult = std::result::Result<Bytes, (u16, String, String)>;
type Flight = watch::Receiver<Option<SharedResult>>;
struct CancelBody(CancellationToken);
impl Drop for CancelBody {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
#[derive(Default)]
struct Active {
    gpt: String,
    sovits: String,
    voice: String,
}
#[derive(Default)]
struct AudioCache {
    entries: VecDeque<(String, Bytes)>,
    bytes: usize,
    flights: HashMap<String, Flight>,
}
pub(super) struct Speech {
    pub settings: Arc<Settings>,
    pub queue: Queue,
    transport: LocalUpstream,
    cancel: CancellationToken,
    active: Mutex<Active>,
    cache: Mutex<AudioCache>,
}
impl Speech {
    pub fn new(
        settings: Arc<Settings>,
        transport: LocalUpstream,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        Arc::new(Self {
            settings,
            transport,
            cancel,
            queue: Queue::new("gpt-sovits"),
            active: Mutex::new(Active::default()),
            cache: Mutex::new(AudioCache::default()),
        })
    }
    pub async fn status(&self) -> Value {
        let online = self
            .transport
            .json(
                &self.settings.tts_host,
                "/docs",
                None,
                Duration::from_millis(1500),
                1024 * 1024,
                &self.cancel,
            )
            .await
            .is_ok_and(|(status, _)| (200..500).contains(&status));
        let voice = self.active.lock().unwrap().voice.clone();
        json!({"online": online, "engine": "GPT-SoVITS", "voices": {
            "nene": self.settings.profiles.get("nene").is_some_and(|p| p.configured()),
            "natsume": self.settings.profiles.get("natsume").is_some_and(|p| p.configured())}, "activeVoice": voice, "queue": self.queue.status()})
    }
    async fn activate(&self, value: &Validated) -> Result<()> {
        let (sovits, gpt) = {
            // Dropping a request future during a partial model switch skips
            // error handlers. Invalidate first so the next voice restores both.
            let active = std::mem::take(&mut *self.active.lock().unwrap());
            (active.sovits, active.gpt)
        };
        for (endpoint, wanted, previous) in [
            (
                "set_sovits_weights",
                &value.profile.sovits_weights_path,
                sovits,
            ),
            ("set_gpt_weights", &value.profile.gpt_weights_path, gpt),
        ] {
            if wanted.is_empty() || *wanted == previous {
                continue;
            }
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("weights_path", wanted)
                .finish();
            let result = self
                .transport
                .json(
                    &self.settings.tts_host,
                    &format!("/{endpoint}?{query}"),
                    None,
                    Duration::from_secs(30),
                    1024 * 1024,
                    &self.cancel,
                )
                .await;
            match result {
                Ok((status, _)) if (200..300).contains(&status) => {}
                _ => {
                    *self.active.lock().unwrap() = Active::default();
                    return Err(ApiError::new(
                        502,
                        "TTS_WEIGHTS_FAILED",
                        "角色声线权重切换失败",
                    ));
                }
            }
        }
        *self.active.lock().unwrap() = Active {
            gpt: value.profile.gpt_weights_path.clone(),
            sovits: value.profile.sovits_weights_path.clone(),
            voice: value.voice.clone(),
        };
        Ok(())
    }
    pub async fn prepare(&self, value: &Validated) -> Result<()> {
        let _permit = self
            .queue
            .enter(self.queue.reserve()?, &self.cancel)
            .await?;
        // A profile without weight paths still needs a real reachability check.
        if self.status().await["online"] != true {
            return Err(ApiError::new(503, "TTS_UNAVAILABLE", "GPT-SoVITS 尚未运行"));
        }
        self.activate(value).await
    }
    async fn upstream(
        &self,
        value: &Validated,
        reservation: Reservation,
    ) -> Result<(reqwest::Response, Permit, tokio::time::Instant)> {
        let permit = self.queue.enter(reservation, &self.cancel).await?;
        self.activate(value).await?;
        let request = self
            .transport
            .client
            .post(format!("{}/tts", self.settings.tts_host))
            .json(&value.payload)
            .timeout(Duration::from_secs(180));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
        let response = tokio::select! { response = request.send() => response.map_err(|_| ApiError::new(502, "TTS_FAILED", "GPT-SoVITS 生成请求失败或超时"))?, _ = self.cancel.cancelled() => return Err(cancelled()) };
        if !response.status().is_success() {
            return Err(ApiError::new(
                if response.status().is_client_error() {
                    response.status().as_u16()
                } else {
                    502
                },
                "TTS_FAILED",
                "GPT-SoVITS 生成失败",
            ));
        }
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("audio/wav");
        if !mime.starts_with("audio/") && !mime.starts_with("application/octet-stream") {
            return Err(ApiError::new(
                502,
                "TTS_INVALID_AUDIO",
                "语音服务未返回音频",
            ));
        }
        Ok((response, permit, deadline))
    }
    pub async fn stream(&self, value: Validated) -> Result<Response> {
        let (response, permit, deadline) = self.upstream(&value, self.queue.reserve()?).await?;
        let mime = response
            .headers()
            .get("content-type")
            .cloned()
            .unwrap_or(HeaderValue::from_static("audio/wav"));
        let wait = permit.wait_ms;
        let cancel = self.cancel.child_token();
        let body_cancel = CancelBody(cancel.clone());
        let (send, receive) = tokio::sync::mpsc::channel(4);
        let complete = Arc::new(AtomicBool::new(false));
        let producer_complete = complete.clone();
        // A stalled listener must not keep the GPU queue forever: the bounded
        // producer enforces the same deadline while blocked on downstream flow.
        tokio::spawn(async move {
            let _permit = permit;
            let mut upstream = response.bytes_stream();
            loop {
                let chunk = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep_until(deadline) => {
                        let _ = send.try_send(Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Audio response timed out")));
                        break;
                    },
                    chunk = upstream.next() => chunk,
                };
                let Some(chunk) = chunk else {
                    producer_complete.store(true, Ordering::Release);
                    break;
                };
                let chunk = chunk.map_err(std::io::Error::other);
                let failed = chunk.is_err();
                let sent = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => false,
                    _ = tokio::time::sleep_until(deadline) => false,
                    result = send.send(chunk) => result.is_ok(),
                };
                if failed || !sent {
                    break;
                }
            }
        });
        let stream = futures_util::stream::unfold(
            (receive, body_cancel, complete, false),
            |(mut receive, cancel, complete, ended)| async move {
                if let Some(chunk) = receive.recv().await {
                    Some((chunk, (receive, cancel, complete, ended)))
                } else if !ended && !complete.load(Ordering::Acquire) {
                    Some((
                        Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "Audio stream was interrupted",
                        )),
                        (receive, cancel, complete, true),
                    ))
                } else {
                    None
                }
            },
        );
        let mut response = Body::from_stream(stream).into_response();
        response.headers_mut().insert("content-type", mime);
        response
            .headers_mut()
            .insert("x-voice-queue-wait", wait.to_string().parse().unwrap());
        response
            .headers_mut()
            .insert("x-accel-buffering", HeaderValue::from_static("no"));
        Ok(response)
    }
    pub async fn buffered(self: &Arc<Self>, value: Validated) -> Result<(Bytes, bool)> {
        let key = hex::encode(Sha256::digest(
            serde_json::to_vec(&json!([
                self.settings.tts_host,
                value.voice,
                value.profile.gpt_weights_path,
                value.profile.sovits_weights_path,
                value.payload
            ]))
            .unwrap(),
        ));
        let (mut receiver, hit) = {
            let mut cache = self.cache.lock().unwrap();
            if let Some((_, bytes)) = cache.entries.iter().find(|(cached, _)| *cached == key) {
                return Ok((bytes.clone(), true));
            }
            if let Some(flight) = cache.flights.get(&key) {
                (flight.clone(), true)
            } else {
                let reservation = self.queue.reserve()?;
                let (send, receiver) = watch::channel(None);
                cache.flights.insert(key.clone(), receiver.clone());
                let speech = self.clone();
                // Preserve routes/voice.ts: shared GET synthesis outlives every
                // listener to populate replay cache, bounded by the 180s upstream
                // deadline and shutdown cancellation. Listener-count cancellation
                // would change retry/replay semantics and needs a product decision.
                tokio::spawn(async move {
                    let result = speech.collect(value, reservation).await;
                    if let Ok(bytes) = &result {
                        speech.remember(key.clone(), bytes.clone());
                    }
                    let result =
                        result.map_err(|error| (error.status.as_u16(), error.code, error.message));
                    let _ = send.send(Some(result));
                    speech.cache.lock().unwrap().flights.remove(&key);
                });
                (receiver, false)
            }
        };
        loop {
            let result = receiver.borrow().clone();
            if let Some(result) = result {
                return result
                    .map(|bytes| (bytes, hit))
                    .map_err(|(status, code, message)| ApiError::new(status, code, message));
            }
            receiver.changed().await.map_err(|_| cancelled())?;
        }
    }
    async fn collect(&self, value: Validated, reservation: Reservation) -> Result<Bytes> {
        let (response, _permit, _deadline) = self.upstream(&value, reservation).await?;
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::select! { chunk = stream.next() => chunk, _ = self.cancel.cancelled() => return Err(cancelled()) };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|_| ApiError::new(502, "TTS_FAILED", "语音音频传输失败"))?;
            if bytes.len().saturating_add(chunk.len()) > 128 * 1024 * 1024 {
                return Err(ApiError::new(
                    502,
                    "TTS_AUDIO_TOO_LARGE",
                    "生成的单句音频超过缓存播放上限",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() < 64 {
            return Err(ApiError::new(502, "TTS_EMPTY_AUDIO", "语音服务返回空音频"));
        }
        fix_wav(&mut bytes);
        Ok(Bytes::from(bytes))
    }
    fn remember(&self, key: String, bytes: Bytes) {
        let mut cache = self.cache.lock().unwrap();
        if self.cancel.is_cancelled() {
            return;
        }
        cache.bytes += bytes.len();
        cache.entries.push_back((key, bytes));
        while cache.entries.len() > 60 || cache.bytes > 128 * 1024 * 1024 {
            if let Some((_, old)) = cache.entries.pop_front() {
                cache.bytes -= old.len();
            }
        }
    }
    pub fn close(&self) {
        let mut cache = self.cache.lock().unwrap();
        cache.entries.clear();
        cache.flights.clear();
        cache.bytes = 0;
    }
}
