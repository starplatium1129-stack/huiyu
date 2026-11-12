//! Bounded execution observations from Anima and the manga processor.
use super::*;

fn timings(source: &Value, names: &[&str]) -> Option<Value> {
    let mut result = json!({});
    source.as_object()?;
    for name in names {
        if let Some(seconds) = source.get(*name) {
            result[*name] = json!(
                seconds
                    .as_f64()
                    .filter(|n| n.is_finite() && (0.0..=86_400.0).contains(n))?
            );
        }
    }
    Some(result)
}

pub(super) fn manga(source: &Value) -> Option<Value> {
    timings(
        source,
        &[
            "rewriteWallSeconds",
            "postprocessWallSeconds",
            "workerWallSeconds",
        ],
    )
}

pub(super) fn anima(source: &Value) -> Option<Value> {
    if source["schemaVersion"] != 1
        || source["timingMode"] != "cpu-wall-no-extra-sync"
        || source["timingsAreAdditive"] != false
    {
        return None;
    }
    let mut cache = json!({});
    for (key, limit) in [
        ("hits", 40_000),
        ("misses", 40_000),
        ("bytes", 16 * 1024 * 1024),
    ] {
        cache[key] = json!(source["ropeCache"][key].as_u64().filter(|n| *n <= limit)?);
    }
    let mut compilation = json!({"leafOffload":source["compile"]["leafOffload"].as_bool()?});
    for (key, limit) in [("compiledBlockCalls", 1_000_000), ("recompileSkips", 80)] {
        compilation[key] = json!(source["compile"][key].as_u64().filter(|n| *n <= limit)?);
    }
    let failures = source["compile"]["failures"].as_array()?;
    if failures.len() > 8
        || failures.iter().any(|v| {
            !matches!(
                v.as_str(),
                Some(
                    "TorchDynamoException"
                        | "BackendCompilerFailed"
                        | "ConstraintViolationError"
                        | "Unsupported"
                        | "InternalTorchDynamoError"
                        | "UserError"
                        | "RecompileLimitExceeded"
                        | "CompilerError"
                )
            )
        })
    {
        return None;
    }
    compilation["failures"] = json!(failures);
    let kernel = match source["kernelBackend"].as_str() {
        Some("pytorch" | "triton-cosmos-v1" | "rocm-bounded-sdpa")
            if source["kernelScope"] == "configured" => {
            source["kernelBackend"].clone()
        }
        None => json!("unverified"),
        _ => return None,
    };
    Some(
        json!({"schemaVersion":1,"timingMode":"cpu-wall-no-extra-sync","timingsAreAdditive":false,
        "timings":timings(&source["timings"], &["encoding", "sampling", "decoding"])?,
        "ropeCache":cache,"compile":compilation,"kernelBackend":kernel,"kernelScope":"configured","performanceVerified":false}),
    )
}

pub(super) fn qwen_prefix(source: &Value) -> Option<Value> {
    if source["schemaVersion"] != 1 || source["policy"] != "budgeted-lossless-v1" {
        return None;
    }
    let mut result = json!({"schemaVersion":1,"policy":"budgeted-lossless-v1",
        "pinFallback":source["pinFallback"].as_bool()?,"performanceVerified":false});
    for (key, limit) in [
        ("gpuLayers", 128_u64),
        ("cpuLayers", 128),
        ("gpuBytes", 1 << 36),
        ("cpuBytes", 1 << 36),
        ("pinnedBytes", 512 * 1024 * 1024),
        ("stagingBytes", 512 * 1024 * 1024),
        ("asyncLoads", 100_000),
        ("prefetchLoads", 100_000),
        ("prefetchHits", 100_000),
        ("synchronousLoads", 100_000),
    ] {
        result[key] = json!(source[key].as_u64().filter(|n| *n <= limit)?);
    }
    Some(result)
}
