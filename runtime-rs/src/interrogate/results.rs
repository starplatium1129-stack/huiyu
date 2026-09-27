use serde_json::{Value, json};

pub(super) fn caption(tags: &Value) -> String {
    let mut subject = String::new();
    let mut phrases = Vec::<String>::new();
    for tag in tags
        .as_array()
        .into_iter()
        .flatten()
        .take(10)
        .filter_map(Value::as_str)
    {
        let known = match tag {
            "1girl" => "a girl",
            "1boy" => "a boy",
            "solo" => "alone",
            "smile" => "smiling",
            "blush" => "with a blush",
            "school_uniform" => "wearing a school uniform",
            "sailor_uniform" => "wearing a sailor uniform",
            "white_shirt" => "wearing a white shirt",
            "dress" => "wearing a dress",
            "skirt" => "wearing a skirt",
            "pleated_skirt" => "wearing a pleated skirt",
            "indoors" | "indoor" => "an indoor scene",
            "outdoors" | "outdoor" => "an outdoor scene",
            "night" => "at night",
            "day" => "in daylight",
            "window_light" => "light from a window",
            "depth_of_field" => "with depth of field",
            "bokeh" => "with a blurred background",
            "detailed_background" => "a detailed background",
            "simple_background" => "a simple background",
            "upper_body" => "an upper body shot",
            "full_body" => "a full body shot",
            "portrait" => "a portrait",
            "cowboy_shot" => "a cowboy shot",
            "cute" => "a cute look",
            "serious" => "a serious expression",
            "happy" => "a happy expression",
            "looking_at_viewer" => "looking at the viewer",
            _ => "",
        };
        if ["1girl", "1boy", "solo"].contains(&tag) {
            if subject.is_empty() {
                subject = known.into();
            }
            continue;
        }
        let phrase = if known.is_empty() {
            tag.replace('_', " ")
        } else {
            known.into()
        };
        if !phrases.contains(&phrase) {
            phrases.push(phrase);
        }
    }
    if subject.is_empty() {
        subject = "a character".into();
    }
    format!("{subject}, {}", phrases.join(", "))
}
pub(super) fn heuristic(mode: &str, threshold: f64, reason: &str) -> Value {
    let base = [
        ("1girl", 0.98),
        ("solo", 0.97),
        ("long_hair", 0.82),
        ("looking_at_viewer", 0.71),
        ("soft_lighting", 0.68),
        ("indoor", 0.62),
        ("window_light", 0.58),
        ("detailed_eyes", 0.55),
        ("school_uniform", 0.49),
        ("pleated_skirt", 0.44),
        ("blush", 0.41),
        ("depth_of_field", 0.38),
    ];
    let mut scores = serde_json::Map::new();
    let mut tags = Vec::new();
    for (tag, score) in base {
        if score >= threshold {
            scores.insert(tag.into(), json!(score));
            if mode == "tag" {
                tags.push(tag);
            }
        }
    }
    json!({"ok":true,"engine":"heuristic","mode":mode,"threshold":threshold,"tags":tags,"scores":scores,
        "caption":"a girl with long hair, soft window lighting, indoor scene, detailed eyes, school uniform, pleated skirt, depth of field","editable":true,
        "warning":format!("真实反推引擎未完成此请求（{reason}）；当前仅为启发式演示标签，不代表图片识别结果。")})
}
pub(super) fn finish(mut result: Value, engine: &str, mode: &str, threshold: f64) -> Value {
    result["ok"] = json!(true);
    result["engine"] = json!(engine);
    result["mode"] = json!(mode);
    result["threshold"] = json!(threshold);
    result["editable"] = json!(true);
    if engine == "wd14" && mode == "caption" {
        result["caption"] = json!(caption(&result["tags"]));
        result["captionDerived"] = json!("wd14-tags");
    } else if result.get("caption").is_none() {
        result["caption"] = json!(
            result["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    result
}
