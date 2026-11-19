mod anima;
use super::*;

fn memory_observation(source: &Value) -> Option<Value> {
    if !matches!(
        source["strategy"].as_str(),
        Some("budgeted-offload-v1" | "mapped-retained-offload-v1")
    ) {
        return None;
    }
    let components = source["components"].as_array()?;
    if components.len() > 16 {
        return None;
    }
    let mut result = json!({"strategy":source["strategy"],"components":[]});
    for key in ["freeBytes", "activationReserveBytes", "weightBudgetBytes"] {
        if let Some(value) = source.get(key) {
            result[key] = json!(value.as_u64().filter(|n| *n <= 1_u64 << 40)?);
        }
    }
    let mut names = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for component in components {
        let name = component["name"].as_str()?;
        let mode = component["mode"].as_str()?;
        if !matches!(
            name,
            "text_encoder"
                | "image_encoder"
                | "text_encoder_2"
                | "text_conditioner"
                | "transformer"
                | "transformer_2"
                | "vae"
                | "audio_vae"
                | "connectors"
                | "vocoder"
        ) || !names.insert(name)
            || !matches!(
                mode,
                "resident" | "component" | "block_level" | "leaf_level"
            )
        {
            return None;
        }
        let bytes = component["weightBytes"]
            .as_u64()
            .filter(|n| *n <= 1_u64 << 40)?;
        let mut row = json!({"name":name,"mode":mode,"weightBytes":bytes});
        if let Some(retained) = component.get("retainedWeightBytes") {
            row["retainedWeightBytes"] = json!(retained.as_u64().filter(|n| *n <= bytes)?);
        }
        if mode == "block_level" {
            row["blocksPerGroup"] = json!(
                component["blocksPerGroup"]
                    .as_u64()
                    .filter(|n| (1..=8).contains(n))?
            );
        }
        rows.push(row);
    }
    result["components"] = json!(rows);
    Some(result)
}

fn upload_observation(source: &Value) -> Option<Value> {
    let strategy = source["strategy"].as_str()?;
    if !matches!(
        strategy,
        "packed-pinned" | "packed-direct" | "module-to" | "deferred"
    ) {
        return None;
    }
    let mut captured = json!({"strategy":strategy});
    for (key, maximum) in [
        ("tensorBytes", 1_u64 << 40),
        ("transferBytes", 1 << 40),
        ("copyCalls", 1_000_000),
        ("stagingBytes", 64 * 1024 * 1024),
    ] {
        if let Some(value) = source.get(key) {
            let count = value.as_u64()?;
            if count > maximum {
                return None;
            }
            captured[key] = json!(count);
        }
    }
    Some(captured)
}

// Optional evidence must neither break legacy workers nor forward arbitrary worker data.
// Missing/malformed evidence stays visibly unverified; image/protocol checks are unchanged.
pub(super) fn capture(value: &Value) -> Value {
    if value["operation"] == "moss-upscale" {
        return super::moss::upscale(value).unwrap_or_else(|| json!({"status":"unverified","reason":"invalid-moss-upscale"}));
    }
    if value["processor"] == "manga-screen"
        && matches!(value["device"].as_str(), Some("cpu" | "cuda+cpu"))
        && value["sourceRevision"] == "d0eb8dcc6c45274e3eee118ff0dabe05b56039b9"
    {
        let mut result = json!({"processor":"manga-screen","sourceRevision":value["sourceRevision"],"device":value["device"],
            "validation":"待主力机验证","generationVerified":false,"performanceVerified":false});
        if let Some(timings) = super::execution::manga(&value["timings"]) { result["timings"] = timings; }
        if matches!(
            value["rewrite"]["adapter"].as_str(),
            Some("qwen-image-2.1" | "qwen-image-2.1-turbo")
        ) {
            result["rewrite"] = capture(&value["rewrite"]);
        }
        let line = &value["lineart"];
        if line["model"] == "manga-line-extraction"
            && matches!(line["device"].as_str(), Some("cpu" | "cuda"))
            && line["sourceRevision"] == "6ec136d5332180b65476e62c2558f2873d5d936a"
            && line["modelSha256"]
                .as_str()
                .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            result["lineart"] = json!({"model":"manga-line-extraction","device":line["device"],
                "sourceRevision":line["sourceRevision"],"modelSha256":line["modelSha256"],"validation":"待主力机验证"});
            if line["resultReused"].is_boolean() { result["lineart"]["resultReused"] = line["resultReused"].clone(); }
        }
        return result;
    }
    if let Some(id) = value["adapter"]
        .as_str()
        .filter(|id| super::adapters::model(id).is_some())
    {
        if value["modelSha256"]
            .as_str()
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            && matches!(value["memoryPolicy"].as_str(), Some("resident" | "offload"))
            && value["weightReuse"].is_boolean()
        {
            let mut result = json!({"adapter":id,"modelSha256":value["modelSha256"],"memoryPolicy":value["memoryPolicy"],
                "weightReuse":value["weightReuse"],"validation":"待主力机验证","performanceVerified":false});
            if matches!(
                value["modelIdentityScope"].as_str(),
                Some("prepared-download-record" | "full-byte-chunk-sha256")
            ) {
                result["modelIdentityScope"] = value["modelIdentityScope"].clone();
            }
            if matches!(value["prefixCacheDevice"].as_str(), Some("cpu" | "cuda" | "mixed" | "none")) {
                result["prefixCacheDevice"] = value["prefixCacheDevice"].clone();
            }
            if id.starts_with("qwen-") && value["resultReused"].is_boolean() { result["resultReused"] = value["resultReused"].clone(); }
            if id.starts_with("qwen-") && let Some(prefix) = value.get("qwenPrefixCache") {
                result["qwenPrefixCache"] = super::execution::qwen_prefix(prefix).unwrap_or_else(|| json!({"status":"unverified","reason":"invalid-qwen-prefix"}));
            }
            if matches!(
                value["attentionBackend"].as_str(),
                Some("sageattention-2.2" | "comfy-kitchen-int8" | "pytorch-sdpa" | "default")
            ) {
                result["attentionBackend"] = value["attentionBackend"].clone();
            }
            if id.starts_with("krea2-")
                && value["styleLoraSha256"]
                    .as_str()
                    .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                result["styleLoraSha256"] = value["styleLoraSha256"].clone();
            }
            if let Some(memory) = value.get("memoryScheduling") {
                result["memoryScheduling"] = memory_observation(memory).unwrap_or_else(
                    || json!({"status":"unverified","reason":"invalid-memory-scheduling"}),
                );
            }
            let video = &value["videoAcceleration"];
            if super::adapters::model(id).is_some_and(|m| m["media"] == "video")
                && matches!(video["device"].as_str(), Some("cuda" | "rocm" | "xpu"))
                && matches!(video["requested"].as_str(), Some("auto" | "sdpa" | "flash2" | "sage"))
                && matches!(video["selected"].as_str(), Some("sdpa" | "flash2" | "sage"))
                && matches!(video["encoder"].as_str(), Some("h264_nvenc" | "h264_amf" | "h264_qsv" | "libx264"))
                && ["sdpa", "slicedSdpa", "flash2", "sage"].iter().all(|key| video["calls"][*key].is_u64())
            {
                result["videoAcceleration"] = json!({
                    "device":video["device"], "requested":video["requested"], "selected":video["selected"], "encoder":video["encoder"],
                    "calls":{"sdpa":video["calls"]["sdpa"], "slicedSdpa":video["calls"]["slicedSdpa"],
                             "flash2":video["calls"]["flash2"], "sage":video["calls"]["sage"]}
                });
            }
            if id.starts_with("moss-") {
                result["mossAcceleration"] = super::moss::acceleration(&value["mossAcceleration"])
                    .unwrap_or_else(
                        || json!({"status":"unverified","reason":"invalid-moss-acceleration"}),
                    );
                if let Some(execution) = value.get("mossExecution") {
                    result["mossExecution"] = super::moss::execution(execution).unwrap_or_else(
                        || json!({"status":"unverified","reason":"invalid-moss-execution"}));
                }
            }
            return result;
        }
    }
    anima::capture(value)
}
