use super::super::config::Engine;
use super::{Speech, Validated};
use crate::error::{ApiError, Result};
use axum::{
    body::{Body, Bytes},
    http::HeaderValue,
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

impl Speech {
    pub async fn stream_pcm(self: &Arc<Self>, mut value: Validated) -> Result<Response> {
        if self.settings.engine != Engine::VoxCpm2 {
            return Err(ApiError::new(
                409,
                "TTS_STREAM_UNAVAILABLE",
                "当前语音引擎未提供 PCM 分片",
            ));
        }
        let key = self.cache_key(&value);
        let cached = self
            .cache
            .lock()
            .unwrap()
            .entries
            .iter()
            .find(|(id, _)| *id == key)
            .map(|(_, bytes)| bytes.clone());
        if let Some(wave) = cached {
            return Ok((
                [
                    ("content-type", "audio/pcm"),
                    ("x-audio-sample-rate", "48000"),
                    ("x-audio-channels", "1"),
                    ("x-audio-format", "pcm_s16le"),
                    ("x-tts-cache", "hit"),
                ],
                wave.slice(44..),
            )
                .into_response());
        }
        value.payload["streaming_mode"] = true.into();
        value.payload["media_type"] = "raw".into();
        self.stream_inner(value, Some(key)).await
    }
    pub(super) async fn stream_inner(
        &self,
        value: Validated,
        cache_key: Option<String>,
    ) -> Result<Response> {
        let (response, permit, deadline) = self.upstream(&value, self.queue.reserve()?).await?;
        let mime = response
            .headers()
            .get("content-type")
            .cloned()
            .unwrap_or(HeaderValue::from_static("audio/wav"));
        if cache_key.is_some()
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
        let raw_pcm = cache_key.is_some();
        let cache = self.cache.clone();
        // A stalled listener must not keep the GPU queue forever: the bounded
        // producer enforces the same deadline while blocked on downstream flow.
        tokio::spawn(async move {
            let _permit = permit;
            let mut upstream = response.bytes_stream();
            let mut captured = Vec::new();
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
                    if raw_pcm && (captured.is_empty() || captured.len() % 2 != 0) {
                        break;
                    }
                    if let Some(key) = cache_key {
                        if !captured.is_empty() {
                            let wave = super::super::payload::pcm_wave(&captured, 48000);
                            Self::remember_into(&cache, key, Bytes::from(wave));
                        }
                    }
                    producer_complete.store(true, Ordering::Release);
                    break;
                };
                let chunk = chunk.map_err(std::io::Error::other);
                let failed = chunk.is_err();
                if raw_pcm {
                    if let Ok(bytes) = &chunk {
                        if captured.len().saturating_add(bytes.len()) > 128 * 1024 * 1024 {
                            break;
                        }
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
}
