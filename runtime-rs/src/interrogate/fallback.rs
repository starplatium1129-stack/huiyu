use super::{settings::Settings, temporary::Temporary};
use crate::{
    error::{ApiError, Result},
    upstream::LocalUpstream,
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) struct Fallback {
    settings: Settings,
    transport: LocalUpstream,
    temporary: Arc<Temporary>,
}
impl Fallback {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings,
            transport: LocalUpstream::new(),
            temporary: Temporary::new(),
        }
    }
    pub async fn webui(
        &self,
        base64: String,
        threshold: f64,
        cancel: &CancellationToken,
    ) -> Result<Option<Value>> {
        let mut body = json!({"threshold":threshold,"model":"wd-v1-4-moat-tagger-v2"});
        body["image"] = Value::String(base64);
        for path in ["/tagger/v1/interrogate", "/sdapi/v1/interrogate"] {
            if path.starts_with("/sdapi") {
                body["model"] = json!("wd14");
                body.as_object_mut().unwrap().remove("threshold");
            }
            let response = self
                .transport
                .json(
                    &self.settings.sd,
                    path,
                    Some(&body),
                    Duration::from_secs(12),
                    4 * 1024 * 1024,
                    cancel,
                )
                .await;
            if cancel.is_cancelled() {
                return Err(cancelled());
            }
            if let Ok((status, Some(result), _)) = response {
                if !(200..300).contains(&status) {
                    continue;
                }
                let tags = if path.starts_with("/tagger") {
                    result["tags"].as_array().map(|tags| {
                        tags.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect::<Vec<_>>()
                    })
                } else {
                    None
                }
                .or_else(|| {
                    result["caption"].as_str().map(|caption| {
                        caption
                            .split(',')
                            .map(str::trim)
                            .filter(|tag| !tag.is_empty())
                            .map(str::to_owned)
                            .collect()
                    })
                });
                if let Some(tags) = tags.filter(|tags| !tags.is_empty()) {
                    return Ok(Some(
                        json!({"tags":tags,"scores":result.get("scores").filter(|value|value.is_object()).cloned().unwrap_or(json!({}))}),
                    ));
                }
            }
        }
        Ok(None)
    }
    pub async fn comfy(&self, image: &[u8], cancel: &CancellationToken) -> Result<Option<Value>> {
        let result: Result<Option<Value>> = async {
            let (status, info, _) = self
                .transport
                .json(
                    &self.settings.comfy,
                    "/object_info",
                    None,
                    Duration::from_secs(5),
                    4 * 1024 * 1024,
                    cancel,
                )
                .await?;
            let info = info.unwrap_or(Value::Null);
            if !(200..300).contains(&status)
                || !info
                    .get("WD14Tagger|pysssss")
                    .or_else(|| info.get("WD14Tagger"))
                    .is_some_and(Value::is_object)
            {
                return Ok(None);
            }
            let file = self
                .temporary
                .write(&self.settings.comfy_input, image, cancel)
                .await?;
            let name = file
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| ApiError::invalid("Invalid temporary input identity"))?;
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("filename", name)
                .append_pair("type", "input")
                .finish();
            // Preserve the installed node API: it applies its own configured tag
            // threshold and may fetch its own weights. No fabricated scores.
            let (status, value, raw) = self
                .transport
                .json(
                    &self.settings.comfy,
                    &format!("/pysssss/wd14tagger/tag?{query}"),
                    None,
                    Duration::from_secs(60),
                    4 * 1024 * 1024,
                    cancel,
                )
                .await?;
            if !(200..300).contains(&status) {
                return Ok(None);
            }
            let text = match value {
                Some(Value::String(text)) => text,
                Some(Value::Array(items)) => items
                    .first()
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                None => raw,
                _ => String::new(),
            };
            let mut keys = HashMap::<String, usize>::new();
            let mut tags = Vec::<String>::new();
            for tag in text
                .trim()
                .split(',')
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
            {
                let tag = tag.split_whitespace().collect::<Vec<_>>().join("_");
                let key = tag.to_lowercase();
                if let Some(index) = keys.get(&key) {
                    tags[*index] = tag;
                } else {
                    keys.insert(key, tags.len());
                    tags.push(tag);
                }
            }
            if tags.is_empty() {
                return Ok(None);
            }
            Ok(Some(
                json!({"tags":tags,"scores":{},"caption":tags.join(", ")}),
            ))
        }
        .await;
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        result.or(Ok(None))
    }
    pub async fn close(&self) {
        self.temporary.close().await;
    }
}
pub(super) fn cancelled() -> ApiError {
    ApiError::new(499, "CANCELLED", "图片反推已取消")
}
