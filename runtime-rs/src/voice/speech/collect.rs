use super::*;

impl Speech {
    pub(super) async fn collect(
        &self,
        value: Validated,
        reservation: Reservation,
        key: &str,
        deadline: Deadline,
    ) -> Result<(Bytes, String)> {
        let mut permit = Some(
            self.queue
                .enter(reservation, &self.cancel, deadline, speech_timeout)
                .await?,
        );
        if let Some(audio) = self.cached_audio(key) {
            return Ok((audio.bytes, audio.content_type));
        }
        let settings = self.current_settings();
        let (mut bytes, content_type) = match settings.engine {
            Engine::Off => return Err(ApiError::new(409, "VOICE_DISABLED", "当前已关闭语音朗读")),
            Engine::System => {
                return Err(ApiError::new(
                    409,
                    "VOICE_CLIENT_SIDE",
                    "当前使用系统朗读，请由客户端直接播放",
                ));
            }
            Engine::OpenAiTts => {
                self.synthesize_openai(&settings, &value.payload, deadline)
                    .await?
            }
            Engine::GptSoVitsNative => {
                let audio = self
                    .native
                    .execute(&value, permit.as_ref().unwrap(), deadline, true)
                    .await?;
                self.active.lock().unwrap().voice = value.voice.clone();
                (audio.to_vec(), "audio/wav".to_owned())
            }
            Engine::GptSoVits | Engine::VoxCpm2 => {
                let (response, held, deadline) = self
                    .upstream(&settings, &value, permit.take().unwrap(), deadline)
                    .await?;
                permit = Some(held);
                let mime = response
                    .headers()
                    .get("content-type")
                    .and_then(|h| h.to_str().ok())
                    .and_then(|raw| raw.split(';').next().map(str::trim))
                    .filter(|m| m.starts_with("audio/"))
                    .unwrap_or("audio/wav")
                    .to_owned();
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
                (bytes, mime)
            }
        };
        if bytes.len() < 64 {
            return Err(ApiError::new(502, "TTS_EMPTY_AUDIO", "语音服务返回空音频"));
        }
        let is_wav = matches!(
            content_type.as_str(),
            "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave"
        );
        if is_wav {
            // A truncated WAV must not become a reusable complete sentence.
            let finished = wave::finish(&mut bytes);
            if settings.engine == Engine::GptSoVitsNative && finished.is_none() {
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
                        content_type: content_type.clone(),
                        pcm: pcm.then_some(data),
                    },
                    &self.cancel,
                    deadline,
                );
            }
            remaining(deadline, Duration::MAX, speech_timeout)?;
            drop(permit);
            return Ok((bytes, content_type));
        }
        let bytes = Bytes::from(bytes.into_boxed_slice());
        remaining(deadline, Duration::MAX, speech_timeout)?;
        Self::remember_into(
            &self.cache,
            key.to_owned(),
            CachedAudio {
                bytes: bytes.clone(),
                content_type: content_type.clone(),
                pcm: None,
            },
            &self.cancel,
            deadline,
        );
        remaining(deadline, Duration::MAX, speech_timeout)?;
        drop(permit);
        Ok((bytes, content_type))
    }
}
