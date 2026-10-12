use super::*;

// Optional evidence must neither break legacy workers nor forward arbitrary worker data.
// Missing/malformed evidence stays visibly unverified; image/protocol checks are unchanged.
pub(super) fn capture(value: &Value) -> Value {
    fn finite(value: &Value) -> Option<f64> {
        value.as_f64().filter(|n| n.is_finite() && *n >= 0.)
    }
    let parsed = (|| -> Option<Value> {
        if value["schemaVersion"] != 1
            || value["timingMode"] != "cpu-wall-no-extra-sync"
            || value["timingsAreAdditive"] != false
        {
            return None;
        }
        let mut result = json!({"schemaVersion":1,"timingMode":"cpu-wall-no-extra-sync",
            "timingsAreAdditive":false,"baseReused":value["baseReused"].as_bool()?,
            "existingReportSynchronization":value["existingReportSynchronization"].as_bool()?,
            "completedSteps":value["completedSteps"].as_u64()?,"timings":{}});
        if let Some(policy) = value.get("memoryPolicy") {
            let policy = policy.as_str()?;
            if !matches!(policy, "resident" | "offload") {
                return None;
            }
            result["memoryPolicy"] = json!(policy);
        }
        if let Some(revision) = value.get("samplingRevision") {
            if !matches!(
                revision.as_str()?,
                "anima-comfy-noise-tail-v2" | "anima-workflow-effects-v3"
            ) {
                return None;
            }
            result["samplingRevision"] = revision.clone();
        }
        if let Some(revision) = value.get("maskExecutionRevision") {
            if revision.as_str()? != "clipseg-single-image-vision-v1" {
                return None;
            }
            result["maskExecutionRevision"] = revision.clone();
        }
        if let Some(components) = value.get("componentReuse") {
            let components = components.as_array()?;
            let mut names = std::collections::HashSet::new();
            for component in components {
                let name = component.as_str()?;
                if !matches!(name, "text_encoder" | "vae" | "tokenizer" | "t5_tokenizer")
                    || !names.insert(name)
                {
                    return None;
                }
            }
            result["componentReuse"] = json!(components);
        }
        for key in [
            "workerWallSeconds",
            "imagePreparationWallSeconds",
            "modelAcquireWallSeconds",
            "pipelineWallSeconds",
            "compositeWallSeconds",
            "outputSaveSeconds",
            "residentFingerprintSeconds",
        ] {
            result["timings"][key] = json!(finite(&value["timings"][key])?);
        }
        if let Some(seconds) = value["timings"].get("postprocessWallSeconds") {
            result["timings"]["postprocessWallSeconds"] = json!(finite(seconds)?);
        }
        if let Some(loading) = value.get("loading").filter(|v| !v.is_null()) {
            if loading["strategy"] != "component-sequential-v1" {
                return None;
            }
            let components = loading["components"].as_array()?;
            if components.len() > 4 {
                return None;
            }
            let mut names = std::collections::HashSet::new();
            let mut captured_components = Vec::new();
            for component in components {
                let name = component["name"].as_str()?;
                if !matches!(
                    name,
                    "text_encoder" | "text_conditioner" | "transformer" | "vae"
                ) || !names.insert(name)
                {
                    return None;
                }
                let strategy = component["upload"]["strategy"].as_str()?;
                if !matches!(
                    strategy,
                    "packed-pinned" | "packed-direct" | "module-to" | "deferred"
                ) {
                    return None;
                }
                let mut captured = json!({"name":name,
                    "readWallSeconds":finite(&component["readWallSeconds"])?,
                    "uploadWallSeconds":finite(&component["uploadWallSeconds"])?,
                    "upload":{"strategy":strategy}});
                for (key, maximum) in [
                    ("tensorBytes", 1_u64 << 40),
                    ("transferBytes", 1 << 40),
                    ("copyCalls", 1_000_000),
                    ("stagingBytes", 64 * 1024 * 1024),
                ] {
                    if let Some(value) = component["upload"].get(key) {
                        let count = value.as_u64()?;
                        if count > maximum {
                            return None;
                        }
                        captured["upload"][key] = json!(count);
                    }
                }
                captured_components.push(captured);
            }
            result["loading"] =
                json!({"strategy":"component-sequential-v1","components":captured_components});
        }
        let groups: [(&str, &[&str], &[&str]); 3] = [
            (
                "textCache",
                &[],
                &[
                    "hits",
                    "misses",
                    "partialNegativeHits",
                    "entries",
                    "cpuBytes",
                ],
            ),
            (
                "maskCache",
                &["used", "modelReused", "resultReused", "visionReused"],
                &["resultBytes", "visionBytes", "visionEncodes"],
            ),
            (
                "teaCache",
                &[],
                &[
                    "fullComputes",
                    "skippedComputes",
                    "skippedBlocks",
                    "resets",
                    "nonfinite",
                ],
            ),
        ];
        for (group, flags, counters) in groups {
            let source = value[group].as_object()?;
            result[group] = json!({"enabled":source.get("enabled")?.as_bool()?});
            for &key in flags {
                if let Some(v) = source.get(key) {
                    result[group][key] = json!(v.as_bool()?);
                }
            }
            for &key in counters {
                if let Some(v) = source.get(key) {
                    result[group][key] = json!(v.as_u64()?);
                }
            }
        }
        if let Some(v) = value["maskCache"].get("fingerprintSeconds") {
            result["maskCache"]["fingerprintSeconds"] = json!(finite(v)?);
        }
        if let Some(reason) = value["teaCache"].get("reason") {
            let reason = reason.as_str()?;
            if !matches!(
                reason,
                "matched-profile" | "request-disabled" | "no-matching-profile"
            ) {
                return None;
            }
            result["teaCache"]["reason"] = json!(reason);
        }
        let memory = &value["memory"];
        if memory["deviceIndex"] != 0 || memory["scope"] != "image-preparation-through-pipeline" {
            return None;
        }
        let mut captured = json!({"deviceIndex":0,"scope":"image-preparation-through-pipeline"});
        match memory["status"].as_str()? {
            "per-job-allocator" => {
                captured["status"] = json!("per-job-allocator");
                captured["reason"] = Value::Null;
                for key in ["peakAllocatedBytes", "peakReservedBytes"] {
                    captured[key] = json!(memory[key].as_u64()?);
                }
            }
            "unverified" => {
                let reason = memory["reason"].as_str()?;
                if !matches!(
                    reason,
                    "cuda-uninitialized-at-window-start"
                        | "unsupported-allocator"
                        | "allocator-observation-error"
                ) || !memory["peakAllocatedBytes"].is_null()
                    || !memory["peakReservedBytes"].is_null()
                {
                    return None;
                }
                captured["status"] = json!("unverified");
                captured["reason"] = json!(reason);
                captured["peakAllocatedBytes"] = Value::Null;
                captured["peakReservedBytes"] = Value::Null;
            }
            _ => return None,
        }
        result["memory"] = captured;
        if let Some(refinement) = value.get("refinement") {
            let operations = refinement["vaeOperations"].as_array()?;
            if operations.len() > 4 {
                return None;
            }
            let tile = |source: &Value| -> Option<Value> {
                let mut captured = json!({});
                for key in ["tileSize", "overlap", "tileCount"] {
                    let number = source[key].as_u64()?;
                    if number > 1_000_000 {
                        return None;
                    }
                    captured[key] = json!(number);
                }
                let device = source["outputDevice"].as_str()?;
                if !matches!(device, "cpu" | "cuda") {
                    return None;
                }
                captured["outputDevice"] = json!(device);
                Some(captured)
            };
            let mut parsed_operations = Vec::new();
            for operation in operations {
                let kind = operation["kind"].as_str()?;
                let mode = operation["mode"].as_str()?;
                if !matches!(kind, "encode" | "decode") || !matches!(mode, "full" | "tiled") {
                    return None;
                }
                let mut captured = tile(operation)?;
                captured["kind"] = json!(kind);
                captured["mode"] = json!(mode);
                parsed_operations.push(captured);
            }
            result["refinement"] = json!({"vaeOperations":parsed_operations,"upscale":null});
            if !refinement["upscale"].is_null() {
                result["refinement"]["upscale"] = tile(&refinement["upscale"])?;
            }
        }
        Some(result)
    })();
    parsed.unwrap_or_else(|| json!({"status":"unverified","reason":if value.is_null(){"worker-metrics-missing"}else{"invalid-worker-metrics"}}))
}
