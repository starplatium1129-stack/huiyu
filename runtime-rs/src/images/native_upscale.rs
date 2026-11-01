//! Pixel-only MOSS result copies; no diffusion or text-encoder parameters.
use super::*;

pub(super) fn validate(raw: &Value, spec: &Value) -> Result<Value> {
    if spec["family"] != "moss-image" {
        return Err(error("INVALID_PARAMETER", "此放大入口仅用于 MOSS 结果"));
    }
    for key in raw.as_object().unwrap().keys() {
        if ![
            "modelId",
            "prompt",
            "negative",
            "width",
            "height",
            "steps",
            "cfg",
            "seed",
            "initImage",
            "mossUpscaleScale",
            "mossUpscaleSourceTaskId",
        ]
        .contains(&key.as_str())
        {
            return Err(error(
                "INVALID_PARAMETER",
                format!("Remacri 放大不接受 {key}"),
            ));
        }
    }
    let scale = raw["mossUpscaleScale"]
        .as_f64()
        .filter(|n| *n == 1.5 || *n == 2.)
        .ok_or_else(|| error("INVALID_PARAMETER", "Remacri 放大倍率仅支持 1.5 或 2"))?;
    let image = raw["initImage"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or_else(|| error("INVALID_PARAMETER", "请先上传需要放大的结果副本"))?;
    let source = raw["mossUpscaleSourceTaskId"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or_else(|| error("INVALID_PARAMETER", "放大原任务身份无效"))?;
    let mut dimensions = Vec::new();
    for key in ["width", "height"] {
        let output = validation::number(&raw[key], key, 1., 3072., true)?;
        let original = output.as_f64().unwrap() / scale;
        if !(512.0..=1536.0).contains(&original) || original % 16.0 != 0. {
            return Err(error(
                "INVALID_PARAMETER",
                "放大原图每边需为 512–1536 像素且是 16 的倍数",
            ));
        }
        dimensions.push(output);
    }
    let prompt = raw["prompt"]
        .as_str()
        .filter(|s| s.encode_utf16().count() <= 12000)
        .ok_or_else(|| error("INVALID_PARAMETER", "原图提示词信息无效"))?;
    if raw["steps"] != 0 || raw["cfg"].as_f64() != Some(0.) || raw["negative"] != "" {
        return Err(error(
            "INVALID_PARAMETER",
            "Remacri 放大不执行采样或负向提示词",
        ));
    }
    let seed = validation::number(&raw["seed"], "seed", 0., 2147483647., true)?;
    Ok(
        json!({"modelId":raw["modelId"],"family":"moss-image","operation":"upscale",
        "mossUpscaleScale":scale,"mossUpscaleSourceTaskId":source,"initImage":image,
        "prompt":prompt,"negative":"","width":dimensions[0],"height":dimensions[1],
        "steps":0,"cfg":0,"seed":seed,"sampler":"none","scheduler":"none",
        "teaCache":false,"hiresFix":false,"rcasStrength":0,"inferenceEngine":"native",
        "nativeAdapterVersion":1,"validation":"待主力机验证"}),
    )
}
