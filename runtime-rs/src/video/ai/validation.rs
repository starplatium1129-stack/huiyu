use super::*;

pub(super) fn validate(action: &str, body: &Value) -> Result<Value> {
    if !body.is_object() {
        return Err(invalid("请求体必须是 JSON 对象"));
    }
    match action {
        "rewrite" => {
            for key in body.as_object().unwrap().keys() {
                if ![
                    "identity", "prompt", "shotSize", "camera", "motion", "dialogue",
                ]
                .contains(&key.as_str())
                {
                    return Err(invalid(format!("不支持的参数：{key}")));
                }
            }
            let mut result = shot(body, None, true)?;
            result["identity"] = json!(clean_string(&body["identity"], 600));
            Ok(result)
        }
        "polish" | "review" => {
            let minimum = if action == "polish" { 2 } else { 1 };
            let shots = list(&body["shots"]);
            if shots.len() < minimum || shots.len() > 30 {
                return Err(invalid(format!("分镜数量需为 {minimum}—30")));
            }
            let values = shots
                .iter()
                .enumerate()
                .map(|(i, value)| shot(value, Some(i + 1), action == "polish"))
                .collect::<Result<Vec<_>>>()?;
            let mut result = json!({"shots":values});
            if action == "polish" {
                result["identity"] = json!(clean_string(&body["identity"], 600));
            }
            Ok(result)
        }
        "dialogue" => {
            let prompt = string(&body["prompt"], "");
            let prompt = trim(&prompt);
            if prompt.is_empty() || length(prompt) > 4000 {
                return Err(invalid("镜头描述需为 1—4000 字符"));
            }
            Ok(
                json!({"prompt":prompt,"identity":clean_string(&body["identity"],600),"currentDialogue":clean_string(&body["currentDialogue"],300),"mood":clean_string(&body["mood"],60)}),
            )
        }
        "script" => {
            let story = string(&body["story"], "");
            let story = trim(&story);
            if story.is_empty() || length(story) > 2000 {
                return Err(invalid("故事梗概需为 1—2000 字符"));
            }
            let mut result = json!({"story":story,"identity":clean_string(&body["identity"],600),"characterLabels":list(&body["characterLabels"]).iter().map(text).filter(|s|!s.is_empty()).take(6).collect::<Vec<_>>()});
            for (key, min, max, message) in [
                ("shotCount", 4., 20., "镜头数需为 4—20 的整数"),
                ("totalSeconds", 15., 300., "总时长需为 15—300 秒"),
            ] {
                if body[key].is_null() || body[key] == "" {
                    result[key] = Value::Null;
                    continue;
                }
                let number = number(body.get(key));
                if !number.is_finite() || number.fract() != 0. || number < min || number > max {
                    return Err(invalid(message));
                }
                result[key] = json!(number as u64);
            }
            Ok(result)
        }
        _ => Err(invalid("未知 AI 操作")),
    }
}
fn shot(body: &Value, index: Option<usize>, strict: bool) -> Result<Value> {
    if !body.is_object() {
        return Err(invalid(format!(
            "第 {} 个分镜必须是对象",
            index.unwrap_or(1)
        )));
    }
    let prompt = string(&body["prompt"], "");
    let prompt = trim(&prompt);
    if prompt.is_empty() || length(prompt) > 4000 {
        return Err(invalid(
            index
                .map(|i| format!("第 {i} 个分镜描述需为 1—4000 字符"))
                .unwrap_or_else(|| "画面描述需为 1—4000 字符".into()),
        ));
    }
    let size = if body["shotSize"].is_null() || body["shotSize"] == "" {
        Value::Null
    } else {
        json!(text(&body["shotSize"]))
    };
    let camera = string(&body["camera"], "still");
    let motion = string(&body["motion"], "subtle");
    if strict {
        for (bad, label, simple) in [
            (
                !size.is_null() && !SIZES.contains(&size.as_str().unwrap()),
                "景别",
                "不支持的景别",
            ),
            (
                !CAMERAS.contains(&camera.as_str()),
                "镜头运动",
                "不支持的镜头运动",
            ),
            (
                !MOTIONS.contains(&motion.as_str()),
                "主体运动",
                "不支持的主体运动",
            ),
        ] {
            if bad {
                return Err(invalid(
                    index
                        .map(|i| format!("第 {i} 个分镜{label}不支持"))
                        .unwrap_or_else(|| simple.into()),
                ));
            }
        }
    }
    Ok(
        json!({"prompt":prompt,"shotSize":size,"camera":camera,"motion":motion,"dialogue":clean_string(&body["dialogue"],300)}),
    )
}
