use super::*;
pub fn validate_batch(body: &Value, local: bool) -> Result<Value> {
    let object = body
        .as_object()
        .ok_or_else(|| error(400, "INVALID_BODY", "请求体必须是 JSON 对象"))?;
    for key in object.keys() {
        if ![
            "modelId",
            "aspectRatio",
            "quality",
            "linkLastFrame",
            "steps",
            "shots",
            "adultEnabled",
        ]
        .contains(&key.as_str())
        {
            return Err(error(
                400,
                "UNKNOWN_PARAMETER",
                format!("不支持的参数：{key}"),
            ));
        }
    }
    let model = body["modelId"]
        .as_str()
        .and_then(catalog::model)
        .ok_or_else(|| error(400, "UNKNOWN_MODEL", "未知视频模型"))?;
    if model["executable"] != true {
        return Err(error(
            409,
            "MODEL_ADAPTER_UNAVAILABLE",
            "该模型仍在适配与实测阶段",
        ));
    }
    let aspect = body["aspectRatio"]
        .as_str()
        .filter(|s| ["landscape", "portrait", "square"].contains(s))
        .ok_or_else(|| {
            error(
                400,
                "INVALID_PARAMETER",
                "分镜整批需要统一的画幅（landscape/portrait/square）",
            )
        })?;
    let quality = if validation::present(&body["quality"]) {
        body["quality"].as_str().unwrap_or("")
    } else {
        "standard"
    };
    if catalog::constants()["QUALITIES"].get(quality).is_none() {
        return Err(error(400, "INVALID_PARAMETER", "不支持的画质档位"));
    }
    let linked = if body["linkLastFrame"].is_null() {
        true
    } else {
        body["linkLastFrame"]
            .as_bool()
            .ok_or_else(|| error(400, "INVALID_PARAMETER", "linkLastFrame 需为布尔值"))?
    };
    let steps = if validation::present(&body["steps"]) {
        validation::integer(&body["steps"]).unwrap_or(0)
    } else {
        8
    };
    if ![4, 8].contains(&steps) {
        return Err(error(
            400,
            "INVALID_PARAMETER",
            "步数只支持 4（极速）或 8（标准）",
        ));
    }
    if steps == 4 && model["family"] != "minimax-h3" {
        return Err(error(400, "MODEL_INPUT_MODE", "极速步数仅支持 MiniMax H3"));
    }
    let shots = body["shots"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 30)
        .ok_or_else(|| error(400, "INVALID_PARAMETER", "分镜数量需为 1—30"))?;
    let mut normalized = Vec::with_capacity(shots.len());
    for (index, shot) in shots.iter().enumerate() {
        let values = shot.as_object().ok_or_else(|| {
            error(
                400,
                "INVALID_PARAMETER",
                format!("第 {} 个分镜必须是对象", index + 1),
            )
        })?;
        for key in values.keys() {
            if ![
                "prompt",
                "dialogue",
                "dialogueLang",
                "shotSize",
                "camera",
                "motion",
                "duration",
                "seed",
                "image",
                "references",
            ]
            .contains(&key.as_str())
            {
                return Err(error(
                    400,
                    "UNKNOWN_PARAMETER",
                    format!("分镜不支持参数：{key}"),
                ));
            }
        }
        let mut raw = json!({"camera":"still","motion":"subtle","duration":5});
        raw.as_object_mut().unwrap().extend(values.clone());
        raw["modelId"] = model["id"].clone();
        raw["aspectRatio"] = json!(aspect);
        raw["quality"] = json!(quality);
        if body["adultEnabled"] == true {
            raw["adultEnabled"] = json!(true);
        }
        if model["family"] == "minimax-h3" {
            raw["steps"] = json!(steps);
        }
        normalized.push(json!({"input":validation::validate(&raw,local,None)?}));
    }
    Ok(
        json!({"modelId":model["id"],"aspectRatio":aspect,"quality":quality,"linkLastFrame":linked,"steps":steps,"adultEnabled":body["adultEnabled"]==true,"accessContext":{"isLocal":local},"shots":normalized}),
    )
}
pub(super) fn recompose(input: &Value, batch: &Value) -> Result<Value> {
    let mut raw = json!({"prompt":input["originalPrompt"],"modelId":batch["modelId"],"aspectRatio":batch["aspectRatio"],"quality":input["quality"],"duration":input["duration"],"camera":input["camera"],"motion":input["motion"],"seed":input["seed"]});
    for key in [
        "image",
        "lastFrame",
        "references",
        "dialogue",
        "dialogueLang",
        "shotSize",
        "negative",
    ] {
        if generation::truthy(&input[key]) {
            raw[key] = input[key].clone();
        }
    }
    if batch["modelId"] == "minimax-h3" && generation::truthy(&input["steps"]) {
        raw["steps"] = input["steps"].clone();
    }
    if batch["adultEnabled"] == true {
        raw["adultEnabled"] = json!(true);
    }
    validation::validate(&raw, batch["accessContext"]["isLocal"] == true, None)
}
