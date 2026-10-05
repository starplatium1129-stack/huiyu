use super::*;
use crate::generation::{adult_intent, truthy};
pub(super) fn number(
    value: &Value,
    name: &str,
    min: f64,
    max: f64,
    integer: bool,
) -> Result<Value> {
    let value = value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= min && *n <= max && (!integer || n.fract() == 0.))
        .ok_or_else(|| error("INVALID_PARAMETER", format!("{name} 超出允许范围")))?;
    Ok(num(value))
}
pub(super) fn num(value: f64) -> Value {
    if value.fract() == 0. && value.abs() < 9_223_372_036_854_775_000. {
        json!(value as i64)
    } else {
        json!(value)
    }
}
pub fn validate(body: &Value, family: &str, direct_local: bool) -> Result<Value> {
    let object = body
        .as_object()
        .ok_or_else(|| error("INVALID_BODY", "请求体必须是 JSON 对象"))?;
    let contract = catalog::contract();
    let allowed = contract["ALLOWED_INPUT_KEYS"].as_array().unwrap();
    for key in object.keys() {
        if !allowed.iter().any(|v| v == key) {
            return Err(error("UNKNOWN_PARAMETER", format!("不支持的参数：{key}")));
        }
    }
    for key in ["prompt", "modelId", "width", "height"] {
        if !object.contains_key(key) {
            return Err(error("MISSING_PARAMETER", format!("缺少参数：{key}")));
        }
    }
    let prompt = body["prompt"]
        .as_str()
        .filter(|p| !p.trim().is_empty() && p.encode_utf16().count() <= 12000)
        .ok_or_else(|| error("INVALID_PARAMETER", "prompt 需为 1—12000 字符"))?;
    let negative = match object.get("negative") {
        None => "",
        Some(Value::String(v)) if v.encode_utf16().count() <= 8000 => v,
        _ => {
            return Err(error(
                "INVALID_PARAMETER",
                "negative 需为不超过 8000 字符的文本",
            ));
        }
    };
    if !direct_local && adult_intent(prompt) {
        return Err(ApiError::new(
            403,
            "ADULT_REMOTE_NOT_ALLOWED",
            "成人内容仅限本机直连使用",
        ));
    }
    let model_id = body["modelId"]
        .as_str()
        .ok_or_else(|| error("UNKNOWN_MODEL", "未知生成模型"))?;
    let model = catalog::model(model_id)?;
    if !family.is_empty() && model["family"] != family {
        return Err(error("WRONG_ROUTE_FAMILY", "请求路径与模型 family 不匹配"));
    }
    let krea = model["family"] == "krea2";
    let lora = body["loraId"].as_str().and_then(catalog::lora);
    if !krea && object.contains_key("styleLoraId") {
        return Err(error("WRONG_ROUTE_FAMILY", "Style LoRA 仅适用于 Krea 2"));
    }
    if krea {
        if truthy(&body["loraId"])
            || object.contains_key("loraStrength")
            || !negative.trim().is_empty()
        {
            return Err(error(
                "KREA_UNSUPPORTED_PARAMETER",
                "Krea 2 不接受角色 LoRA 或负向 Prompt",
            ));
        }
        if object.get("styleLoraId").is_some_and(|v| {
            v.as_str()
                .is_none_or(|id| catalog::styles().get(id).is_none())
        }) {
            return Err(error("UNKNOWN_STYLE_LORA", "未知 Krea 2 官方 Style LoRA"));
        }
    } else if model["noLora"] == true && !truthy(&body["loraId"]) {
        if object.contains_key("loraStrength") {
            return Err(error(
                "INVALID_PARAMETER",
                "no-LoRA 模式不接受 loraStrength",
            ));
        }
        if object.get("character").is_some_and(|c| !c.is_null()) {
            return Err(error("INVALID_PARAMETER", "no-LoRA 模式不接受角色身份字段"));
        }
    } else {
        let lora = lora.ok_or_else(|| error("UNKNOWN_LORA", "未知 Anima LoRA"))?;
        if !lora["compatibleModels"]
            .as_array()
            .unwrap()
            .contains(&body["modelId"])
        {
            return Err(error("INCOMPATIBLE_MODEL_LORA", "底模与 LoRA 组合不受支持"));
        }
        if body["character"]
            .as_str()
            .and_then(|id| catalog::CATALOG["CHARACTERS"].get(id))
            .is_none_or(|c| c["loraId"] != body["loraId"])
        {
            return Err(error("INCOMPATIBLE_CHARACTER", "角色与 LoRA 组合不受支持"));
        }
    }
    let strength = if let Some(lora) = lora {
        number(
            &body["loraStrength"],
            "loraStrength",
            lora["minStrength"].as_f64().unwrap(),
            lora["maxStrength"].as_f64().unwrap(),
            false,
        )?
    } else {
        Value::Null
    };
    let width = number(&body["width"], "width", 512., 1536., true)?;
    let height = number(&body["height"], "height", 512., 1536., true)?;
    let w = width.as_u64().unwrap();
    let h = height.as_u64().unwrap();
    let inpaint = !krea
        && body["initImage"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty());
    if !inpaint
        && !model["sizes"]
            .as_array()
            .unwrap()
            .contains(&json!(format!("{w}x{h}")))
    {
        return Err(error("INVALID_PARAMETER", "不支持的输出尺寸"));
    }
    if inpaint && (w % 16 != 0 || h % 16 != 0) {
        return Err(error("INVALID_PARAMETER", "局部重绘尺寸必须是 16 的倍数"));
    }
    if !krea && w * h > 1_850_000 {
        return Err(error("INVALID_PARAMETER", "输出尺寸超过允许面积"));
    }
    let validate_limit = |key: &str, value: &Value| {
        let limit = &contract["PARAMETER_LIMITS"][key];
        number(
            value,
            key,
            limit["min"].as_f64().unwrap(),
            limit["max"].as_f64().unwrap(),
            limit["integer"] == true,
        )
    };
    let (steps, cfg) = if krea {
        if object.get("steps").is_some_and(|v| v.as_f64() != Some(12.)) {
            return Err(error("INVALID_PARAMETER", "Krea 2 steps 固定为 12"));
        }
        if object.get("cfg").is_some_and(|v| v.as_f64() != Some(1.)) {
            return Err(error("INVALID_PARAMETER", "Krea 2 CFG 固定为 1"));
        }
        (json!(12), json!(1))
    } else {
        (
            object
                .get("steps")
                .map(|v| validate_limit("steps", v))
                .transpose()?
                .unwrap_or_else(|| model["steps"].clone()),
            object
                .get("cfg")
                .map(|v| validate_limit("cfg", v))
                .transpose()?
                .unwrap_or_else(|| model["cfg"].clone()),
        )
    };
    let seed = if let Some(seed) = object.get("seed") {
        validate_limit("seed", seed)?
    } else {
        json!((uuid::Uuid::new_v4().as_u128() % 2_147_483_647) as u64)
    };
    let style = if krea {
        body["styleLoraId"].as_str()
    } else {
        None
    };
    let prompt = if let Some(style) = style {
        format!(
            "{}, {}",
            prompt.trim(),
            catalog::styles()[style]["trigger"].as_str().unwrap()
        )
    } else {
        prompt.trim().into()
    };
    let hires = truthy(&body["hiresFix"]);
    let or_default = |key: &str, default: f64| {
        if truthy(&body[key]) {
            body[key].clone()
        } else {
            num(default)
        }
    };
    let trimmed = |key: &str| {
        body[key]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let mut normalized = json!({"prompt":prompt,"negative":if krea{""}else{negative.trim()},"family":model["family"],"profileId":catalog::CATALOG["PROFILE_BY_MODEL"][model_id],"modelId":model_id,"loraStrength":strength,"width":width,"height":height,"steps":steps,"cfg":cfg,"sampler":model["sampler"],"scheduler":model["scheduler"],"seed":seed,"styleLoraId":style,"hiresFix":hires,"hiresScale":if hires{number(&or_default("hiresScale",2.),"hiresScale",1.1,3.,false)?}else{json!(1)},"hiresDenoise":if hires{number(&or_default("hiresDenoise",0.35),"hiresDenoise",0.1,0.7,false)?}else{json!(0.35)},"hiresUpscaler":match body["hiresUpscaler"].as_str(){Some(name @ ("Remacri" | "Latent" | "R-ESRGAN 4x+ Anime6B" | "R-ESRGAN 4x+"))=>Some(name),_=>hires.then_some("Auto")},"teaCache":object.get("teaCache").map(truthy).unwrap_or(true),"teaCacheThresh":object.get("teaCacheThresh").map(|v|validate_limit("teaCacheThresh",v)).transpose()?.unwrap_or_else(||model.get("teaCacheThresh").cloned().unwrap_or(json!(0.08))),"initImage":trimmed("initImage"),"maskImage":trimmed("maskImage"),"maskPrompt":trimmed("maskPrompt"),"denoisingStrength":object.get("denoisingStrength").map(|v|validate_limit("denoisingStrength",v)).transpose()?.unwrap_or(json!(0.8)),"growMaskBy":object.get("growMaskBy").map(|v|validate_limit("growMaskBy",v)).transpose()?.unwrap_or(json!(6)),"maskThreshold":object.get("maskThreshold").map(|v|validate_limit("maskThreshold",v)).transpose()?.unwrap_or(json!(0.45))});
    for key in ["loraId", "character"] {
        if let Some(value) = object.get(key) {
            normalized[key] = value.clone();
        }
    }
    Ok(normalized)
}
