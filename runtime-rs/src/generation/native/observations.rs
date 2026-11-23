mod anima;
use super::*;

fn memory_observation(source: &Value) -> Option<Value> {
    if !matches!(
        source["strategy"].as_str(),
        Some("budgeted-offload-v1" | "mapped-retained-offload-v1" | "video-file-backed-offload-v1" | "h3-file-backed-blocks-v2")
    ) {
        return None;
    }
    let components = source["components"].as_array()?;
    if components.len() > 16 {
        return None;
    }
    let mut result = json!({"strategy":source["strategy"],"components":[]});
    for key in [
        "freeBytes", "activationReserveBytes", "weightBudgetBytes", "availableCommitBytes",
        "minimumAvailableCommitBytes",
    ] {
        if let Some(value) = source.get(key) {
            result[key] = json!(value.as_u64().filter(|n| *n <= 1_u64 << 40)?);
        }
    }
    if let Some(value) = source.get("reclaimedWeightBytes") {
        result["reclaimedWeightBytes"] = json!(value.as_u64().filter(|n| *n <= 1_u64 << 48)?);
    }
    if let Some(value) = source.get("lowCommitStreamGroups") {
        result["lowCommitStreamGroups"] = json!(value.as_u64().filter(|n| *n <= 1_000_000)?);
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
                "resident" | "component" | "block_level" | "leaf_level" | "mapped-component"
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
    if let Some(stats) = source.get("h3BlockTransfers") {
        let mut captured = json!({});
        for key in ["plannedBlockBytes", "peakHeldBlockBytes", "blockHits", "uploadedTransformerBytes", "pressureReleases",
                    "prefetchEligibleBlocks", "prefetchHits", "prefetchGuardSkips", "prefetchedBlockBytes",
                    "completedMainPasses", "pressureReleaseRounds", "guardSkips"] {
            if let Some(value) = stats.get(key).and_then(Value::as_u64).filter(|n| *n <= 1_u64 << 48) {
                captured[key] = json!(value);
            }
        }
        if let Some(paused) = stats["retentionPaused"].as_bool() { captured["retentionPaused"] = json!(paused); }
        if let Some(headroom) = stats.get("firstBlockHeadroom") {
            let mut first = json!({});
            for key in ["freeBytes", "availableCommitBytes", "incomingBlockBytes", "reusableCudaBytes"] {
                if let Some(n) = headroom[key].as_u64().filter(|n| *n <= 1_u64 << 40) { first[key] = json!(n); }
            }
            captured["firstBlockHeadroom"] = first;
        }
        result["h3BlockTransfers"] = captured;
    }
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

fn krea_execution(source: &Value) -> Option<Value> {
    let tokens = source["textTokens"].as_array()?;
    if tokens.len() > 2 || !tokens.iter().all(|n| n.as_u64().is_some_and(|n| (1..=512).contains(&n))) {
        return None;
    }
    let mut result = json!({"textTokens":tokens});
    if source["weightTransport"] == "fp8-to-bf16" {
        result["weightTransport"] = source["weightTransport"].clone();
        result["transferredMatrices"] = json!(source["transferredMatrices"].as_u64().filter(|n| *n <= 1_000_000)?);
        result["packedTransferBytes"] = json!(source["packedTransferBytes"].as_u64().filter(|n| *n <= 1_u64 << 48)?);
    }
    for key in ["conditioningHits", "conditioningMisses", "fusionHits", "projectionHits", "rotaryHits"] {
        result[key] = json!(source[key].as_u64().filter(|n| *n <= 400)?);
    }
    if let Some(mode) = source["vaeDecode"].as_str().filter(|m| matches!(*m, "full" | "tiled")) {
        result["vaeDecode"] = json!(mode);
        result["vaeTiles"] = json!(source["vaeTiles"].as_u64().filter(|n| *n <= 4096)?);
    }
    Some(result)
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
            Some("qwen-image-2.1" | "qwen-image-2.1-turbo" | "qwen-image-2.1-manga-int8")
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
            if id == "musetalk-1.5" && value["modelReused"] == value["weightReuse"]
                && value["contextId"].as_str().is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                && matches!(value["portraitDetector"].as_str(), Some("anime" | "frontal"))
            {
                for key in ["modelReused", "contextId", "portraitDetector"] { result[key] = value[key].clone(); }
                for key in ["workerPid", "loadCount", "contextJobs", "speechSampleRate", "speechSamples",
                            "speechFrames", "outputFrames", "cudaPeakAllocatedBytes"] {
                    if let Some(n) = value[key].as_u64().filter(|n| *n <= 1_u64 << 40) {
                        result[key] = json!(n);
                    }
                }
                if let Some(rect) = value["faceBox"].as_array().filter(|rect| rect.len() == 4 &&
                    rect.iter().all(|n| n.as_u64().is_some_and(|n| n <= 4096))) {
                    result["faceBox"] = json!(rect);
                }
            }
            if matches!(id, "flux-kontext-dev" | "minimax-h3-image-q4")
                && value["contextId"].as_str().is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                && value["modelReused"] == value["weightReuse"]
            {
                result["contextId"] = value["contextId"].clone();
                result["modelReused"] = value["modelReused"].clone();
                for key in ["workerPid", "loadCount", "contextJobs", "referenceCount"] {
                    if let Some(count) = value[key].as_u64().filter(|n| *n > 0 && *n <= u32::MAX as u64) {
                        result[key] = json!(count);
                    }
                }
            }
            if id == "wan2.2-i2v-a14b-gguf" && value["tiledVae"] == true
                && value["contextId"].as_str().is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                && value["modelReused"] == value["weightReuse"]
                && matches!(value["wanMemoryTier"].as_str(), Some("balanced" | "conservative"))
            {
                for key in ["contextId","modelReused","wanMemoryTier","tiledVae"] {
                    result[key] = value[key].clone();
                }
                for key in ["workerPid","loadCount","contextJobs","vaeTilePixels","highNoiseSteps","lowNoiseSteps","vramBudgetGiB"] {
                    if value[key].as_u64().is_some_and(|n| n > 0 && n <= u32::MAX as u64) { result[key] = value[key].clone(); }
                }
                if value["firstLastFrame"].is_boolean() { result["firstLastFrame"] = value["firstLastFrame"].clone(); }
                if value["attentionPolicy"] == "cuda-flash-requested" && value["parameterBackend"] == "disk-mmap" {
                    result["attentionPolicy"] = value["attentionPolicy"].clone();
                    result["parameterBackend"] = value["parameterBackend"].clone();
                }
                if let Some(n) = value["tensorLoadEvents"].as_u64().filter(|n| *n <= 1_000_000) {
                    result["tensorLoadEvents"] = json!(n);
                }
                if let Some(n) = value["minCommitBytes"].as_u64().filter(|n| *n <= 1_u64 << 40) {
                    result["minCommitBytes"] = json!(n);
                }
                let times = &value["expertPassSeconds"];
                if ["high", "low"].iter().all(|key| times[*key].as_f64().is_some_and(|s| (0.0..=7200.0).contains(&s))) {
                    result["expertPassSeconds"] = json!({"high": times["high"], "low": times["low"]});
                }
                if let Some(assets) = super::adapters::model(id).and_then(|m| m["components"].as_object()) {
                    let hashes = &value["componentSha256"];
                    if hashes.as_object().is_some_and(|obj| obj.len() == assets.len())
                        && assets.iter().all(|(name, asset)| asset.as_str().is_some_and(|key|
                        hashes[name] == super::adapters::manifest()["keyframeAssets"][key]["sha256"])) {
                        result["componentSha256"] = hashes.clone();
                        if value["distillation"] == "lightx2v-260412-dual-checkpoint" {
                            result["distillation"] = value["distillation"].clone();
                        }
                    }
                }
                if value["nativeRelease"] == super::adapters::manifest()["keyframeRuntime"]["release"] {
                    result["nativeRelease"] = value["nativeRelease"].clone();
                }
            }
            if matches!(
                value["modelIdentityScope"].as_str(),
                Some("prepared-download-record" | "prepared-local-weights" | "full-byte-chunk-sha256")
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
            if id.starts_with("krea2-") && let Some(execution) = krea_execution(&value["kreaExecution"]) {
                result["kreaExecution"] = execution;
            }
            if id == "minimax-h3" && value["nativeModelFormat"] == "h3-comfy-packed-v1"
                && matches!(value["turboSteps"].as_u64(), Some(4 | 8)) {
                result["nativeModelFormat"] = value["nativeModelFormat"].clone();
                result["turboSteps"] = value["turboSteps"].clone();
                if matches!(value["h3Decoder"].as_str(), Some("original" | "lightvae-lite-fp16")) {
                    result["h3Decoder"] = value["h3Decoder"].clone();
                }
                if matches!(value["h3VideoShift"].as_u64(), Some(6 | 12)) && value["h3AudioShift"] == 3 {
                    result["h3VideoShift"] = value["h3VideoShift"].clone();
                    result["h3AudioShift"] = value["h3AudioShift"].clone();
                }
                if let Some(counts) = value.get("h3Conditioning") {
                    let mut captured = json!({});
                    for key in ["textHits", "textMisses", "visionHits", "visionMisses", "keyframeHits", "keyframeMisses",
                                "nvfp4FusedMatrices", "nvfp4EagerMatrices",
                                "textProjectionHits", "textProjectionMisses", "tokenRefinerHits", "tokenRefinerMisses",
                                "qkvLoraGroupedMatrices"] {
                        if let Some(n) = counts[key].as_u64().filter(|n| *n <= 1_000_000) { captured[key] = json!(n); }
                    }
                    if let Some(n) = counts["qkvLoraOmittedZeroBytes"].as_u64().filter(|n| *n <= 1_u64 << 33) {
                        captured["qkvLoraOmittedZeroBytes"] = json!(n);
                    }
                    result["h3Conditioning"] = captured;
                }
                if let Some(stats) = value.get("h3Modulation") {
                    let mut captured = json!({});
                    for key in ["boundBlocks", "scaleShiftCalls", "gatedResidualCalls", "eagerCalls"] {
                        if let Some(n) = stats[key].as_u64().filter(|n| *n <= 1_000_000) { captured[key] = json!(n); }
                    }
                    if let Some(kernel) = stats["kernel"].as_str().filter(|s| s.len() <= 48 && s.is_ascii()) {
                        captured["kernel"] = json!(kernel);
                    }
                    result["h3Modulation"] = captured;
                }
                if let Some(stats) = value.get("h3Rotary") {
                    let mut captured = json!({});
                    for key in ["calls", "verifiedRows", "verifiedCalls", "eagerCalls"] {
                        if let Some(n) = stats[key].as_u64().filter(|n| *n <= 1_000_000) { captured[key] = json!(n); }
                    }
                    if stats["kernel"] == "triton-cuda-bf16" { captured["kernel"] = stats["kernel"].clone(); }
                    result["h3Rotary"] = captured;
                }
            }
            if let Some(memory) = value.get("memoryScheduling") {
                result["memoryScheduling"] = memory_observation(memory).unwrap_or_else(
                    || json!({"status":"unverified","reason":"invalid-memory-scheduling"}),
                );
            }
            let video = &value["videoAcceleration"];
            if super::adapters::model(id).is_some_and(|m| m["media"] == "video")
                && matches!(video["device"].as_str(), Some("cuda" | "rocm" | "xpu"))
                && matches!(video["requested"].as_str(), Some("auto" | "sdpa" | "flash2" | "sage" | "h3-sol" | "h3-sla" | "h3-fused"))
                && matches!(video["selected"].as_str(), Some("sdpa" | "flash2" | "sage" | "h3-sol" | "h3-sla" | "h3-fused"))
                && matches!(video["encoder"].as_str(), Some("h264_nvenc" | "h264_amf" | "h264_qsv" | "libx264"))
                && ["sdpa", "slicedSdpa", "flash2", "sage"].iter().all(|key| video["calls"][*key].is_u64())
            {
                result["videoAcceleration"] = json!({
                    "device":video["device"], "requested":video["requested"], "selected":video["selected"], "encoder":video["encoder"],
                    "calls":{"sdpa":video["calls"]["sdpa"], "slicedSdpa":video["calls"]["slicedSdpa"],
                             "flash2":video["calls"]["flash2"], "sage":video["calls"]["sage"]}
                });
                if id == "minimax-h3" {
                    let stored = &mut result["videoAcceleration"];
                    for key in ["h3-sol", "h3-sla", "h3-fused"] {
                        if let Some(n) = video["calls"][key].as_u64().filter(|n| *n <= 10_000) {
                            stored["calls"][key] = json!(n);
                        }
                    }
                    let sparse = &video["sparse"];
                    if let Some(reason) = sparse["reason"].as_str().filter(|s| matches!(*s, "not-used" | "executed"
                        | "unsupported-layout" | "unsupported-shape" | "unsupported-model" | "unsupported-device"
                        | "short-sequence" | "dense-first-pass" | "compiled-kernel-unavailable" | "kernel-rejected-call")) {
                        let mut route = json!({"reason":reason});
                        if sparse["kernel"] == "comfy-kitchen-cuda" { route["kernel"] = sparse["kernel"].clone(); }
                        if matches!(sparse["routing"].as_str(), Some("top-k" | "adaptive")) { route["routing"] = sparse["routing"].clone(); }
                        if sparse["keepRatio"] == 0.15 || sparse["keepRatio"] == 0.10 { route["keepRatio"] = sparse["keepRatio"].clone(); }
                        for key in ["rows", "protectedRows"] {
                            if let Some(n) = sparse[key].as_u64().filter(|n| *n <= 1_000_000) { route[key] = json!(n); }
                        }
                        stored["sparse"] = route;
                    }
                }
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
