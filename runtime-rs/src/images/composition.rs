//! Bounded native Anima composition inputs; paths are resolved only after admission.
use super::*;
use generation::native::{Settings, resources};
use std::path::Path;

pub(super) const SKETCH_FILE: &str = "anima-lllite-any-test-like-v2.safetensors";
pub(super) const SKETCH_SHA256: &str =
    "8863424f04a2445815a827b22cbda557a085d2752e05fab54a2b303821a9e3b2";
const SKETCH_BYTES: u64 = 16_403_008;
const SKETCH_SOURCE: &str =
    "https://huggingface.co/kohya-ss/Anima-LLLite/tree/36ba7f2f498a1ca63cc77fc7a1298652f72d4524";

pub(super) fn requested(input: &Value) -> bool {
    input.get("sketchControl").is_some_and(|v| !v.is_null())
        || input
            .get("regions")
            .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty()))
}

fn fields(value: &Value, allowed: &[&str]) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| error("INVALID_PARAMETER", "构图参数必须为对象"))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(error("UNKNOWN_PARAMETER", "构图参数包含不支持的字段"));
    }
    Ok(())
}

pub(super) fn copy_input(raw: &Value, input: &mut Value) -> Result<()> {
    if !requested(raw) {
        return Ok(());
    }
    if input["family"] != "anima" {
        return Err(error(
            "WRONG_ROUTE_FAMILY",
            "草图控制和区域提示词仅支持原生 Anima",
        ));
    }
    if let Some(sketch) = raw.get("sketchControl").filter(|v| !v.is_null()) {
        fields(sketch, &["image", "strength", "start", "end"])?;
        let image = sketch["image"]
            .as_str()
            .filter(|name| !name.is_empty() && name.len() <= 96)
            .ok_or_else(|| error("INVALID_PARAMETER", "草图必须是已上传的图像名称"))?;
        let strength = validation::number(&sketch["strength"], "草图强度", 0., 2., false)?;
        let start = validation::number(&sketch["start"], "草图开始比例", 0., 1., false)?;
        let end = validation::number(&sketch["end"], "草图结束比例", 0., 1., false)?;
        if start.as_f64() >= end.as_f64() {
            return Err(error("INVALID_PARAMETER", "草图开始比例必须小于结束比例"));
        }
        input["sketchControl"] = json!({"image":image,"strength":strength,"start":start,"end":end});
    }
    if let Some(regions) = raw.get("regions").filter(|v| !v.is_null()) {
        let regions = regions
            .as_array()
            .filter(|a| a.len() <= 4)
            .ok_or_else(|| error("INVALID_PARAMETER", "区域提示词必须为最多四个区域的数组"))?;
        let mut normalized = Vec::new();
        let mut ids = std::collections::HashSet::new();
        for region in regions {
            fields(region, &["id", "prompt", "x", "y", "width", "height"])?;
            let id = region["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 96)
                .ok_or_else(|| error("INVALID_PARAMETER", "区域编号无效"))?;
            if !ids.insert(id) {
                return Err(error("INVALID_PARAMETER", "区域编号不能重复"));
            }
            let prompt = region["prompt"]
                .as_str()
                .map(str::trim)
                .filter(|p| !p.is_empty() && p.encode_utf16().count() <= 1200)
                .ok_or_else(|| {
                    error(
                        "INVALID_PARAMETER",
                        "每个区域需填写不超过 1200 字符的正向提示词",
                    )
                })?;
            let mut value = json!({"id":id,"prompt":prompt});
            for key in ["x", "y", "width", "height"] {
                value[key] = validation::number(&region[key], key, 0., 1., false)?;
            }
            let (x, y, w, h) = (
                value["x"].as_f64().unwrap(),
                value["y"].as_f64().unwrap(),
                value["width"].as_f64().unwrap(),
                value["height"].as_f64().unwrap(),
            );
            if w <= 0. || h <= 0. || x + w > 1. + 1e-6 || y + h > 1. + 1e-6 {
                return Err(error(
                    "INVALID_PARAMETER",
                    "区域必须位于输出画幅内，宽高必须大于零",
                ));
            }
            normalized.push(value);
        }
        if !normalized.is_empty() {
            input["regions"] = json!(normalized);
        }
    }
    Ok(())
}

pub(super) fn normalize_native(raw: &Value, input: &mut Value) -> Result<()> {
    copy_input(raw, input)?;
    if !requested(input) {
        return Ok(());
    }
    if input["hiresFix"] == true {
        return Err(ApiError::new(
            501,
            "NATIVE_COMPOSITION_UNSUPPORTED",
            "构图控制暂不支持高清修复，请先关闭高清",
        ));
    }
    if raw["teaCache"] == true {
        return Err(ApiError::new(
            501,
            "NATIVE_COMPOSITION_UNSUPPORTED",
            "构图控制使用完整采样，请关闭特征缓存加速",
        ));
    }
    input["teaCache"] = json!(false);
    input["teaCacheAuto"] = json!(false);
    input.as_object_mut().unwrap().remove("teaCacheThresh");
    Ok(())
}

fn layers(model_dir: &Path) -> Option<u64> {
    let data = std::fs::read(model_dir.join("transformer/config.json")).ok()?;
    serde_json::from_slice::<Value>(&data).ok()?["num_layers"].as_u64()
}

pub(super) fn sketch_path(settings: &Settings) -> Option<PathBuf> {
    let path = resources::file(
        &settings.models_root,
        &format!("controlnet/{SKETCH_FILE}"),
        true,
    )?;
    std::fs::metadata(&path)
        .ok()
        .filter(|meta| meta.len() == SKETCH_BYTES)
        .map(|_| path)
}

pub(super) fn status(settings: &Settings, model_dir: Option<&Path>, available: bool) -> Value {
    let reason = if !available {
        Some("当前 Anima 模型或运行库尚未就绪")
    } else if settings.acceleration != "native" {
        Some("构图控制需在控制室选择 native 加速模式并重启")
    } else if model_dir.and_then(layers) != Some(28) {
        Some("草图控制当前仅支持 28 层 Anima 模型")
    } else if sketch_path(settings).is_none() {
        Some("请在模型根目录 controlnet 中准备指定 Sketch 权重")
    } else {
        None
    };
    json!({"available":reason.is_none(),"reason":reason,"file":format!("controlnet/{SKETCH_FILE}"),"source":SKETCH_SOURCE,
        "sha256":SKETCH_SHA256,"bytes":SKETCH_BYTES,"validation":"on-load","generationVerified":false})
}

pub(super) fn prepare(
    settings: &Settings,
    input: &mut Value,
    model_dir: &Path,
) -> Result<Option<PathBuf>> {
    if !requested(input) {
        return Ok(None);
    }
    if settings.acceleration != "native" {
        return Err(ApiError::new(
            501,
            "NATIVE_COMPOSITION_UNSUPPORTED",
            "构图控制需选择 native 加速模式并重启，暂不支持 Sage 或编译加速",
        ));
    }
    if input["sketchControl"].is_null() {
        return Ok(None);
    }
    let state = status(settings, Some(model_dir), true);
    if state["available"] != true {
        return Err(ApiError::new(
            503,
            "NATIVE_SKETCH_UNAVAILABLE",
            state["reason"].as_str().unwrap_or("草图控制模型尚未就绪"),
        ));
    }
    input["sketchControlModel"] =
        json!({"file":SKETCH_FILE,"sha256":SKETCH_SHA256,"source":SKETCH_SOURCE});
    Ok(sketch_path(settings))
}
