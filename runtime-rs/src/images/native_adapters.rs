//! Native image parameters are distinct from Anima and Comfy sampling recipes.
use super::*;
use generation::native::adapters;
const KEYS: &[&str] = &[
    "modelId",
    "prompt",
    "negative",
    "width",
    "height",
    "steps",
    "cfg",
    "seed",
    "initImage",
];
const UNSUPPORTED: &[&str] = &[
    "loraId",
    "loraStrength",
    "character",
    "styleLoraId",
    "maskImage",
    "maskPrompt",
    "maskThreshold",
    "growMaskBy",
    "denoisingStrength",
    "hiresFix",
    "hiresScale",
    "hiresDenoise",
    "hiresUpscaler",
    "teaCache",
    "teaCacheThresh",
    "rcas",
    "rcasStrength",
    "faceDetailer",
];

fn supported_options(raw: &Value) -> Result<()> {
    for key in UNSUPPORTED {
        if generation::truthy(&raw[*key]) {
            return Err(ApiError::new(
                501,
                "NATIVE_FEATURE_UNSUPPORTED",
                format!("该原生适配尚未接入 {key}；请移除此参数。Qwen 编辑使用原图和文字指令"),
            ));
        }
    }
    Ok(())
}
pub(super) fn validate(raw: &Value, family: &str) -> Result<Value> {
    let object = raw
        .as_object()
        .ok_or_else(|| error("INVALID_BODY", "请求体必须为对象"))?;
    for key in object.keys() {
        if !KEYS.contains(&key.as_str()) && !UNSUPPORTED.contains(&key.as_str()) {
            return Err(error("UNKNOWN_PARAMETER", format!("不支持的参数：{key}")));
        }
    }
    supported_options(raw)?;
    let id = raw["modelId"]
        .as_str()
        .ok_or_else(|| error("UNKNOWN_MODEL", "缺少模型 ID"))?;
    let spec = adapters::model(id)
        .filter(|m| m["media"] == "image")
        .ok_or_else(|| error("UNKNOWN_MODEL", "未知原生图像模型"))?;
    if !family.is_empty() && spec["family"] != family {
        return Err(error("WRONG_ROUTE_FAMILY", "请求路径与模型 family 不匹配"));
    }
    let prompt = raw["prompt"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 12000)
        .ok_or_else(|| error("INVALID_PARAMETER", "prompt 需为 1—12000 字符"))?;
    let negative = match raw.get("negative") {
        None => "",
        Some(Value::String(s)) if s.encode_utf16().count() <= 8000 => s.trim(),
        _ => {
            return Err(error(
                "INVALID_PARAMETER",
                "负向描述需为不超过 8000 字符的文本",
            ));
        }
    };
    if !negative.is_empty() && spec["negative"] != true {
        return Err(error(
            "NATIVE_FEATURE_UNSUPPORTED",
            "该模型未接入负向提示词",
        ));
    }
    let width = validation::number(
        &raw["width"],
        "width",
        512.,
        spec["maxSize"].as_f64().unwrap(),
        true,
    )?;
    let height = validation::number(
        &raw["height"],
        "height",
        512.,
        spec["maxSize"].as_f64().unwrap(),
        true,
    )?;
    let alignment = spec["alignment"].as_u64().unwrap();
    if width.as_u64().unwrap() % alignment != 0 || height.as_u64().unwrap() % alignment != 0 {
        return Err(error(
            "INVALID_PARAMETER",
            format!("宽高必须是 {alignment} 的倍数"),
        ));
    }
    let steps = validation::number(
        raw.get("steps").unwrap_or(&spec["steps"]),
        "steps",
        1.,
        100.,
        true,
    )?;
    let cfg = validation::number(
        raw.get("cfg").unwrap_or(&spec["cfg"]),
        "cfg",
        0.,
        20.,
        false,
    )?;
    if spec["distilled"] == true && (steps != spec["steps"] || cfg.as_f64() != spec["cfg"].as_f64())
    {
        return Err(error(
            "INVALID_PARAMETER",
            "Turbo 必须使用该版本声明的步数和 CFG",
        ));
    }
    if spec["family"] == "qwen-image" && (!negative.is_empty() != (cfg.as_f64().unwrap() > 1.)) {
        return Err(error(
            "INVALID_PARAMETER",
            "Qwen 负向提示词须与 CFG > 1 同时使用；无负向时 CFG 不超过 1",
        ));
    }
    let image = match raw.get("initImage") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) if spec["edit"] == true => Some(s.clone()),
        _ => {
            return Err(error(
                "NATIVE_FEATURE_UNSUPPORTED",
                "该适配仅 Qwen 支持单张已上传原图的指令编辑",
            ));
        }
    };
    let seed = raw
        .get("seed")
        .map(|v| validation::number(v, "seed", 0., 2147483647., true))
        .transpose()?
        .unwrap_or_else(|| json!((uuid::Uuid::new_v4().as_u128() % 2147483647) as u64));
    Ok(
        json!({"modelId":id,"family":spec["family"],"prompt":prompt.trim(),"negative":negative,
        "width":width,"height":height,"steps":steps,"cfg":cfg,"seed":seed,"initImage":image,
        "inferenceEngine":"native","nativeAdapterVersion":1,"validation":"待主力机验证",
        "sampler":"euler","scheduler":"model-config","teaCache":false,"hiresFix":false,"rcasStrength":0}),
    )
}
pub(super) fn normalize(raw: &Value, mut input: Value) -> Result<Value> {
    supported_options(raw)?;
    let mut request = serde_json::Map::new();
    for key in KEYS {
        if let Some(value) = input.get_mut(*key) {
            request.insert((*key).into(), value.take());
        }
    }
    validate(
        &Value::Object(request),
        input["family"].as_str().unwrap_or(""),
    )
}
