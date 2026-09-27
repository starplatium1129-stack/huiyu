use super::*;
const KEYS: &[&str] = &[
    "prompt",
    "negative",
    "modelId",
    "aspectRatio",
    "duration",
    "camera",
    "motion",
    "seed",
    "image",
    "quality",
    "dialogue",
    "dialogueLang",
    "lastFrame",
    "shotSize",
    "steps",
    "references",
    "adultEnabled",
];
pub(super) fn present(value: &Value) -> bool {
    !value.is_null() && value != ""
}
fn invalid(message: &str) -> ApiError {
    error(400, "INVALID_PARAMETER", message)
}
pub(super) fn integer(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0. && *n <= 9_007_199_254_740_991. && n.fract() == 0.)
        .map(|n| n as u64)
}
pub fn validate(body: &Value, local: bool, original_size: Option<(u32, u32)>) -> Result<Value> {
    let object = body
        .as_object()
        .ok_or_else(|| error(400, "INVALID_BODY", "请求体必须是 JSON 对象"))?;
    for key in object.keys() {
        if !KEYS.contains(&key.as_str()) {
            return Err(error(
                400,
                "UNKNOWN_PARAMETER",
                format!("不支持的参数：{key}"),
            ));
        }
    }
    if body["prompt"]
        .as_str()
        .is_some_and(generation::adult_intent)
    {
        if !local {
            return Err(error(
                403,
                "ADULT_REMOTE_NOT_ALLOWED",
                "成人内容仅限本机直连使用",
            ));
        }
        if body["adultEnabled"] != true {
            return Err(error(
                403,
                "ADULT_NOT_ENABLED",
                "成人内容未获本机授权（adultEnabled !== true），已拒绝 R18 参数；请用普通服装重试。",
            ));
        }
    }
    for key in [
        "prompt",
        "modelId",
        "aspectRatio",
        "duration",
        "camera",
        "motion",
    ] {
        if !object.contains_key(key) {
            return Err(error(400, "MISSING_PARAMETER", format!("缺少参数：{key}")));
        }
    }
    let user = body["prompt"]
        .as_str()
        .filter(|p| !p.trim().is_empty() && p.encode_utf16().count() <= 4000)
        .ok_or_else(|| invalid("画面描述需为 1—4000 字符"))?;
    if object
        .get("negative")
        .is_some_and(|v| v.as_str().is_none_or(|s| s.encode_utf16().count() > 2000))
    {
        return Err(invalid("负向描述需为不超过 2000 字符的文本"));
    }
    let id = body["modelId"]
        .as_str()
        .ok_or_else(|| error(400, "UNKNOWN_MODEL", "未知视频模型"))?;
    let model = catalog::model(id).ok_or_else(|| error(400, "UNKNOWN_MODEL", "未知视频模型"))?;
    if model["executable"] != true {
        return Err(error(
            409,
            "MODEL_ADAPTER_UNAVAILABLE",
            "该模型仍在适配与实测阶段",
        ));
    }
    let h3 = model["family"] == "minimax-h3";
    let quality = if present(&body["quality"]) {
        body["quality"].as_str().unwrap_or("")
    } else {
        "standard"
    };
    let quality_spec = &catalog::constants()["QUALITIES"][quality];
    if quality_spec.is_null() {
        return Err(invalid("不支持的画质档位"));
    }
    for (key, mode, message) in [
        ("image", "image", "该模型不支持首帧图输入"),
        ("lastFrame", "first-last-frame", "该模型不支持尾帧图输入"),
    ] {
        if present(&body[key]) {
            if !body[key]
                .as_str()
                .is_some_and(|s| inputs::valid_name(s, false))
            {
                return Err(invalid(if key == "image" {
                    "图片引用格式不受支持"
                } else {
                    "尾帧图片引用格式不受支持"
                }));
            }
            if !model["modes"].as_array().unwrap().iter().any(|m| m == mode) {
                return Err(error(400, "MODEL_INPUT_MODE", message));
            }
        }
    }
    let references = if let Some(value) = object.get("references").filter(|v| !v.is_null()) {
        if !h3 {
            return Err(error(400, "MODEL_INPUT_MODE", "参考图仅支持 MiniMax H3"));
        }
        let array = value
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 9)
            .ok_or_else(|| invalid("参考图需为 1—9 张"))?;
        for item in array {
            if !item.as_str().is_some_and(|s| inputs::valid_name(s, true)) {
                return Err(invalid("参考图引用格式不受支持"));
            }
        }
        array.clone()
    } else {
        Vec::new()
    };
    if present(&body["dialogue"]) {
        if !h3 {
            return Err(error(400, "MODEL_INPUT_MODE", "对白仅支持 MiniMax H3"));
        }
        if body["dialogue"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty() || s.encode_utf16().count() > 300)
        {
            return Err(invalid("对白需为 1—300 字符"));
        }
    }
    let language = if present(&body["dialogueLang"]) {
        body["dialogueLang"].as_str().unwrap_or("")
    } else {
        "auto"
    };
    if !["auto", "zh", "ja", "en"].contains(&language) {
        return Err(invalid("对白语言仅支持 auto/zh/ja/en"));
    }
    let shot = if present(&body["shotSize"]) {
        if !h3 {
            return Err(error(400, "MODEL_INPUT_MODE", "景别仅支持 MiniMax H3"));
        }
        let shot = body["shotSize"]
            .as_str()
            .filter(|s| prose::table()["H3_SHOT_SIZE"].get(*s).is_some())
            .ok_or_else(|| invalid("不支持的景别"))?;
        Some(shot)
    } else {
        None
    };
    let steps = if present(&body["steps"]) {
        integer(&body["steps"]).unwrap_or(0)
    } else {
        8
    };
    if ![4, 8].contains(&steps) {
        return Err(invalid("步数只支持 4（极速）或 8（标准）"));
    }
    if !h3 && present(&body["steps"]) {
        return Err(error(400, "MODEL_INPUT_MODE", "极速步数仅支持 MiniMax H3"));
    }
    let aspect = body["aspectRatio"].as_str().unwrap_or("");
    let (width, height) = if aspect == "original" {
        if !generation::truthy(&body["image"]) {
            return Err(invalid("跟随原图比例需要先上传首帧图"));
        }
        let (w, h) = original_size.ok_or_else(|| invalid("缺少图片文件上下文"))?;
        if w == 0 || h == 0 {
            return Err(invalid("无法解析首帧图尺寸"));
        }
        fit_canvas(w, h, quality_spec)
    } else {
        let selected = &quality_spec["sizes"][aspect];
        (
            selected["width"]
                .as_u64()
                .ok_or_else(|| invalid("不支持的画面比例"))? as u32,
            selected["height"].as_u64().unwrap() as u32,
        )
    };
    let duration = integer(&body["duration"])
        .or_else(|| body["duration"].as_str().and_then(|v| v.parse().ok()))
        .filter(|n| {
            [3, 5].contains(n) || (h3 && body["duration"].is_number() && [10, 15].contains(n))
        })
        .ok_or_else(|| {
            invalid(if h3 {
                "时长支持 3/5/10/15 秒"
            } else {
                "时长只支持 3 秒或 5 秒"
            })
        })?;
    for (key, table, message) in [
        ("camera", "CAMERA", "不支持的镜头运动"),
        ("motion", "MOTION", "不支持的主体运动"),
    ] {
        if body[key]
            .as_str()
            .is_none_or(|s| prose::table()[table].get(s).is_none())
        {
            return Err(invalid(message));
        }
    }
    let seed = if present(&body["seed"]) {
        integer(&body["seed"])
            .filter(|n| *n <= 0x7fffffff)
            .ok_or_else(|| invalid("seed 需为 0—2147483647 的整数"))?
    } else {
        (uuid::Uuid::new_v4().as_u128() % 0x7fffffff) as u64
    };
    let negative = if h3 {
        String::new()
    } else {
        let base = catalog::constants()["WAN_NEGATIVE"].as_str().unwrap();
        let extra = body["negative"].as_str().unwrap_or("").trim();
        if extra.is_empty() {
            base.into()
        } else {
            format!("{base}，{extra}")
        }
    };
    Ok(
        json!({"prompt":prose::prompt(body,h3,duration,&references),"originalPrompt":user.trim(),"negative":negative,"modelId":id,"aspectRatio":aspect,"quality":quality,"width":width,"height":height,"duration":duration,"frames":if h3{prose::frame_count(duration)}else{if duration==3{73}else{121}},"fps":24,"camera":body["camera"],"motion":body["motion"],"seed":seed,"image":if generation::truthy(&body["image"]){body["image"].clone()}else{Value::Null},"lastFrame":if generation::truthy(&body["lastFrame"]){body["lastFrame"].clone()}else{Value::Null},"references":if references.is_empty(){Value::Null}else{json!(references)},"dialogue":if generation::truthy(&body["dialogue"]){body["dialogue"].clone()}else{Value::Null},"dialogueLang":if language=="auto"{None}else{Some(language)},"shotSize":shot,"steps":if h3{steps}else{20},"cfg":5}),
    )
}
pub fn fit_canvas(width: u32, height: u32, quality: &Value) -> (u32, u32) {
    let ratio = (f64::from(width) / f64::from(height)).clamp(0.5, 2.);
    let target = quality["sizes"]["landscape"]["width"].as_f64().unwrap()
        * quality["sizes"]["landscape"]["height"].as_f64().unwrap();
    let align = |n: f64| (n / 32.).round().max(1.) * 32.;
    let (mut w, mut h) = (
        align((target * ratio).sqrt()),
        align((target / ratio).sqrt()),
    );
    if w.min(h) > 768. {
        let scale = 768. / w.min(h);
        w = align(w * scale);
        h = align(h * scale);
    }
    if w * h > 768. * 1344. {
        let scale = ((768. * 1344.) / (w * h)).sqrt();
        w = align(w * scale);
        h = align(h * scale);
    }
    (w as u32, h as u32)
}
