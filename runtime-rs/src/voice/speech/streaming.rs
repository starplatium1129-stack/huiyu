use super::super::config::Engine;
use super::super::queue::speech_timeout;
use super::{AUDIO_LIMIT, AudioCache, Speech, Validated, wave};
use crate::error::{ApiError, Result};
use axum::{
    body::{Body, Bytes},
    http::HeaderValue,
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::time::Instant as Deadline;
use tokio_util::sync::CancellationToken;

impl Speech {
    pub(super) fn remember_into(
        store: &Mutex<AudioCache>,
        key: String,
        bytes: Bytes,
        cancel: &CancellationToken,
        deadline: Deadline,
    ) {
        if bytes.len() > AUDIO_LIMIT || wave::inspect(&bytes).is_none() {
            return;
        }
        let mut cache = store.lock().unwrap();
        // close() clears under this same lock after cancellation. A late EOF
        // cannot repopulate the cache after shutdown has already cleared it.
        if cancel.is_cancelled() || deadline <= Deadline::now() {
            return;
        }
        if let Some(index) = cache.entries.iter().position(|(id, _)| id == &key) {
            cache.bytes -= cache.entries.remove(index).unwrap().1.len();
        }
        cache.bytes += bytes.len();
        cache.entries.push_back((key, bytes));
        while cache.entries.len() > 60 || cache.bytes > AUDIO_LIMIT {
            if let Some((_, old)) = cache.entries.pop_front() {
                cache.bytes -= old.len();
            }
        }
    }

    pub async fn stream_pcm(
        self: &Arc<Self>,
        mut value: Validated,
        deadline: Deadline,
    ) -> Result<Response> {
        if self.settings.engine != Engine::VoxCpm2 {
            return Err(ApiError::new(
                409,
                "TTS_STREAM_UNAVAILABLE",
                "当前语音引擎未提供 PCM 分片",
            ));
        }
        let key = self.cache_key(&value);
        if let Some(response) = self.cached_response(&key, true) {
            return Ok(response);
        }
        value.payload["streaming_mode"] = true.into();
        value.payload["media_type"] = "raw".into();
        self.stream_inner(value, key, true, deadline).await
    }
    pub(super) async fn stream_inner(
        &self,
        value: Validated,
        cache_key: String,
        raw_pcm: bool,
        deadline: Deadline,
    ) -> Result<Response> {
        let permit = self
            .queue
            .enter(
                self.queue.reserve()?,
                &self.cancel,
                deadline,
                speech_timeout,
            )
            .await?;
        // A queued duplicate can replay audio completed while it waited, before
        // switching voice weights or requesting another synthesis.
        if let Some(mut response) = self.cached_response(&cache_key, raw_pcm) {
            response.headers_mut().insert(
                "x-voice-queue-wait",
                permit.wait_ms.to_string().parse().unwrap(),
            );
            response
                .headers_mut()
                .insert("x-accel-buffering", HeaderValue::from_static("no"));
            return Ok(response);
        }
        let (response, permit, deadline) = self.upstream(&value, permit, deadline).await?;
        let mime = response
            .headers()
            .get("content-type")
            .cloned()
            .unwrap_or(HeaderValue::from_static("audio/wav"));
        if raw_pcm
            && (mime.to_str().ok() != Some("audio/pcm")
                || response
                    .headers()
                    .get("x-audio-sample-rate")
                    .and_then(|h| h.to_str().ok())
                    != Some("48000")
                || response
                    .headers()
                    .get("x-audio-channels")
                    .and_then(|h| h.to_str().ok())
                    != Some("1")
                || response
                    .headers()
                    .get("x-audio-format")
                    .and_then(|h| h.to_str().ok())
                    != Some("pcm_s16le"))
        {
            return Err(ApiError::new(
                502,
                "TTS_INVALID_AUDIO",
                "VoxCPM2 未返回 PCM 分片",
            ));
        }
        let wait = permit.wait_ms;
        let cancel = self.cancel.child_token();
        let body_cancel = cancel.clone().drop_guard();
        let (send, receive) = tokio::sync::mpsc::channel(4);
        let complete = Arc::new(AtomicBool::new(false));
        let producer_complete = complete.clone();
        let cache = self.cache.clone();
        let capture_wave = raw_pcm
            || mime.to_str().ok().is_some_and(|value| {
                matches!(
                    value.split(';').next().unwrap_or("").trim(),
                    "audio/wav"
                        | "audio/x-wav"
                        | "audio/wave"
                        | "audio/vnd.wave"
                        | "application/octet-stream"
                )
            });
        // A stalled listener must not keep the GPU queue forever: the bounded
        // producer enforces the same deadline while blocked on downstream flow.
        tokio::spawn(async move {
            let _permit = permit;
            let mut upstream = response.bytes_stream();
            // Reserve the WAV header up front, then keep each PCM sample only once.
            let mut captured = if raw_pcm {
                Some(super::super::payload::pcm_wave_header(48000))
            } else if capture_wave {
                Some(Vec::new())
            } else {
                None
            };
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
                    let valid = captured.as_mut().is_some_and(|bytes| wave::finish(bytes));
                    if Deadline::now() >= deadline {
                        break;
                    }
                    if raw_pcm && !valid {
                        break;
                    }
                    if valid && !send.is_closed() {
                        // A body drop cancels this child token. The cache lock also
                        // checks it so shutdown cannot be followed by a late refill.
                        Self::remember_into(
                            &cache,
                            cache_key,
                            Bytes::from(captured.take().unwrap().into_boxed_slice()),
                            &cancel,
                            deadline,
                        );
                    }
                    if Deadline::now() >= deadline {
                        break;
                    }
                    producer_complete.store(true, Ordering::Release);
                    break;
                };
                let chunk = chunk.map_err(std::io::Error::other);
                let failed = chunk.is_err();
                if let Ok(bytes) = &chunk {
                    if captured
                        .as_ref()
                        .is_some_and(|audio| audio.len().saturating_add(bytes.len()) > AUDIO_LIMIT)
                    {
                        if raw_pcm {
                            break;
                        }
                        // Preserve full-audio forwarding above the cache limit.
                        // Retention stops without growing another unbounded buffer.
                        captured = None;
                    } else if let Some(captured) = &mut captured {
                        captured.extend_from_slice(bytes);
                    }
                }
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
        if raw_pcm {
            response
                .headers_mut()
                .insert("x-audio-sample-rate", HeaderValue::from_static("48000"));
            response
                .headers_mut()
                .insert("x-audio-channels", HeaderValue::from_static("1"));
            response
                .headers_mut()
                .insert("x-audio-format", HeaderValue::from_static("pcm_s16le"));
        }
        response
            .headers_mut()
            .insert("x-voice-queue-wait", wait.to_string().parse().unwrap());
        response
            .headers_mut()
            .insert("x-accel-buffering", HeaderValue::from_static("no"));
        Ok(response)
    }
    pub(super) fn cached_response(&self, key: &str, raw_pcm: bool) -> Option<Response> {
        let wave = self.cached_wave(key)?;
        let mut response = if raw_pcm {
            let (data, pcm) = wave::inspect(&wave)?;
            if !pcm {
                return None;
            }
            (
                [
                    ("content-type", "audio/pcm"),
                    ("x-audio-sample-rate", "48000"),
                    ("x-audio-channels", "1"),
                    ("x-audio-format", "pcm_s16le"),
                    ("x-tts-cache", "hit"),
                ],
                wave.slice(data),
            )
                .into_response()
        } else {
            (
                [("content-type", "audio/wav"), ("x-tts-cache", "hit")],
                wave,
            )
                .into_response()
        };
        response
            .headers_mut()
            .insert("x-voice-queue-wait", HeaderValue::from_static("0"));
        response
            .headers_mut()
            .insert("x-accel-buffering", HeaderValue::from_static("no"));
        Some(response)
    }
}
