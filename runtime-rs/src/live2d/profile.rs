use super::manifest::invalid;
use crate::error::Result;
use serde_json::{Value, json};

fn id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 160
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    })
}
fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|value| value.is_finite())
}
fn range(value: &Value) -> bool {
    value.as_array().is_some_and(|v| {
        v.len() == 2
            && number(&v[0])
                .zip(number(&v[1]))
                .is_some_and(|(a, b)| a <= b)
    })
}
fn endpoints(value: &Value) -> bool {
    range(&value["range"])
        && number(&value["closed"])
            .zip(number(&value["open"]))
            .is_some_and(|(a, b)| {
                a != b
                    && [a, b].iter().all(|n| {
                        *n >= value["range"][0].as_f64().unwrap()
                            && *n <= value["range"][1].as_f64().unwrap()
                    })
            })
}
fn check(valid: bool, message: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(invalid(message)) }
}

pub(super) fn validate(value: &Value, restoring: bool) -> Result<Value> {
    check(
        value.is_object() && serde_json::to_string(value)?.encode_utf16().count() <= 60000,
        "Invalid adapter profile",
    )?;
    let mut profile = value.clone();
    check(
        profile["schemaVersion"] == 1
            && id(&profile["profileId"])
            && id(&profile["avatarId"])
            && profile["profileVersion"]
                .as_str()
                .is_some_and(|v| v.encode_utf16().count() <= 80),
        "Invalid profile identity",
    )?;
    let backends = profile["backendCompatibility"]
        .as_array()
        .ok_or_else(|| invalid("Imported calibration requires browser backend"))?;
    check(
        backends.iter().any(|v| v == "browser")
            && backends
                .iter()
                .all(|v| v == "browser" || restoring && v == "native"),
        "Imported calibration requires browser backend",
    )?;
    let native = backends.iter().any(|v| v == "native");
    let bindings = profile["parameterBindings"]
        .as_object()
        .ok_or_else(|| invalid("Parameter bindings required"))?;
    for key in ["blink", "focus"] {
        if let Some(value) = bindings.get(key) {
            check(
                value
                    .as_array()
                    .is_some_and(|v| v.len() <= 256 && v.iter().all(id)),
                "Invalid parameter IDs",
            )?;
        }
    }
    if let Some(mouth) = bindings.get("mouth") {
        check(
            mouth.is_object() && id(&mouth["id"]) && number(&mouth["scale"]).is_some(),
            "Invalid mouth binding",
        )?;
        if let Some(value) = mouth.get("range") {
            check(range(value), "Invalid mouth range")?;
        }
        if mouth.get("closed").is_some() || mouth.get("open").is_some() {
            check(!native && endpoints(mouth), "Invalid mouth endpoints")?;
        }
    }
    if let Some(blink) = bindings.get("blinkCalibration") {
        check(!native && blink.is_object(), "Invalid blink calibration")?;
        for (key, value) in blink.as_object().unwrap() {
            check(
                bindings
                    .get("blink")
                    .and_then(Value::as_array)
                    .is_some_and(|ids| ids.iter().any(|id| id == key))
                    && endpoints(value),
                "Invalid blink endpoints",
            )?;
        }
    }
    check(
        !bindings.contains_key("custom"),
        "Custom channels are not supported by this editor",
    )?;
    if let Some(emotions) = profile.get("emotionParams") {
        check(emotions.is_object(), "Invalid emotion map")?;
        for (key, values) in emotions.as_object().unwrap() {
            check(
                id(&json!(key))
                    && values.as_object().is_some_and(|values| {
                        values
                            .iter()
                            .all(|(key, value)| id(&json!(key)) && number(value).is_some())
                    }),
                "Invalid emotion parameters",
            )?;
        }
    }
    if let Some(interactions) = profile.get("interactions") {
        check(interactions.is_object(), "Invalid interactions")?;
        for (key, value) in interactions.as_object().unwrap() {
            check(
                id(&json!(key))
                    && value.is_object()
                    && value["group"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty() && s.len() <= 160)
                    && value["hint"]
                        .as_str()
                        .is_some_and(|s| s.encode_utf16().count() <= 500)
                    && number(&value["duration"]).is_some_and(|n| n > 0.0 && n <= 600000.0),
                "Invalid interaction",
            )?;
        }
    }
    let interaction = |value: &Value| {
        value
            .as_str()
            .is_some_and(|id| profile["interactions"].get(id).is_some())
    };
    if let Some(default) = profile
        .get("defaultInteractionId")
        .filter(|v| !v.is_null() && **v != "")
    {
        check(interaction(default), "Unknown default interaction")?;
    }
    if let Some(zones) = profile.get("stageHitZones") {
        check(
            zones.as_array().is_some_and(|v| v.len() <= 64),
            "Invalid hit zones",
        )?;
        for zone in zones.as_array().unwrap() {
            let unit_range = |a: &Value, b: &Value| {
                number(a)
                    .zip(number(b))
                    .is_some_and(|(a, b)| a >= 0.0 && b <= 1.0 && a <= b)
            };
            check(
                zone.is_object()
                    && interaction(&zone["interactionId"])
                    && unit_range(&zone["minY"], &zone["maxY"])
                    && (zone.get("minX").is_none() && zone.get("maxX").is_none()
                        || unit_range(&zone["minX"], &zone["maxX"])),
                "Invalid hit zone",
            )?;
        }
    }
    if let Some(map) = profile.get("hitAreaMap") {
        check(
            map.as_object().is_some_and(|values| {
                values
                    .iter()
                    .all(|(key, value)| id(&json!(key)) && interaction(value))
            }),
            "Invalid hit area map",
        )?;
    }
    if let Some(fallbacks) = profile.get("hitAreaFallbacks") {
        check(
            fallbacks.as_array().is_some_and(|v| v.iter().all(id)),
            "Invalid hit fallbacks",
        )?;
    }
    if let Some(settle) = profile.get("overlaySettle") {
        check(
            settle.is_object()
                && number(&settle["settleMs"]).is_some_and(|n| n > 0.0)
                && settle["resetDefaults"].as_object().is_some_and(|values| {
                    values
                        .iter()
                        .all(|(key, value)| id(&json!(key)) && number(value).is_some())
                }),
            "Invalid settle parameters",
        )?;
    }
    if let Some(layout) = profile.get("layout") {
        check(layout.is_object(), "Invalid layout")?;
        if let Some(scale) = layout.get("scale") {
            check(
                number(scale).is_some_and(|n| n > 0.0 && n <= 10.0),
                "Invalid layout scale",
            )?;
        }
        if let Some(anchor) = layout.get("bubbleAnchor") {
            check(
                anchor.is_object()
                    && [&anchor["x"], &anchor["y"]]
                        .iter()
                        .all(|n| number(n).is_some_and(|n| (0.0..=1.0).contains(&n))),
                "Invalid bubble anchor",
            )?;
        }
    }
    check(
        profile["verification"].is_object()
            && matches!(
                profile["verification"]["status"].as_str(),
                Some("detected" | "needs-confirmation" | "verified" | "unsupported" | "invalid")
            ),
        "Invalid verification",
    )?;
    if profile["verification"]["status"] == "verified" {
        profile["verification"] = json!({"status":"needs-confirmation", "reason":"校准已保存；真实模型与设备表现仍待人工确认。"});
    }
    Ok(profile)
}
