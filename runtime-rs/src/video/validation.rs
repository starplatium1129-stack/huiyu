use super::*;
const KEYS: &[&str] = &[
    "prompt",
    "promptRecipe",
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
    "videoAttention",
    "wanResolution",
    "audioFrames",
    "h3Decoder",
    "drivingAudio",
    "drivingVideo",
    "references",
    "adultEnabled", // Accepted only for old saved requests; no longer controls access.
];
pub(super) fn present(value: &Value) -> bool {
    !value.is_null() && value != ""
}
fn invalid(message: &str) -> ApiError {
    error(400, "INVALID_PARAMETER", message)
}
pub(super) fn validate_frames(body: &Value, model: &Value) -> Result<()> {
    for (key, mode, message) in [
        ("image", "image", "该模型不支持首帧图输入"),
        ("lastFrame", "first-last-frame", "该模型不支持尾帧图输入"),
    ] {
        if !present(&body[key]) {
            continue;
        }
        if !body[key]
            .as_str()
            .is_some_and(|s| inputs::valid_name(s, false))
        {
            return Err(invalid("帧图引用格式不受支持"));
        }
        if !model["modes"]
            .as_array()
            .is_some_and(|modes| modes.iter().any(|m| m == mode))
        {
            return Err(error(400, "MODEL_INPUT_MODE", message));
        }
    }
    Ok(())
}
pub(super) fn integer(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0. && *n <= 9_007_199_254_740_991. && n.fract() == 0.)
        .map(|n| n as u64)
}
pub(super) fn prompt_text(body: &Value, optional: bool) -> Result<&str> {
    let message = if optional { "画面描述需为不超过 4000 字符的文本" } else { "画面描述需为 1—4000 字符" };
    match body.get("prompt") {
        None if optional => Ok(""),
        Some(value) => value.as_str()
            .filter(|text| (optional || !text.trim().is_empty()) && text.encode_utf16().count() <= 4000)
            .map(str::trim)
            .ok_or_else(|| invalid(message)),
        None => Err(invalid(message)),
    }
}
pub(super) fn negative_text(body: &Value) -> Result<&str> {
    body.get("negative").map_or(Ok(""), |value| {
        value.as_str()
            .filter(|text| text.encode_utf16().count() <= 2000)
            .map(str::trim)
            .ok_or_else(|| invalid("负向描述需为不超过 2000 字符的文本"))
    })
}
pub(super) fn duration_for(body: &Value, native: Option<&Value>, h3: bool) -> Result<u64> {
    integer(&body["duration"])
        .or_else(|| body["duration"].as_str().and_then(|value| value.parse().ok()))
        .filter(|n| {
            if let Some(spec) = native {
                spec["durationFrames"].get(n.to_string()).is_some()
            } else {
                [3, 5].contains(n) || (h3 && body["duration"].is_number() && [10, 15].contains(n))
            }
        })
        .ok_or_else(|| {
            invalid(if native.is_some() {
                "所选原生模型不支持此时长"
            } else if h3 {
                "时长支持 3/5/10/15 秒"
            } else {
                "时长只支持 3 秒或 5 秒"
            })
        })
}
pub(super) fn validate_motion(body: &Value) -> Result<()> {
    for (key, table, message) in [
        ("camera", "CAMERA", "不支持的镜头运动"),
        ("motion", "MOTION", "不支持的主体运动"),
    ] {
        if body[key].as_str().is_none_or(|value| prose::table()[table].get(value).is_none()) {
            return Err(invalid(message));
        }
    }
    Ok(())
}
pub fn validate(body: &Value, original_size: Option<(u32, u32)>) -> Result<Value> {
    validate_for(body, original_size, None)
}
pub(super) fn validate_for(
    body: &Value,
    original_size: Option<(u32, u32)>,
    native: Option<&Value>,
) -> Result<Value> {
    let object = body
        .as_object()
        .ok_or_else(|| error(400, "INVALID_BODY", "请求体必须是 JSON 对象"))?;
    for key in object.keys() {
        if !KEYS.contains(&key.as_str()) || (native.is_none() && matches!(key.as_str(), "videoAttention" | "h3Decoder" | "drivingVideo" | "drivingAudio"))
            || (key == "wanResolution" && !native.is_some_and(|spec| spec["runner"] == "wan-a14b-sd"))
            || (key == "audioFrames" && !native.is_some_and(|spec| spec["runner"] == "musetalk-native")) {
            return Err(error(
                400,
                "UNKNOWN_PARAMETER",
                format!("不支持的参数：{key}"),
            ));
        }
    }
    let structured = object.contains_key("promptRecipe");
    if !structured && !object.contains_key("prompt") {
        return Err(error(400, "MISSING_PARAMETER", "缺少参数：prompt"));
    }
    for key in ["modelId", "aspectRatio", "duration", "camera", "motion"] {
        if !object.contains_key(key) {
            return Err(error(400, "MISSING_PARAMETER", format!("缺少参数：{key}")));
        }
    }
    let id = body["modelId"]
        .as_str()
        .ok_or_else(|| error(400, "UNKNOWN_MODEL", "未知视频模型"))?;
    let model = native.or_else(|| catalog::model(id)).ok_or_else(|| error(400, "UNKNOWN_MODEL", "未知视频模型"))?;
    if native.is_none() && model["executable"] != true {
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
    if native.is_none() {
        validate_frames(body, model)?;
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
    let steps = if let Some(spec) = native {
        let default_steps = if spec["runner"] == "wan-a14b-sd" && quality == "fine" { json!(8) } else { spec["steps"].clone() };
        integer(body.get("steps").unwrap_or(&default_steps))
            .filter(|n| (spec["minSteps"].as_u64().unwrap_or(1)..=100).contains(n))
            .ok_or_else(|| invalid("原生模型步数超出支持范围"))?
    } else if present(&body["steps"]) {
        integer(&body["steps"]).unwrap_or(0)
    } else {
        8
    };
    if native.is_none() && ![4, 8].contains(&steps) {
        return Err(invalid("步数只支持 4（极速）或 8（标准）"));
    }
    if native.is_none() && !h3 && present(&body["steps"]) {
        return Err(error(400, "MODEL_INPUT_MODE", "极速步数仅支持 MiniMax H3"));
    }
    let aspect = body["aspectRatio"].as_str().unwrap_or("");
    let wan_resolution = if native.is_some_and(|spec| spec["runner"] == "wan-a14b-sd") {
        if !present(&body["image"]) {
            return Err(error(400, "MODEL_INPUT_MODE", "Wan A14B 图生视频需要首帧。"));
        }
        Some(match body.get("wanResolution") {
            None => 480,
            Some(n) if n.as_u64() == Some(480) => 480,
            Some(n) if n.as_u64() == Some(720) => 720,
            _ => return Err(invalid("Wan 分辨率支持 480p 或 720p。")),
        })
    } else { None };
    let (width, height) = if let Some(resolution) = wan_resolution {
        let orientation = match aspect {
            "original" => {
                let (w, h) = original_size.filter(|(w, h)| *w > 0 && *h > 0)
                    .ok_or_else(|| invalid("无法解析 Wan 首帧尺寸。"))?;
                w.cmp(&h)
            }
            "landscape" => std::cmp::Ordering::Greater,
            "portrait" => std::cmp::Ordering::Less,
            "square" => std::cmp::Ordering::Equal,
            _ => return Err(invalid("不支持的 Wan 画面比例。")),
        };
        let long = if resolution == 720 { 1280 } else { 832 };
        let square = if resolution == 720 { 960 } else { 624 };
        match orientation {
            std::cmp::Ordering::Greater => (long, resolution),
            std::cmp::Ordering::Less => (resolution, long),
            std::cmp::Ordering::Equal => (square, square),
        }
    } else if let Some(canvases) = native.and_then(|m| m.get("canvases")) {
        if quality != "standard" {
            return Err(invalid("该原生版本仅支持 standard 画质画布"));
        }
        let canvas_name = if aspect == "original" && native.is_some_and(|m| m["runner"] == "musetalk-native") {
            let (w,h) = original_size.filter(|(w,h)| *w > 0 && *h > 0).ok_or_else(|| invalid("无法读取角色图尺寸"))?;
            match w.cmp(&h) {
                std::cmp::Ordering::Greater => "landscape",
                std::cmp::Ordering::Less => "portrait",
                std::cmp::Ordering::Equal => "square",
            }
        } else { aspect };
        let canvas = canvases[canvas_name]
            .as_array()
            .ok_or_else(|| invalid("不支持的原生画面比例"))?;
        (
            canvas[0].as_u64().unwrap() as u32,
            canvas[1].as_u64().unwrap() as u32,
        )
    } else if aspect == "original" {
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
    let duration = duration_for(body, native, h3)?;
    validate_motion(body)?;
    let seed = if present(&body["seed"]) {
        integer(&body["seed"])
            .filter(|n| *n <= 0x7fffffff)
            .ok_or_else(|| invalid("seed 需为 0—2147483647 的整数"))?
    } else {
        (uuid::Uuid::new_v4().as_u128() % 0x7fffffff) as u64
    };
    let (prompt, original, negative) = if structured {
        if ["dialogue", "dialogueLang", "shotSize", "references"].iter().any(|key| present(&body[*key])) {
            return Err(invalid("积木请求请在工作台选择景别和对白，角色参考图请使用分镜入口"));
        }
        let compiled = prompt_compiler::compile(body, model, prompt_compiler::input_mode(body)?, duration)?;
        (compiled.prompt, compiled.original, compiled.negative)
    } else {
        let user = prompt_text(body, false)?;
        let extra = negative_text(body)?;
        let negative = if native.is_some_and(|m| m["family"] != "wan2.2" || m["negative"] == false) {
            extra.to_owned()
        } else if h3 {
            String::new()
        } else {
            let base = catalog::constants()["WAN_NEGATIVE"].as_str().unwrap();
            if extra.is_empty() { base.into() } else { format!("{base}，{extra}") }
        };
        (prose::prompt(body, h3 && native.is_none(), duration, &references), user.to_owned(), Some(negative))
    };
    let mut input = json!({"prompt":prompt,"originalPrompt":original,"modelId":id,"aspectRatio":aspect,"quality":quality,"width":width,"height":height,"duration":duration,"frames":if h3{prose::frame_count(duration)}else{if duration==3{73}else{121}},"fps":24,"camera":body["camera"],"motion":body["motion"],"seed":seed,"image":if generation::truthy(&body["image"]){body["image"].clone()}else{Value::Null},"lastFrame":if generation::truthy(&body["lastFrame"]){body["lastFrame"].clone()}else{Value::Null},"references":if references.is_empty(){Value::Null}else{json!(references)},"dialogue":if generation::truthy(&body["dialogue"]){body["dialogue"].clone()}else{Value::Null},"dialogueLang":if language=="auto"{None}else{Some(language)},"shotSize":shot,"steps":if h3{steps}else{20},"cfg":5});
    if let Some(negative) = negative {
        input["negative"] = json!(negative);
    }
    if let Some(resolution) = wan_resolution {
        input["wanResolution"] = json!(resolution);
    }
    if let Some(spec) = native {
        for key in ["drivingVideo", "drivingAudio"] {
            if let Some(name) = body[key].as_str() {
                input[key] = json!(name);
            }
        }
        if let Some(attention) = body.get("videoAttention") {
            input["videoAttention"] = attention.clone();
        }
        if let Some(decoder) = body.get("h3Decoder") {
            input["h3Decoder"] = decoder.clone();
        }
        input["steps"] = json!(steps);
        input["frames"] = spec["durationFrames"][duration.to_string()].clone();
        if let Some(value) = body.get("audioFrames") {
            let frames = value.as_u64().filter(|n| (1..=input["frames"].as_u64().unwrap_or(0)).contains(n))
                .ok_or_else(|| invalid("配音实际帧数必须在所选时长内"))?;
            input["frames"] = json!(frames);
            input["audioFrames"] = json!(frames);
        }
        input["fps"] = spec["fps"].clone();
        input["cfg"] = spec["cfg"].clone();
    }
    Ok(input)
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
