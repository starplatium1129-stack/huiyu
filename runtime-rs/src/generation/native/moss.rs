//! Bounded MOSS acceleration evidence; no worker-selected data crosses unchanged.
use super::*;

pub(super) fn acceleration(value: &Value) -> Option<Value> {
    if value["algorithm"] == "off" && value["requested"] == false {
        return Some(json!({"algorithm":"off","requested":false}));
    }
    let cap = match value["algorithm"].as_str()? {
        "moss-spectrum-v1" => 1,
        "moss-spectrum-v2" => 3,
        _ => return None,
    };
    if value["requested"] != true
        || value["historySize"] != 6
        || value["warmupSteps"] != 6
        || value["tailSteps"] != 3
        || value["maxConsecutiveForecasts"] != cap
    {
        return None;
    }
    let actual = value["actualForwards"].as_u64()?;
    let forecast = value["forecastForwards"].as_u64()?;
    let nonfinite = value["nonfiniteFallbacks"].as_u64()?;
    if actual > 200 || forecast > 200 || actual + forecast > 200 || nonfinite > 200 {
        return None;
    }
    let effective = if forecast > 0 {
        "spectrum"
    } else {
        "full-compute"
    };
    if value["effective"] != effective {
        return None;
    }
    let reason = match &value["fallbackReason"] {
        Value::Null => Value::Null,
        Value::String(reason)
            if matches!(
                reason.as_str(),
                "insufficient-vram-headroom"
                    | "forecast-fit-failed"
                    | "nonfinite-forecast"
                    | "nonfinite-actual-features"
            ) =>
        {
            json!(reason)
        }
        _ => return None,
    };
    Some(
        json!({"algorithm":value["algorithm"],"requested":true,"effective":effective,
        "actualForwards":actual,"forecastForwards":forecast,"nonfiniteFallbacks":nonfinite,
        "historySize":6,"warmupSteps":6,"tailSteps":3,"maxConsecutiveForecasts":cap,
        "fallbackReason":reason,"performanceVerified":false,"qualityVerified":false}),
    )
}

pub(super) fn execution(value: &Value) -> Option<Value> {
    if value["schemaVersion"] != 1
        || value["timingMode"] != "cpu-wall-no-extra-sync"
        || value["timingsAreAdditive"] != false
    {
        return None;
    }
    let precision = value["textPrecision"].as_str()?;
    if !matches!(precision, "bf16" | "fp8") {
        return None;
    }
    let weights = value["weightPrecision"].as_str().unwrap_or("fp16");
    let quantized = value["quantizedLinearCount"].as_u64().unwrap_or(0);
    if !matches!((weights, quantized), ("fp16", 0) | ("int8-convrot", 168)) {
        return None;
    }
    let mut timings = json!({});
    for key in ["encoding", "sampling", "decoding"] {
        if let Some(seconds) = value["timings"].get(key) {
            timings[key] = json!(
                seconds
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0. && *n <= 3600.)?
            );
        }
    }
    let mut cache = json!({});
    for (key, limit) in [
        ("hits", 20_000),
        ("misses", 20_000),
        ("bytes", 64 * 1024 * 1024),
        ("modulationHits", 20_000),
    ] {
        cache[key] = json!(
            value["contextCache"][key]
                .as_u64()
                .filter(|n| *n <= limit)?
        );
    }
    let source = &value["compile"];
    let requested = source["requested"].as_bool()?;
    let blocks = source["compiledBlockCalls"]
        .as_u64()
        .filter(|n| *n <= 20_000)?;
    let text = source["compiledTextCalls"]
        .as_u64()
        .filter(|n| *n <= 20_000)?;
    if !requested && (blocks != 0 || text != 0) {
        return None;
    }
    let mut compile = json!({"requested":requested,"compiledBlockCalls":blocks,"compiledTextCalls":text,
        "nativeTextKernel":source["nativeTextKernel"].as_bool()?,"performanceVerified":false});
    for key in ["ditFallback", "textFallback"] {
        compile[key] = match &source[key] {
            Value::Null => Value::Null,
            Value::String(reason)
                if reason == "leaf-offload"
                    || (!reason.is_empty()
                        && reason.len() <= 80
                        && reason
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'_')) =>
            {
                json!(reason)
            }
            _ => return None,
        };
    }
    Some(
        json!({"schemaVersion":1,"timingMode":"cpu-wall-no-extra-sync","timingsAreAdditive":false,
        "textPrecision":precision,"weightPrecision":weights,"quantizedLinearCount":quantized,
        "timings":timings,"contextCache":cache,"compile":compile,"performanceVerified":false}),
    )
}
