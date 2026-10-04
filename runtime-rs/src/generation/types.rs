use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub sd_host: String,
    pub sd_auth: Option<String>,
    pub comfy_host: String,
    pub ai_workspace_root: PathBuf,
    pub runtime_root: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lora {
    pub id: String,
    pub strength: f64,
    pub file: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub prompt: String,
    pub clean_prompt: String,
    pub negative: String,
    pub profile: String,
    pub model_id: String,
    pub character: Value,
    pub loras: Vec<Lora>,
    pub lora_tags: Vec<Value>,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub cfg: f64,
    pub seed: u64,
    pub sampler: String,
    pub scheduler: String,
    pub webui_scheduler: String,
    pub comfy_unsupported: bool,
    pub hires_fix: bool,
    pub hires_scale: f64,
    pub hires_upscaler: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_hires_upscaler: Option<String>,
    pub hires_steps: u32,
    pub denoising_strength: f64,
    pub face_detailer: bool,
    pub auto_hires: bool,
    pub super_res_wanted: bool,
    pub comfy_hires: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub super_res_model: Option<String>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebUiStatus {
    pub online: bool,
    pub wai_available: bool,
    pub checkpoint: String,
    pub samplers: Vec<String>,
    pub schedulers: Vec<String>,
    pub upscalers: Vec<String>,
    pub models: Vec<String>,
}
