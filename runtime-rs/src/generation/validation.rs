use super::{constants::*, types::*};
use crate::error::{ApiError, Result};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

static ADULT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)(?:nude|naked|completely_naked|explicit|nsfw|nene_r18|natsume_r18|exposed_pussy|pink_nipples)(?-u:\b)").unwrap()
});
static TAGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<lora:([^:>]+):([^>]+)>").unwrap());
static STRIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<lora:[^>]+>").unwrap());
static COMMAS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",\s*,").unwrap());
static EDGES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*,|,\s*$").unwrap());
fn error(code: &str, message: impl Into<String>) -> ApiError {
    ApiError::new(400, code, message)
}
fn number(value: &Value, name: &str, min: f64, max: f64, integer: bool) -> Result<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= min && *n <= max && (!integer || n.fract() == 0.))
        .ok_or_else(|| error("INVALID_PARAMETER", format!("{name} 超出允许范围")))
}
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.is_empty(),
        Value::Number(v) => v.as_f64() != Some(0.),
        _ => true,
    }
}
pub(crate) fn adult_intent(prompt: &str) -> bool {
    ADULT.is_match(prompt)
}
pub(super) fn strip_loras(value: &str) -> String {
    STRIP.replace_all(value, "").trim().into()
}
pub fn validate(body: &Value, direct_local: bool) -> Result<Input> {
    let object = body
        .as_object()
        .ok_or_else(|| error("INVALID_BODY", "请求体必须是 JSON 对象"))?;
    for key in object.keys() {
        if !ALLOWED.contains(&key.as_str()) {
            return Err(error("UNKNOWN_PARAMETER", format!("不支持的参数：{key}")));
        }
    }
    if !direct_local && body["prompt"].as_str().is_some_and(|p| ADULT.is_match(p)) {
        return Err(ApiError::new(
            403,
            "ADULT_REMOTE_NOT_ALLOWED",
            "成人内容仅限本机直连使用",
        ));
    }
    let prompt = body["prompt"]
        .as_str()
        .filter(|p| !p.trim().is_empty() && p.encode_utf16().count() <= 12000)
        .ok_or_else(|| error("INVALID_PARAMETER", "prompt 无效"))?;
    let negative = match object.get("negative") {
        None => "",
        Some(Value::String(s)) if s.encode_utf16().count() <= 8000 => s,
        _ => return Err(error("INVALID_PARAMETER", "negative 无效")),
    };
    if object.get("modelId").is_some_and(|id| id != MODEL) {
        return Err(error("UNKNOWN_MODEL", "未知 WAI checkpoint"));
    }
    let empty = Vec::new();
    let raw = object
        .get("loras")
        .map(Value::as_array)
        .unwrap_or(Some(&empty))
        .filter(|a| a.len() <= 2)
        .ok_or_else(|| error("INVALID_PARAMETER", "LoRA 列表无效"))?;
    let mut loras = Vec::new();
    for item in raw {
        let spec = LORAS
            .iter()
            .find(|(id, _, _)| item["id"] == *id)
            .ok_or_else(|| error("UNKNOWN_LORA", "未知 WAI LoRA"))?;
        if loras.iter().any(|l: &Lora| l.id == spec.0) {
            return Err(error("INVALID_PARAMETER", "LoRA 不得重复"));
        }
        loras.push(Lora {
            id: spec.0.into(),
            file: spec.1.into(),
            strength: number(
                &item["strength"],
                "loraStrength",
                if raw.len() == 2 { 0.45 } else { 0.65 },
                if raw.len() == 2 { 0.70 } else { 1. },
                false,
            )?,
        });
    }
    let width = number(&body["width"], "width", 512., 1536., true)? as u32;
    let height = number(&body["height"], "height", 512., 2048., true)? as u32;
    if !width.is_multiple_of(64) || !height.is_multiple_of(64) {
        return Err(error("INVALID_PARAMETER", "输出尺寸必须符合 64 对齐契约"));
    }
    let requested_sampler = if truthy(&body["sampler"]) {
        &body["sampler"]
    } else {
        &json!("DPM++ 2M")
    };
    let requested_sampler = requested_sampler
        .as_str()
        .filter(|s| s.encode_utf16().count() <= 80)
        .ok_or_else(|| error("UNSUPPORTED_SAMPLER", "采样器名称无效"))?;
    let mapped = sampler(requested_sampler);
    let mut unsupported = mapped.is_none();
    if let Some((_, mapped_scheduler)) = mapped
        && object.contains_key("scheduler")
        && body["scheduler"] != ""
        && body["scheduler"] != mapped_scheduler
        && !(requested_sampler == "DPM++ 2M"
            && matches!(body["scheduler"].as_str(), Some("Karras" | "karras")))
    {
        unsupported = true;
    }
    let negative_seed = body["seed"]
        .as_f64()
        .or_else(|| body["seed"].as_str().and_then(|s| s.parse().ok()))
        .is_some_and(|n| n < 0.);
    let seed = if !object.contains_key("seed") || negative_seed {
        (uuid::Uuid::new_v4().as_u128() % 2_147_483_647) as u64
    } else {
        number(&body["seed"], "seed", 0., 9_007_199_254_740_991., true)? as u64
    };
    let mut tags = Vec::new();
    for captures in TAGS.captures_iter(prompt) {
        let name = captures[1].trim();
        let weight = captures[2].trim().parse::<f64>().ok();
        let matching = loras.iter().find(|l| {
            l.file
                .trim_end_matches(".safetensors")
                .eq_ignore_ascii_case(name)
        });
        if matching.is_none()
            || weight.is_none_or(|w| {
                !w.is_finite() || matching.is_none_or(|l| (w - l.strength).abs() > 0.0001)
            })
        {
            unsupported = true;
        }
        tags.push(json!({"name":name,"weight":weight.filter(|w|w.is_finite())}));
    }
    let stripped = STRIP.replace_all(prompt, "");
    let comma_clean = COMMAS.replace_all(&stripped, ",");
    let clean = EDGES.replace_all(&comma_clean, "").trim().to_owned();
    let get_number = |key: &str, default: f64, min: f64, max: f64, integer: bool| {
        number(
            object.get(key).unwrap_or(&json!(default)),
            key,
            min,
            max,
            integer,
        )
    };
    let hires_fix = truthy(&body["hiresFix"]);
    let upscaler = body["hiresUpscaler"].as_str().unwrap_or("Latent");
    if !UPSCALERS.contains(&upscaler) {
        return Err(error("UNSUPPORTED_UPSCALER", "放大器不在服务端白名单"));
    }
    let hires_scale = get_number("hiresScale", 1.5, 1., 2., false)?;
    let hires_steps = get_number("hiresSteps", 14., 1., 60., true)? as u32;
    let denoising_strength = get_number("denoisingStrength", 0.35, 0., 1., false)?;
    let auto_hires = hires_fix && upscaler == "Auto";
    let super_res_wanted = hires_fix && SUPER_RES.contains(&upscaler);
    let comfy_hires = hires_fix
        && (auto_hires
            || matches!(upscaler, "Latent" | "Latent (nearest-exact)")
            || super_res_wanted)
        && (1.25..=1.5).contains(&hires_scale)
        && (8..=24).contains(&hires_steps)
        && (0.25..=0.5).contains(&denoising_strength)
        && f64::from(width) * f64::from(height) * hires_scale * hires_scale <= 3_200_000.;
    Ok(Input {
        prompt: prompt.trim().into(),
        clean_prompt: clean,
        negative: negative.trim().into(),
        profile: body["profile"].as_str().unwrap_or("").into(),
        model_id: MODEL.into(),
        character: if truthy(&body["character"]) {
            body["character"].clone()
        } else {
            json!("")
        },
        loras,
        lora_tags: tags,
        width,
        height,
        steps: get_number("steps", 28., 1., 60., true)? as u32,
        cfg: get_number("cfg", 5.5, 0.5, 20., false)?,
        seed,
        sampler: requested_sampler.into(),
        scheduler: if matches!(body["scheduler"].as_str(), Some("Karras" | "karras")) {
            "karras"
        } else {
            mapped.map(|(_, s)| s).unwrap_or("normal")
        }
        .into(),
        webui_scheduler: body["scheduler"].as_str().unwrap_or("").into(),
        comfy_unsupported: unsupported || (hires_fix && !comfy_hires),
        hires_fix,
        hires_scale,
        hires_upscaler: upscaler.into(),
        hires_steps,
        denoising_strength,
        face_detailer: truthy(&body["faceDetailer"]),
        auto_hires,
        super_res_wanted,
        comfy_hires,
        super_res_model: None,
    })
}
