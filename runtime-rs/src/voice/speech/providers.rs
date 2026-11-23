use super::*;
use crate::byte_buffer::Buffer;
use crate::voice::queue::Permit;
use futures_util::StreamExt;

impl Speech {
    async fn activate(
        &self,
        settings: &Settings,
        value: &Validated,
        deadline: Deadline,
    ) -> Result<()> {
        if settings.engine == Engine::VoxCpm2 {
            let same = {
                let active = self.active.lock().unwrap();
                active.voice == value.voice && active.lora == value.profile.lora_weights_path
            };
            if !same {
                *self.active.lock().unwrap() = Active::default();
                let (status, _) = self
                    .transport
                    .json(
                        &settings.tts_host,
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
                    &settings.tts_host,
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
        let settings = self.current_settings();
        match settings.engine {
            Engine::Off => return Err(ApiError::new(409, "VOICE_DISABLED", "当前已关闭语音朗读")),
            Engine::System => return Ok(()),
            Engine::OpenAiTts => {
                return if settings.openai.configured() {
                    Ok(())
                } else {
                    Err(ApiError::new(
                        409,
                        "VOICE_UNCONFIGURED",
                        "请先在控制室「语音配置」填写语音接口地址与模型",
                    ))
                };
            }
            _ => {}
        }
        let work = async {
            let permit = self
                .queue
                .enter(
                    self.queue.reserve()?,
                    &self.cancel,
                    deadline,
                    speech_timeout,
                )
                .await?;
            if settings.engine == Engine::GptSoVitsNative {
                self.native.execute(value, &permit, deadline, false).await?;
                self.active.lock().unwrap().voice = value.voice.clone();
                return Ok(());
            }
            // A profile without weight paths still needs a real reachability check.
            if self.status().await["online"] != true {
                return Err(ApiError::new(
                    503,
                    "TTS_UNAVAILABLE",
                    "当前语音引擎尚未运行",
                ));
            }
            self.activate(&settings, value, deadline).await
        };
        let result = tokio::time::timeout_at(deadline, work)
            .await
            .map_err(|_| speech_timeout())?;
        remaining(deadline, Duration::MAX, speech_timeout)?;
        result
    }
    pub(in crate::voice) async fn synthesize_openai(
        &self,
        settings: &Settings,
        payload: &Value,
        deadline: Deadline,
    ) -> Result<(Vec<u8>, String)> {
        if !settings.openai.configured() {
            return Err(ApiError::new(
                409,
                "VOICE_UNCONFIGURED",
                "请先填写语音接口地址与模型",
            ));
        }
        let endpoint = format!(
            "{}/audio/speech",
            settings.openai.base_url.trim_end_matches('/')
        );
        let mut request = self
            .http_client
            .post(endpoint)
            .json(payload)
            .timeout(remaining(
                deadline,
                Duration::from_secs(60),
                speech_timeout,
            )?);
        if !settings.openai.api_key.is_empty() {
            request = request.bearer_auth(&settings.openai.api_key);
        }
        let response = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(cancelled()),
            _ = tokio::time::sleep_until(deadline) => return Err(speech_timeout()),
            response = request.send() => response.map_err(|_| ApiError::new(502, "TTS_FAILED", "云端语音接口连接失败或超时"))?,
        };
        if !response.status().is_success() {
            let status = if response.status().is_client_error() {
                response.status().as_u16()
            } else {
                502
            };
            let detail = response.bytes().await.ok().and_then(|bytes| {
                let slice = &bytes[..bytes.len().min(16 * 1024)];
                serde_json::from_slice::<Value>(slice)
                    .ok()
                    .or_else(|| Some(Value::String(String::from_utf8_lossy(slice).into_owned())))
            });
            return Err(ApiError::new(
                status,
                "TTS_FAILED",
                crate::upstream::diagnostic_message(
                    detail.as_ref().unwrap_or(&Value::Null),
                    "云端语音接口返回错误",
                ),
            ));
        }
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .and_then(|raw| raw.split(';').next().map(str::trim))
            .filter(|m| m.starts_with("audio/"))
            .unwrap_or_else(|| settings.openai.mime_type())
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
            let chunk = chunk.map_err(|_| ApiError::new(502, "TTS_FAILED", "云端语音传输中断"))?;
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
            return Err(ApiError::new(
                502,
                "TTS_EMPTY_AUDIO",
                "语音接口返回了空音频",
            ));
        }
        Ok((bytes, mime))
    }
    pub(super) async fn upstream(
        &self,
        settings: &Settings,
        value: &Validated,
        permit: Permit,
        deadline: Deadline,
    ) -> Result<(reqwest::Response, Permit, tokio::time::Instant)> {
        let prepared = tokio::time::timeout_at(deadline, self.activate(settings, value, deadline))
            .await
            .map_err(|_| speech_timeout())?;
        remaining(deadline, Duration::MAX, speech_timeout)?;
        prepared?;
        let request = self
            .transport
            .client
            .post(format!("{}/tts", settings.tts_host))
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
                Some(
                    serde_json::from_slice::<Value>(bytes.as_ref()).unwrap_or_else(|_| {
                        Value::String(String::from_utf8(bytes.into_vec()).unwrap_or_else(|error| {
                            String::from_utf8_lossy(error.as_bytes()).into_owned()
                        }))
                    }),
                )
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
}
