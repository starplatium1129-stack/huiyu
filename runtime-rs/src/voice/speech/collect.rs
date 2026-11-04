use super::*;

impl Speech {
    pub(super) async fn collect(
        &self,
        value: Validated,
        reservation: Reservation,
        key: &str,
        deadline: Deadline,
    ) -> Result<Bytes> {
        let mut permit = Some(
            self.queue
                .enter(reservation, &self.cancel, deadline, speech_timeout)
                .await?,
        );
        if let Some(audio) = self.cached_audio(key) {
            return Ok(audio.bytes);
        }
        let mut bytes = if self.settings.engine == Engine::GptSoVitsNative {
            let audio = self
                .native
                .execute(&value, permit.as_ref().unwrap(), deadline, true)
                .await?;
            self.active.lock().unwrap().voice = value.voice.clone();
            audio.to_vec()
        } else {
            let (response, held, deadline) = self
                .upstream(&value, permit.take().unwrap(), deadline)
                .await?;
            permit = Some(held);
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            loop {
                let chunk = tokio::select! {
                    biased;
                    _ = self.cancel.cancelled() => return Err(cancelled()),
                    _ = tokio::time::sleep_until(deadline) => return Err(speech_timeout()),
                    chunk = stream.next() => chunk,
                };
                let Some(chunk) = chunk else { break };
                let chunk =
                    chunk.map_err(|_| ApiError::new(502, "TTS_FAILED", "语音音频传输失败"))?;
                if bytes.len().saturating_add(chunk.len()) > AUDIO_LIMIT {
                    return Err(ApiError::new(
                        502,
                        "TTS_AUDIO_TOO_LARGE",
                        "生成的单句音频超过缓存播放上限",
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            bytes
        };
        if bytes.len() < 64 {
            return Err(ApiError::new(502, "TTS_EMPTY_AUDIO", "语音服务返回空音频"));
        }
        // A truncated WAV must not become a reusable complete sentence.
        let finished = wave::finish(&mut bytes);
        if self.settings.engine == Engine::GptSoVitsNative && finished.is_none() {
            self.native
                .retire(permit.as_ref().unwrap().serial.clone())
                .await?;
            return Err(ApiError::new(
                502,
                "TTS_INVALID_AUDIO",
                "本机语音返回了无效音频",
            ));
        }
        let bytes = Bytes::from(bytes.into_boxed_slice());
        remaining(deadline, Duration::MAX, speech_timeout)?;
        if let Some((data, pcm)) = finished {
            Self::remember_into(
                &self.cache,
                key.to_owned(),
                CachedAudio {
                    bytes: bytes.clone(),
                    pcm: pcm.then_some(data),
                },
                &self.cancel,
                deadline,
            );
        }
        remaining(deadline, Duration::MAX, speech_timeout)?;
        drop(permit);
        Ok(bytes)
    }
}
