//! Bounded MOSS acceleration evidence; no worker-selected data crosses unchanged.
use super::*;

pub(super) fn upscale(value: &Value) -> Option<Value> {
    let scale = value["scale"].as_f64().filter(|n| *n == 1.5 || *n == 2.)?;
    if value["device"] != "cuda"
        || value["upscaler"] != "Remacri"
        || value["executionRevision"] != "remacri-no-single-cat-packed-v1"
    {
        return None;
    }
    let hash = value["upscaleModelSha256"]
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))?;
    let mut result = json!({"operation":"moss-upscale","upscaler":"Remacri","device":"cuda",
        "scale":scale,"upscaleModelSha256":hash,"executionRevision":value["executionRevision"],
        "weightsCacheHit":value["weightsCacheHit"].as_bool()?,"performanceVerified":false});
    for (source, target) in [("sourceWidth", "width"), ("sourceHeight", "height")] {
        let original = value[source]
            .as_u64()
            .filter(|n| (512..=1536).contains(n) && n % 16 == 0)?;
        let output = value[target]
            .as_u64()
            .filter(|n| *n as f64 == original as f64 * scale)?;
        result[source] = json!(original);
        result[target] = json!(output);
    }
    result["elapsedSeconds"] = json!(
        value["elapsedSeconds"]
            .as_f64()
            .filter(|n| n.is_finite() && (0.0..=3600.0).contains(n))?
    );
    result["tileSize"] = json!(
        value["tileSize"]
            .as_u64()
            .filter(|n| [128, 256, 512].contains(n))?
    );
    result["tileCount"] = json!(
        value["tileCount"]
            .as_u64()
            .filter(|n| (1..=400).contains(n))?
    );
    Some(result)
}

pub(super) fn acceleration(value: &Value) -> Option<Value> {
    if value["algorithm"] == "off" && value["requested"] == false {
        return Some(json!({"algorithm":"off","requested":false}));
    }
    if value["algorithm"] != "moss-spectrum-v3"
        || value["requested"] != true
        || value["historySize"] != 6
        || value["warmupSteps"] != 6
        || value["tailSteps"] != 3
        || value["windowSize"] != 2
    {
        return None;
    }
    let flex = value["flexWindow"]
        .as_f64()
        .filter(|n| n.is_finite() && (0.0..=2.0).contains(n))?;
    let cap = value["maxConsecutiveForecasts"]
        .as_u64()
        .filter(|n| *n <= 100)?;
    let actual = value["actualForwards"].as_u64()?;
    let forecast = value["forecastForwards"].as_u64()?;
    let nonfinite = value["nonfiniteFallbacks"].as_u64()?;
    if actual > 200
        || forecast > 200
        || actual + forecast > 200
        || nonfinite > 200
        || cap > forecast
    {
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
        "historySize":6,"warmupSteps":6,"tailSteps":3,"windowSize":2,"flexWindow":flex,"maxConsecutiveForecasts":cap,
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
    if !matches!(precision, "bf16" | "fp8" | "int8") {
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
