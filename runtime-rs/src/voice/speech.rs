mod streaming;

use super::{
    config::{Engine, Settings},
    payload::{Validated, fix_wav},
    queue::{Permit, Queue, Reservation, cancelled},
};
use crate::{
    error::{ApiError, Result},
    upstream::LocalUpstream,
};
use axum::{body::Bytes, response::Response};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

type SharedResult = std::result::Result<Bytes, (u16, String, String)>;
type Flight = watch::Receiver<Option<SharedResult>>;
#[derive(Default)]
struct Active {
    gpt: String,
    sovits: String,
    voice: String,
    lora: String,
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
    cache: Arc<Mutex<AudioCache>>,
}
impl Speech {
    pub fn new(
        settings: Arc<Settings>,
        transport: LocalUpstream,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        let queue = Queue::new(settings.engine.id());
        Arc::new(Self {
            settings,
            transport,
            cancel,
            queue,
            active: Mutex::new(Active::default()),
            cache: Arc::new(Mutex::new(AudioCache::default())),
        })
    }
    pub async fn status(&self) -> Value {
        let vox = self.settings.engine == Engine::VoxCpm2;
        let mut online = self
            .transport
            .json(
                &self.settings.tts_host,
                if vox { "/health" } else { "/docs" },
                None,
                Duration::from_millis(1500),
                1024 * 1024,
                &self.cancel,
            )
            .await
            .is_ok_and(|(status, data)| {
                if vox {
                    (200..300).contains(&status)
                        && data.is_ok_and(|v| v["online"] == true && v["engine"] == "VoxCPM2")
                } else {
                    (200..500).contains(&status)
                }
            });
        if online && !vox {
            online = !self
                .transport
                .json(
                    &self.settings.tts_host,
                    "/health",
                    None,
                    Duration::from_millis(1500),
                    64 * 1024,
                    &self.cancel,
                )
                .await
                .is_ok_and(|(_, data)| data.is_ok_and(|v| v["engine"] == "VoxCPM2"));
        }
        let voice = self.active.lock().unwrap().voice.clone();
        let configured = |id: &str| {
            self.settings.profiles.get(id).is_some_and(|p| {
                p.configured()
                    && (self.settings.engine != Engine::VoxCpm2 || !p.lora_weights_path.is_empty())
            })
        };
        json!({"online": online, "engine": self.settings.engine.label(), "streamingPcm": self.settings.engine == Engine::VoxCpm2,
            "voices": {"nene": configured("nene"), "natsume": configured("natsume")}, "activeVoice": voice, "queue": self.queue.status()})
    }
    async fn activate(&self, value: &Validated) -> Result<()> {
        if self.settings.engine == Engine::VoxCpm2 {
            let same = {
                let active = self.active.lock().unwrap();
                active.voice == value.voice && active.lora == value.profile.lora_weights_path
            };
            if !same {
                *self.active.lock().unwrap() = Active::default();
                let (status, _) = self
                    .transport
                    .json(
                        &self.settings.tts_host,
                        "/prepare",
                        Some(&value.payload),
                        Duration::from_secs(60),
                        1024 * 1024,
                        &self.cancel,
                    )
                    .await?;
                if !(200..300).contains(&status) {
                    return Err(ApiError::new(
                        502,
                        "TTS_WEIGHTS_FAILED",
                        "VoxCPM2 角色声线准备失败",
                    ));
                }
                *self.active.lock().unwrap() = Active {
                    voice: value.voice.clone(),
                    lora: value.profile.lora_weights_path.clone(),
                    ..Default::default()
                };
            }
            return Ok(());
        }
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
            lora: String::new(),
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
            return Err(ApiError::new(
                503,
                "TTS_UNAVAILABLE",
                "当前语音引擎尚未运行",
            ));
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
        let response = tokio::select! { response = request.send() => response.map_err(|_| ApiError::new(502, "TTS_FAILED", "语音生成请求失败或超时"))?, _ = self.cancel.cancelled() => return Err(cancelled()) };
        if !response.status().is_success() {
            let status = if response.status().is_client_error() {
                response.status().as_u16()
            } else {
                502
            };
            // Error bodies must obey the same cancellation/deadline as audio,
            // with a small separate cap so a failed provider cannot hold the queue.
            let read = async {
                let mut bytes = Vec::new();
                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.ok()?;
                    if bytes.len().saturating_add(chunk.len()) > 16 * 1024 {
                        return None;
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Some(serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| {
                    Value::String(String::from_utf8_lossy(&bytes).into_owned())
                }))
            };
            let detail = tokio::select! {
                result = tokio::time::timeout_at(deadline, read) => result.ok().flatten().unwrap_or(Value::Null),
                _ = self.cancel.cancelled() => return Err(cancelled()),
            };
            return Err(ApiError::new(
                status,
                "TTS_FAILED",
                crate::upstream::diagnostic_message(&detail, "语音生成失败"),
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
        self.stream_inner(value, None).await
    }
    pub async fn buffered(self: &Arc<Self>, value: Validated) -> Result<(Bytes, bool)> {
        let key = self.cache_key(&value);
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
                // Legacy whole-clip GET retains its replay/in-flight contract.
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
    fn cache_key(&self, value: &Validated) -> String {
        hex::encode(Sha256::digest(
            serde_json::to_vec(&json!([
                self.settings.tts_host,
                value.voice,
                value.profile.gpt_weights_path,
                value.profile.sovits_weights_path,
                value.payload
            ]))
            .unwrap(),
        ))
    }
    async fn collect(&self, value: Validated, reservation: Reservation) -> Result<Bytes> {
        let (response, _permit, deadline) = self.upstream(&value, reservation).await?;
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::select! { chunk = stream.next() => chunk, _ = self.cancel.cancelled() => return Err(cancelled()),
            _ = tokio::time::sleep_until(deadline) => return Err(ApiError::new(504, "TTS_TIMEOUT", "语音音频传输超时")) };
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
        if self.cancel.is_cancelled() {
            return;
        }
        Self::remember_into(&self.cache, key, bytes);
    }
    fn remember_into(store: &Mutex<AudioCache>, key: String, bytes: Bytes) {
        let mut cache = store.lock().unwrap();
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
