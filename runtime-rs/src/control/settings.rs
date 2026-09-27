use super::*;
use std::io::Write;
impl ControlService {
    /// A single writer preserves unrelated settings. The lock moves into the
    /// blocking operation, so HTTP cancellation cannot release it mid-commit.
    pub(super) async fn patch(&self, patch: Value) -> Result<Value> {
        let effective = self.settings();
        for (key, env) in [
            ("sdHost", "SD_HOST"),
            ("comfyHost", "COMFY_HOST"),
            ("ttsHost", "TTS_HOST"),
            ("ollamaHost", "OLLAMA_HOST"),
        ] {
            if std::env::var(env).is_ok_and(|v| !v.is_empty())
                && patch.get(key).is_some_and(|value| value != &effective[key])
            {
                return Err(ApiError::new(
                    409,
                    "CONFIG_ENV_OVERRIDE",
                    format!("{key} 由启动环境 {env} 指定，请修改启动环境后重启"),
                ));
            }
        }
        let guard = self.config_write.clone().lock_owned().await;
        if self.shutdown.is_cancelled() {
            return Err(ApiError::new(503, "SHUTTING_DOWN", "运行时正在退出"));
        }
        let root = self.config.runtime_root.clone();
        let copy = patch.clone();
        let snapshot = self.saved.clone();
        self.tasks
            .spawn_blocking(move || -> Result<()> {
                let _guard = guard;
                std::fs::create_dir_all(&root)?;
                let file = root.join("config.json");
                let mut saved = match std::fs::read(&file) {
                    Ok(bytes) => serde_json::from_slice::<Value>(&bytes)?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
                    Err(e) => return Err(e.into()),
                };
                let object = saved.as_object_mut().ok_or_else(|| {
                    ApiError::new(409, "INVALID_SAVED_CONFIG", "现有配置无效，拒绝覆盖")
                })?;
                for (key, value) in copy
                    .as_object()
                    .ok_or_else(|| ApiError::invalid("配置必须为对象"))?
                {
                    object.insert(key.clone(), value.clone());
                }
                let mut temp = tempfile::NamedTempFile::new_in(&root)?;
                temp.write_all(&serde_json::to_vec_pretty(&saved)?)?;
                temp.write_all(b"\n")?;
                temp.as_file().sync_all()?;
                temp.persist(&file)
                    .map_err(|error| ApiError::from(error.error))?;
                *snapshot.write().unwrap() = saved;
                Ok(())
            })
            .await
            .map_err(|_| ApiError::new(503, "CONFIG_WRITE_FAILED", "配置保存失败"))??;
        Ok(self.config_view())
    }
    pub(super) fn config_view(&self) -> Value {
        let mut result = self.settings();
        let saved = self.saved.read().unwrap();
        let mut target = result.clone();
        for (key, env) in [
            ("sdHost", "SD_HOST"),
            ("comfyHost", "COMFY_HOST"),
            ("ttsHost", "TTS_HOST"),
            ("ollamaHost", "OLLAMA_HOST"),
        ] {
            if std::env::var(env).is_ok_and(|s| !s.is_empty()) {
                continue;
            }
            if let Some(value) = saved[key]
                .as_str()
                .and_then(|s| crate::upstream::local_url(s).ok())
            {
                target[key] = json!(value.origin().ascii_serialization());
            }
        }
        if saved["voices"].is_object() {
            target["voices"] = saved["voices"].clone();
        }
        let restart = ["sdHost", "comfyHost", "ttsHost", "ollamaHost", "voices"]
            .iter()
            .any(|key| target[*key] != result[*key]);
        result["savedConfig"] = target;
        result["restartRequired"] = json!(restart);
        result["message"] = json!(if restart {
            "配置已保存，重新启动应用后生效"
        } else {
            "配置已保存"
        });
        result
    }
}
