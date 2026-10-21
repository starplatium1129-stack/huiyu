mod streaming;
mod wave;

use super::{
    config::{Engine, Settings},
    payload::Validated,
    queue::{Permit, Queue, Reservation, cancelled, remaining, speech_timeout},
};
use crate::{
    byte_buffer::Buffer,
    error::{ApiError, Result},
    upstream::{LocalUpstream, HealthProbes},
};
use axum::{body::Bytes, response::Response};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::{BufWriter, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;
use tokio::time::Instant as Deadline;
use tokio_util::sync::CancellationToken;

type SharedResult = std::result::Result<Bytes, (u16, String, String)>;
// Only request-owned receivers count as consumers. The cache retains a sender,
// so an abandoned whole-clip request can release its queue slot.
type Flight = Arc<watch::Sender<Option<SharedResult>>>;
struct Subscriber {
    receiver: Option<watch::Receiver<Option<SharedResult>>>,
    flight: Flight,
    cache: Arc<Mutex<AudioCache>>,
    key: String,
}
impl Drop for Subscriber {
    fn drop(&mut self) {
        // Serialize the last receiver's drop with new subscriptions. Otherwise
        // a caller could join between closed() firing and flight removal.
        let mut cache = self.cache.lock().unwrap();
        drop(self.receiver.take());
        if self.flight.is_closed()
            && cache
                .flights
                .get(&self.key)
                .is_some_and(|current| Arc::ptr_eq(current, &self.flight))
        {
            cache.flights.remove(&self.key);
        }
    }
}
const AUDIO_LIMIT: usize = 128 * 1024 * 1024;
#[derive(Default)]
struct Active {
    gpt: String,
    sovits: String,
    voice: String,
    lora: String,
}
#[derive(Default)]
struct AudioCache {
    entries: VecDeque<(String, CachedAudio)>,
    bytes: usize,
    flights: HashMap<String, Flight>,
}
#[derive(Clone)]
struct CachedAudio {
    bytes: Bytes,
    pcm: Option<std::ops::Range<usize>>,
}
pub(super) struct Speech {
    pub settings: Arc<Settings>,
    pub queue: Queue,
    transport: LocalUpstream,
    cancel: CancellationToken,
    active: Mutex<Active>,
    cache: Arc<Mutex<AudioCache>>,
    probes: Arc<HealthProbes>,
}
impl Speech {
    pub fn new(
        settings: Arc<Settings>,
        transport: LocalUpstream,
        cancel: CancellationToken,
        probes: Arc<HealthProbes>,
    ) -> Arc<Self> {
        let queue = Queue::new(settings.engine.id());
        Arc::new(Self {
            settings,
            transport,
            cancel,
            queue,
            active: Mutex::new(Active::default()),
            cache: Arc::new(Mutex::new(AudioCache::default())),
            probes,
        })
    }
    pub async fn status(&self) -> Value { self.status_observed(true).await }
    pub async fn status_observed(&self, fresh: bool) -> Value {
        let vox = self.settings.engine == Engine::VoxCpm2;
        let mut online = self.probes.read(&self.settings.tts_host, if vox { "/health" } else { "/docs" },
            Duration::from_millis(1500), 1024 * 1024, fresh).await.is_some_and(|probe| {
                if vox { (200..300).contains(&probe.status) && probe.json.as_ref().is_some_and(|v| v["online"] == true && v["engine"] == "VoxCPM2") }
                else { (200..500).contains(&probe.status) }
            });
        if online && !vox {
            online = !self.probes.read(&self.settings.tts_host, "/health", Duration::from_millis(1500), 64 * 1024, fresh).await
                .is_some_and(|probe| probe.json.as_ref().is_some_and(|v| v["engine"] == "VoxCPM2"));
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
    async fn activate(&self, value: &Validated, deadline: Deadline) -> Result<()> {
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
                        remaining(deadline, Duration::from_secs(60), speech_timeout)?,
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
                    remaining(deadline, Duration::from_secs(30), speech_timeout)?,
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
    pub async fn prepare(&self, value: &Validated, deadline: Deadline) -> Result<()> {
        let work = async {
            let _permit = self
                .queue
                .enter(
                    self.queue.reserve()?,
                    &self.cancel,
                    deadline,
                    speech_timeout,
                )
                .await?;
            // A profile without weight paths still needs a real reachability check.
            if self.status().await["online"] != true {
                return Err(ApiError::new(
                    503,
                    "TTS_UNAVAILABLE",
                    "当前语音引擎尚未运行",
                ));
            }
            self.activate(value, deadline).await
        };
        let result = tokio::time::timeout_at(deadline, work)
            .await
            .map_err(|_| speech_timeout())?;
        remaining(deadline, Duration::MAX, speech_timeout)?;
        result
    }
    async fn upstream(
        &self,
        value: &Validated,
        permit: Permit,
        deadline: Deadline,
    ) -> Result<(reqwest::Response, Permit, tokio::time::Instant)> {
        let prepared = tokio::time::timeout_at(deadline, self.activate(value, deadline))
            .await
            .map_err(|_| speech_timeout())?;
        remaining(deadline, Duration::MAX, speech_timeout)?;
        prepared?;
        let request = self
            .transport
            .client
            .post(format!("{}/tts", self.settings.tts_host))
            .json(&value.payload)
            .timeout(remaining(
                deadline,
                Duration::from_secs(180),
                speech_timeout,
            )?);
        let response = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(cancelled()),
            _ = tokio::time::sleep_until(deadline) => return Err(speech_timeout()),
            response = request.send() => response.map_err(|_| ApiError::new(502, "TTS_FAILED", "语音生成请求失败或超时"))?,
        };
        if !response.status().is_success() {
            let status = if response.status().is_client_error() {
                response.status().as_u16()
            } else {
                502
            };
            // Error bodies must obey the same cancellation/deadline as audio,
            // with a small separate cap so a failed provider cannot hold the queue.
            let read = async {
                let mut bytes = Buffer::Chunk(Bytes::new());
                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.ok()?;
                    if bytes.as_ref().len().saturating_add(chunk.len()) > 16 * 1024 {
                        return None;
                    }
                    bytes.append(chunk, 0);
                }
                Some(serde_json::from_slice::<Value>(bytes.as_ref()).unwrap_or_else(|_| {
                    Value::String(String::from_utf8(bytes.into_vec()).unwrap_or_else(|error| {
                        String::from_utf8_lossy(error.as_bytes()).into_owned()
                    }))
                }))
            };
            let detail = tokio::select! {
                result = tokio::time::timeout_at(deadline, read) => result.map_err(|_| speech_timeout())?.unwrap_or(Value::Null),
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
    pub async fn stream(&self, value: Validated, deadline: Deadline) -> Result<Response> {
        let key = self.cache_key(&value);
        if let Some(response) = self.cached_response(&key, false) {
            return Ok(response);
        }
        self.stream_inner(value, key, false, deadline).await
    }
    pub async fn buffered(
        self: &Arc<Self>,
        value: Validated,
        deadline: Deadline,
    ) -> Result<(Bytes, bool)> {
        let key = self.cache_key(&value);
        let (mut subscriber, hit) = {
            let mut cache = self.cache.lock().unwrap();
            if let Some((_, audio)) = cache.entries.iter().find(|(cached, _)| *cached == key) {
                return Ok((audio.bytes.clone(), true));
            }
            let (receiver, flight, hit) = if let Some(flight) = cache.flights.get(&key) {
                (flight.subscribe(), flight.clone(), true)
            } else {
                let reservation = self.queue.reserve()?;
                let (send, receiver) = watch::channel(None);
                let send = Arc::new(send);
                cache.flights.insert(key.clone(), send.clone());
                let speech = self.clone();
                let task_key = key.clone();
                let task_send = send.clone();
                // Cancel only after every real caller leaves. One caller's
                // cancellation must not stop a shared synthesis or its cache.
                tokio::spawn(async move {
                    // Shared work gets one budget from its real entry. A later
                    // listener cannot extend it or cancel another listener's work.
                    let deadline = Deadline::now() + Duration::from_secs(240);
                    let result = tokio::select! {
                        biased;
                        _ = task_send.closed() => None,
                        result = speech.collect(value, reservation, &task_key, deadline) => Some(result),
                    };
                    if let Some(result) = result {
                        let result = result
                            .map_err(|error| (error.status.as_u16(), error.code, error.message));
                        let _ = task_send.send(Some(result));
                    }
                    let mut cache = speech.cache.lock().unwrap();
                    // A new caller may already have replaced an abandoned
                    // same-key flight; an older worker cannot remove that one.
                    if cache
                        .flights
                        .get(&task_key)
                        .is_some_and(|current| Arc::ptr_eq(current, &task_send))
                    {
                        cache.flights.remove(&task_key);
                    }
                });
                (receiver, send, false)
            };
            (
                Subscriber {
                    receiver: Some(receiver),
                    flight,
                    cache: self.cache.clone(),
                    key,
                },
                hit,
            )
        };
        loop {
            remaining(deadline, Duration::MAX, speech_timeout)?;
            let receiver = subscriber.receiver.as_mut().unwrap();
            let result = receiver.borrow().clone();
            if let Some(result) = result {
                return result
                    .map(|bytes| (bytes, hit))
                    .map_err(|(status, code, message)| ApiError::new(status, code, message));
            }
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err(cancelled()),
                _ = tokio::time::sleep_until(deadline) => return Err(speech_timeout()),
                result = receiver.changed() => result.map_err(|_| cancelled())?,
            }
        }
    }
    fn cache_key(&self, value: &Validated) -> String {
        let mut hash = BufWriter::with_capacity(8 * 1024, Sha256::new());
        // A tuple preserves the existing JSON array encoding while borrowing
        // the validated payload instead of copying its tree and encoded bytes.
        serde_json::to_writer(&mut hash, &(
            &self.settings.tts_host,
            &value.voice,
            &value.profile.gpt_weights_path,
            &value.profile.sovits_weights_path,
            &value.payload,
        )).unwrap();
        hash.flush().expect("Hash writer is infallible");
        hex::encode(hash.into_inner().unwrap().finalize())
    }
    fn cached_audio(&self, key: &str) -> Option<CachedAudio> {
        self.cache
            .lock()
            .unwrap()
            .entries
            .iter()
            .find(|(id, _)| id == key)
            .map(|(_, audio)| audio.clone())
    }
    async fn collect(
        &self,
        value: Validated,
        reservation: Reservation,
        key: &str,
        deadline: Deadline,
    ) -> Result<Bytes> {
        let permit = self
            .queue
            .enter(reservation, &self.cancel, deadline, speech_timeout)
            .await?;
        if let Some(audio) = self.cached_audio(key) {
            return Ok(audio.bytes);
        }
        let (response, _permit, deadline) = self.upstream(&value, permit, deadline).await?;
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err(cancelled()),
                _ = tokio::time::sleep_until(deadline) => return Err(speech_timeout()),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|_| ApiError::new(502, "TTS_FAILED", "语音音频传输失败"))?;
            if bytes.len().saturating_add(chunk.len()) > AUDIO_LIMIT {
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
        // Only repair complete WAVs; an oversized declared data chunk must not
        // turn a truncated provider response into a reusable full sentence.
        let finished = wave::finish(&mut bytes);
        // Match the PCM path: retained allocation must fit the cache's byte budget.
        let bytes = Bytes::from(bytes.into_boxed_slice());
        remaining(deadline, Duration::MAX, speech_timeout)?;
        if let Some((data, pcm)) = finished {
            // Commit before releasing the permit so queued POST callers can replay.
            Self::remember_into(
                &self.cache,
                key.to_owned(),
                CachedAudio { bytes: bytes.clone(), pcm: pcm.then_some(data) },
                &self.cancel,
                deadline,
            );
        }
        remaining(deadline, Duration::MAX, speech_timeout)?;
        Ok(bytes)
    }
    pub fn close(&self) {
        let mut cache = self.cache.lock().unwrap();
        cache.entries.clear();
        cache.flights.clear();
        cache.bytes = 0;
    }
}
