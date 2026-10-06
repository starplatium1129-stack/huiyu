use super::*;
impl ControlService {
    pub(super) async fn request(
        &self,
        host: &str,
        path: &str,
        body: Option<&Value>,
        seconds: u64,
    ) -> Result<(u16, Option<Value>)> {
        self.transport
            .json(
                host,
                path,
                body,
                Duration::from_secs(seconds),
                8 * 1024 * 1024,
                &self.shutdown,
            )
            .await
            .map(|(status, body)| (status, body.ok()))
    }
    pub(super) async fn online(&self, index: usize, settings: &Value) -> bool {
        if index == 0 {
            return false;
        }
        if index == 3 {
            return self.voice.translation_status().await["ready"] == true;
        }
        if index == 2 && settings["ttsEngine"] == "voxcpm2" {
            return self
                .request(
                    settings["ttsHost"].as_str().unwrap_or(""),
                    "/health",
                    None,
                    3,
                )
                .await
                .is_ok_and(|(status, data)| {
                    (200..300).contains(&status)
                        && data.is_some_and(|v| v["online"] == true && v["engine"] == "VoxCPM2")
                });
        }
        let (key, path, strict) = match index {
            0 => ("sdHost", "/sdapi/v1/sd-models", false),
            1 => ("comfyHost", "/system_stats", true),
            _ => ("ttsHost", "/docs", false),
        };
        let host = settings[key].as_str().unwrap_or("");
        match self.request(host, path, None, 3).await {
            Ok((status, _)) => {
                let online = (200..if strict { 300 } else { 500 }).contains(&status);
                online
                    && (index != 2
                        || !self
                            .request(host, "/health", None, 2)
                            .await
                            .is_ok_and(|(_, data)| data.is_some_and(|v| v["engine"] == "VoxCPM2")))
            }
            Err(_) if index == 2 => self
                .request(host, "/", None, 3)
                .await
                .is_ok_and(|(status, _)| (200..500).contains(&status)),
            Err(_) => false,
        }
    }
    async fn ollama(&self, settings: &Value) -> Value {
        let host = settings["ollamaHost"].as_str().unwrap_or("");
        match self.request(host, "/api/ps", None, 3).await {
            Ok((status, data)) if (200..300).contains(&status) => {
                let data = data.unwrap_or(Value::Null);
                let models = data["models"].as_array().cloned().unwrap_or_default();
                let names: Vec<&str> = models
                    .iter()
                    .filter_map(|m| m["name"].as_str().or_else(|| m["model"].as_str()))
                    .filter(|s| !s.is_empty())
                    .collect();
                let vram: u64 = models
                    .iter()
                    .map(|m| {
                        m["size_vram"]
                            .as_u64()
                            .or_else(|| m["size"].as_u64())
                            .unwrap_or(0)
                    })
                    .sum();
                json!({"ollamaOnline":true,"ollamaModels":names,"ollamaVram":vram})
            }
            result => {
                let online = if result.is_err() {
                    self.request(host, "/api/tags", None, 3)
                        .await
                        .is_ok_and(|(s, _)| s == 200)
                } else {
                    false
                };
                json!({"ollamaOnline":online,"ollamaModels":[],"ollamaVram":0})
            }
        }
    }
    pub(super) async fn health(&self, fresh: bool) -> Value {
        let _guard = self.probe_lock.lock().await;
        {
            let state = self.state.lock().unwrap();
            if !fresh
                && state
                    .health_at
                    .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
            {
                return state.health.clone();
            }
        }
        let settings = self.settings();
        let (sd, comfy, tts, mut result, llama) = tokio::join!(
            self.online(0, &settings),
            self.online(1, &settings),
            self.online(2, &settings),
            self.ollama(&settings),
            self.llama_status()
        );
        result["sdOnline"] = json!(sd);
        result["comfyOnline"] = json!(comfy);
        result["ttsOnline"] = json!(tts);
        result["llama"] = llama;
        let mut state = self.state.lock().unwrap();
        result["webuiManaged"] = json!(state.managed[0].owned);
        result["comfyManaged"] = json!(state.managed[1].owned);
        state.health = result.clone();
        state.health_at = Some(Instant::now());
        result
    }
    pub(super) async fn online_ollama(&self) -> bool {
        self.ollama(&self.settings()).await["ollamaOnline"] == true
    }
    pub(super) async fn watchdog(self: &Arc<Self>) {
        {
            let mut state = self.state.lock().unwrap();
            state.managed[3].owned = self.voice.translation_owned();
            state.managed[3].desired = state.managed[3].owned;
        }
        let selected = {
            let state = self.state.lock().unwrap();
            if state
                .operation
                .as_ref()
                .is_some_and(|op| op["status"] == "running")
            {
                return;
            }
            state
                .managed
                .iter()
                .enumerate()
                .filter(|(_, m)| m.desired && m.owned)
                .map(|(i, _)| i)
                .collect::<Vec<_>>()
        };
        for index in selected {
            if self.shutdown.is_cancelled() {
                return;
            }
            let sequence = self.state.lock().unwrap().seq;
            let healthy = self.online(index, &self.settings()).await;
            let ready = {
                let mut state = self.state.lock().unwrap();
                // An explicit operation or another watchdog restart supersedes
                // the probe. It must not clear the new cycle's retry state.
                if self.shutdown.is_cancelled()
                    || state.seq != sequence
                    || state
                        .operation
                        .as_ref()
                        .is_some_and(|op| op["status"] == "running")
                {
                    continue;
                }
                if index == 3 {
                    if !state.health.is_object() {
                        state.health = json!({});
                    }
                    state.health["translationOnline"] = json!(healthy);
                }
                let entry = &mut state.managed[index];
                if !entry.desired || !entry.owned {
                    false
                } else if healthy {
                    entry.attempt = 0;
                    entry.next = None;
                    entry.last_error.clear();
                    false
                } else if let Some(next) = entry.next {
                    Instant::now() >= next
                } else {
                    entry.next = Some(Instant::now() + Duration::from_secs(5));
                    false
                }
            };
            if !ready {
                continue;
            }
            let Ok(op) = self.begin("watchdog", &["正在恢复已启动服务", "正在验证服务状态"])
            else {
                return;
            };
            let result = self.service_action(index, true, &op).await;
            {
                let mut state = self.state.lock().unwrap();
                if self.shutdown.is_cancelled()
                    || state
                        .operation
                        .as_ref()
                        .is_none_or(|current| current["id"] != op["id"])
                {
                    return;
                }
                let entry = &mut state.managed[index];
                entry.last_restart = now();
                if let Err(error) = &result {
                    entry.attempt = entry.attempt.saturating_add(1);
                    entry.last_error = error.message.clone();
                    entry.next = Some(
                        Instant::now()
                            + Duration::from_secs(
                                (5u64.saturating_mul(1 << entry.attempt.min(4))).min(30),
                            ),
                    );
                } else {
                    entry.attempt = 0;
                    entry.next = None;
                    entry.last_error.clear();
                }
            }
            self.finish(&op, result);
        }
    }
    pub(super) fn watchdog_status(&self) -> Value {
        let state = self.state.lock().unwrap();
        let mut services = json!({});
        for (index, name) in ["webui", "comfy", "tts", "translation"].iter().enumerate() {
            let m = &state.managed[index];
            let healthy = state.health
                [["sdOnline", "comfyOnline", "ttsOnline", "translationOnline"][index]]
                == true;
            services[name] = json!({"healthy":healthy,"managed":m.desired&&m.owned,"restarting":m.next.is_some(),"attempt":m.attempt,"lastError":self.redact(&m.last_error),"lastRestartAt":m.last_restart});
        }
        json!({"running":!self.shutdown.is_cancelled(),"services":services})
    }
}
