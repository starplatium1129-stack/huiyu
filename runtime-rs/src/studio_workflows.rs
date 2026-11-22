//! Director-facing recipes expand to a whitelisted native video model.
use crate::error::{ApiError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};

pub(crate) const MODEL: &str = "wan2.2-i2v-a14b-gguf";
pub(crate) const DIALOGUE: &str = "musetalk-1.5";
fn invalid(message: &str) -> ApiError {
    ApiError::new(400, "STUDIO_VIDEO_WORKFLOW", message)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Template {
    pub id: String,
    pub version: u32,
    label: String,
    pub mode: String,
    model_id: String,
    steps: BTreeMap<String, u32>,
    tiled_vae: bool,
    default_prompt: String,
}
impl Template {
    fn validate(&self) -> Result<()> {
        if self.id.is_empty()
            || self.id.len() > 64
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || self.version == 0
            || self.label.trim().is_empty()
            || self.label.len() > 196
            || !match self.mode.as_str() {
                "dialogue" => self.model_id == DIALOGUE && self.steps.values().all(|n| *n == 1),
                "first" | "first-last" => {
                    self.model_id == MODEL
                        && self.tiled_vae
                        && self.steps.values().all(|n| matches!(n, 4 | 8))
                }
                _ => false,
            }
            || self.default_prompt.trim().is_empty()
            || self.default_prompt.encode_utf16().count() > 4000
            || self.steps.len() != 3
            || ["fast", "standard", "quality"]
                .iter()
                .any(|k| !self.steps.contains_key(*k))
        {
            return Err(invalid("视频模板的模型、步数、分块解码或输入模式无效"));
        }
        Ok(())
    }
    pub fn summary(&self) -> Value {
        json!({"id":self.id,"version":self.version,"label":self.label,"mode":self.mode,"steps":self.steps})
    }
}
pub(crate) struct Catalog {
    pub templates: Vec<Template>,
    pub warnings: Vec<String>,
}

pub(crate) async fn load(root: PathBuf) -> Result<Catalog> {
    let templates: Vec<Template> =
        serde_json::from_str(include_str!("video/studio-workflows.json"))?;
    let mut catalog = Catalog {
        templates,
        warnings: Vec::new(),
    };
    let mut ids = std::collections::HashSet::new();
    for template in &catalog.templates {
        template.validate()?;
        if !ids.insert(template.id.clone()) {
            return Err(invalid("内置视频模板 ID 重复"));
        }
    }
    let mut paths = Vec::new();
    match tokio::fs::read_dir(root.join("workflows/studio-video")).await {
        Ok(mut dir) => loop {
            let entry = match dir.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(e) => {
                    catalog.warnings.push(format!("读取模板目录失败：{e}"));
                    break;
                }
            };
            if entry.file_type().await.is_ok_and(|t| t.is_file())
                && entry.path().extension().is_some_and(|ext| ext == "json")
            {
                if paths.len() >= 64 {
                    catalog
                        .warnings
                        .push("本地工作流目录最多支持 64 个 JSON 模板。".into());
                    break;
                }
                paths.push(entry.path());
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => catalog.warnings.push(format!("无法打开本地模板目录：{e}")),
    };
    paths.sort();
    for path in paths {
        let plugin: Result<Template> = async {
            use tokio::io::AsyncReadExt;
            let mut file = tokio::fs::File::open(&path).await?.take(32_769);
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).await?;
            if bytes.len() > 32_768 {
                return Err(invalid("文件超过 32 KiB"));
            }
            let template: Template = serde_json::from_slice(&bytes)?;
            template.validate()?;
            if !ids.insert(template.id.clone()) {
                return Err(invalid("视频模板 ID 重复"));
            }
            Ok(template)
        }
        .await;
        match plugin {
            Ok(template) => catalog.templates.push(template),
            Err(e) => catalog.warnings.push(format!(
                "{}：{}",
                path.file_name().unwrap_or_default().to_string_lossy(),
                e.message
            )),
        }
    }
    Ok(catalog)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Choice {
    pub shot_id: String,
    pub expected_revision: i64,
    mode: String,
    template_id: Option<String>,
    camera: String,
    motion: String,
    quality: String,
    resolution: u32,
    seconds: u32,
    seed: Option<u32>,
    prompt: Option<String>,
    pub frame_plan: Option<FramePlan>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FramePlan {
    pub model_id: String,
    pub reference_version_ids: Vec<String>,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    pub canvas: Option<String>,
}
impl Choice {
    pub(crate) fn compile(
        &self,
        templates: &[Template],
        shot: &Value,
    ) -> Result<(Value, Value, Value)> {
        let id = self
            .template_id
            .as_deref()
            .unwrap_or(match self.mode.as_str() {
                "first-last" => "wan22-flf",
                "dialogue" => "dialogue-audio",
                _ => "wan22-i2v",
            });
        let template = templates
            .iter()
            .find(|t| t.id == id && t.mode == self.mode)
            .ok_or_else(|| invalid("模板与所选首尾帧模式不匹配"))?;
        let camera = match self.camera.as_str() {
            "fixed" => "still",
            "push" => "push",
            "pull" => "pull",
            "pan" => "pan-tripod",
            "track" => "track-lateral",
            _ => return Err(invalid("运镜选择无效")),
        };
        let motion = match self.motion.as_str() {
            "low" => "subtle",
            "medium" => "natural",
            "high" => "expressive",
            _ => return Err(invalid("动态幅度无效")),
        };
        let quality = match self.quality.as_str() {
            "fast" => "fast",
            "standard" => "standard",
            "quality" => "fine",
            _ => return Err(invalid("视频档位无效")),
        };
        if !matches!(self.resolution, 480 | 720)
            || !matches!(self.seconds, 2 | 3 | 5)
            || self.seed.is_some_and(|n| n > i32::MAX as u32)
        {
            return Err(invalid("视频分辨率、时长或种子无效"));
        }
        let selected = self
            .prompt
            .as_deref()
            .unwrap_or_else(|| shot["prompt"].as_str().unwrap_or(""))
            .trim();
        let prompt = if selected.is_empty() {
            &template.default_prompt
        } else {
            selected
        };
        if prompt.encode_utf16().count() > 4000 || prompt.contains('\0') {
            return Err(invalid("镜头动态描述最多 4000 字符"));
        }
        let seed = self
            .seed
            .unwrap_or_else(|| (uuid::Uuid::new_v4().as_u128() & i32::MAX as u128) as u32);
        let settings = json!({"mode":self.mode,"camera":self.camera,"motion":self.motion,"quality":self.quality,
            "resolution":self.resolution,"seconds":self.seconds,"seed":seed,"prompt":prompt});
        let mut input = json!({"modelId":template.model_id,"aspectRatio":"original",
            "camera":camera,"motion":motion,"quality":quality,"duration":self.seconds,"seed":seed,"prompt":prompt,"steps":template.steps[&self.quality]});
        if template.mode != "dialogue" {
            input["wanResolution"] = self.resolution.into();
        }
        let mut binding = template.summary();
        binding["sha256"] = json!(crate::storage::json_fingerprint(&serde_json::to_value(
            template
        )?));
        Ok((settings, input, binding))
    }
}
