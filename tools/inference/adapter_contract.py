"""Local-only adapter layout and request boundary; no ML imports or model execution."""
from __future__ import annotations

import json
import math
from pathlib import Path
from huiyu_worker_lifecycle import WorkerError, load_sibling


class AdapterError(WorkerError):
    pass


def document(path):
    # LTX-2.3's Gemma tokenizer configuration includes its added-token table.
    limit = (2 if path.name == "tokenizer_config.json" else 1) * 1024 * 1024
    if not path.is_file() or path.stat().st_size > limit:
        raise AdapterError("MODEL_INCOMPLETE", f"Missing/oversized JSON: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("expected object")
        return data
    except (OSError, ValueError) as exc:
        raise AdapterError("MODEL_INVALID", f"Invalid JSON: {path}: {exc}") from exc


MANIFEST = document(Path(__file__).with_name("adapter-models.json"))


def local_h3(root, spec):
    pack = spec.get("localPack")
    if not pack or not (root / "transformer/comfy.safetensors").exists():
        return None
    marker = root / "huiyu-model.json"
    receipt = config(root, marker)
    stamp = marker.stat().st_mtime_ns
    if (receipt.get("schemaVersion") != 1 or receipt.get("modelId") != "minimax-h3" or receipt.get("revision") != spec["revision"]
            or receipt.get("scope") != "converted-local-weights-sha256"
            or receipt.get("representation") != pack["format"] or receipt.get("sourceRevision") != pack["revision"]):
        raise AdapterError("MODEL_INVALID", "H3 本地权重缺少匹配的导入凭据，请重新导入")
    files = receipt.get("files")
    if not isinstance(files, list) or any(not isinstance(item, dict) or not isinstance(item.get("path"), str) for item in files):
        raise AdapterError("MODEL_INVALID", "H3 本地权重缺少文件校验记录")
    recorded = {item["path"]: item for item in files}
    steps = [4]
    for asset in pack["files"]:
        name = asset["path"]
        if asset.get("optional") and name not in recorded and not (root / name).exists():
            continue
        info = safe_file(root, root / name).stat()
        if (recorded.get(name, {}).get("bytes") != asset["bytes"] or recorded.get(name, {}).get("sha256") != asset["sha256"]
                or info.st_size != asset["bytes"] or info.st_mtime_ns > stamp):
            raise AdapterError("MODEL_INVALID", f"H3 本地权重与导入凭据不匹配：{name}")
        if name == "loras/turbo-8.safetensors":
            steps.append(8)
    return steps


def model(model_id):
    if not isinstance(model_id, str) or model_id not in MANIFEST["models"]:
        raise AdapterError("NATIVE_MODEL_UNSUPPORTED", "Model has no native adapter; no ComfyUI fallback")
    return MANIFEST["models"][model_id]


def resolve_local_h3(root, spec, data, local_steps, *, auto_steps):
    """Resolve only verified assets for this job. Saved decoder/step choices are binding."""
    if spec["family"] != "minimax-h3":
        return
    mode = data.get("videoAttention", "auto")
    decoder = data.get("h3Decoder")
    extras = load_sibling("import_h3").prepared_accelerators(root) if local_steps else {}
    if auto_steps and local_steps:
        use_dwd = decoder == "dwd" or (decoder is None and "dwd" in extras and mode not in ("h3-sla", "h3-fused"))
        data["steps"] = 2 if use_dwd else local_steps[0]
        if not use_dwd and decoder is None:
            decoder = data["h3Decoder"] = "lightvae" if "lightvae" in extras else "original"
    steps = data["steps"]
    dwd = steps == 2 or decoder == "dwd"
    if dwd:
        if steps != 2 or decoder not in (None, "dwd") or mode in ("h3-sla", "h3-fused"):
            raise AdapterError("UNSUPPORTED_ACCELERATION", "pi-H3 DWD 需要 2 步，不能搭配 Turbo 解码器、SLA 或融合权重。")
        if "dwd" not in extras:
            raise AdapterError("MODEL_CHANGED", "pi-H3 DWD 的本地权重或校验凭据未就绪，请先导入 2 步 DWD 加速包。")
        data["_h3DwdPath"] = safe_file(root, root / extras["dwd"][0]["path"])
        data["h3Decoder"] = "dwd"
    elif local_steps is None:
        if mode.startswith("h3-") or decoder is not None or "h3VideoShift" in data:
            raise AdapterError("UNSUPPORTED_ACCELERATION", "此选项需要本机量化版 H3。")
        return
    elif steps not in local_steps:
        raise AdapterError("INVALID_PARAMETER", f"本地 H3 Turbo 已安装的步数为 {local_steps}，请重新选择步数。")
    data["_h3TurboSteps"] = steps
    data.setdefault("h3VideoShift", 6 if steps == 4 and mode != "h3-fused" else 12)
    if mode in ("h3-sla", "h3-fused") or decoder == "lightvae":
        if decoder == "lightvae" and "lightvae" not in extras:
            raise AdapterError("MODEL_CHANGED", "此配方所需的 H3 LightVAE 权重未就绪。")
        if mode in ("h3-sla", "h3-fused"):
            kind = mode.removeprefix("h3-")
            if steps != 4 or kind not in extras or data["h3VideoShift"] != (6 if kind == "sla" else 12):
                raise AdapterError("UNSUPPORTED_ACCELERATION", "所选 H3 加速需要对应的四步权重和采样偏移。")
            data["_h3AccelerationPath"] = safe_file(root, root / extras[kind][0]["path"])


def safe_file(root, path):
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        raise AdapterError("MODEL_INVALID", f"Linked model asset is unsupported: {path}")
    if not path.resolve().is_relative_to(root) or not path.is_file() or path.stat().st_size == 0:
        raise AdapterError("MODEL_INCOMPLETE", f"Missing/unsafe local asset: {path}")
    return path


def config(root, path):
    value = document(safe_file(root, path))
    if any(key in value for key in ("auto_map", "quantization_config", "custom_pipeline", "trust_remote_code")):
        raise AdapterError("UNSUPPORTED_MODEL", f"Quantized/custom-code models are not supported: {path}")
    return value


def layout(value, spec):
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise AdapterError("MODEL_INVALID", "modelDir must be an absolute local model directory")
    root = Path(value).resolve()
    if spec.get("runner") == "musetalk-native":
        load_sibling("musetalk_native").resource_files(root, spec)
        return root
    if spec.get("runner") in ("sd-cpp", "wan-a14b-sd"):
        load_sibling("keyframe_sd").resources(root, spec)
        return root
    if spec.get("runner") == "longcat-avatar":
        bundle = next(item for item in document(Path(__file__).with_name("managed-adapter-models.json"))["models"]
                      if item["id"] == "longcat-avatar-1.6")
        for item in bundle["files"]:
            if safe_file(root, root / item["path"]).stat().st_size != item["bytes"]:
                raise AdapterError("MODEL_INCOMPLETE", f"LongCat file has unexpected size: {item['path']}")
        return root
    index = config(root, root / spec.get("indexFile", "model_index.json"))
    if index.get("_class_name") != spec["pipeline"]:
        raise AdapterError("MODEL_INVALID", f"Expected {spec['pipeline']}; Comfy split files cannot be used")
    layout_name = spec.get("layout", spec["pipeline"])
    for field, source in MANIFEST["variantFields"].get(layout_name, {}).items():
        if not same_index_value(index.get(field), spec.get(source)):
            raise AdapterError("MODEL_INVALID", f"{layout_name}: {field} does not match the selected model variant")
    if spec["pipeline"] == "WanPipeline" and spec.get("layout") != "WanA14B" and (index.get("expand_timesteps") is not True
            or index.get("boundary_ratio") is not None or index.get("transformer_2", [None, None]) != [None, None]):
        raise AdapterError("MODEL_INVALID", "Expected the single-transformer Wan 2.2 TI2V 5B configuration")
    if layout_name == "WanA14B" and index.get("expand_timesteps", False) is not False:
        raise AdapterError("MODEL_INVALID", "Expected Wan A14B T2V high/low-noise boundary 0.875")
    modular = spec.get("blocks") is not None
    if modular and index.get("_blocks_class_name") != spec["blocks"]:
        raise AdapterError("MODEL_INVALID", f"Expected modular blocks {spec['blocks']}")
    for name, types in MANIFEST["layouts"][layout_name].items():
        entry = index.get(name)
        if not isinstance(entry, list) or len(entry) not in ((2, 3) if modular else (2,)) or entry[0] != types[0] or entry[1] not in types[1:]:
            raise AdapterError("MODEL_INVALID", f"Unsupported component identity: {name}")
        folder = root / name
        if folder.is_symlink() or getattr(folder, "is_junction", lambda: False)():
            raise AdapterError("MODEL_INVALID", f"Linked component: {name}")
        if name in ("scheduler", "audio_scheduler", "guider"):
            cfg = config(root, folder / ("guider_config.json" if name == "guider" else "scheduler_config.json"))
            if cfg.get("_class_name") != entry[1] or cfg.get("stochastic_sampling"):
                raise AdapterError("MODEL_INVALID", "Unexpected scheduler configuration")
        elif name in ("tokenizer", "tokenizer_2", "processor"):
            tokenizer = config(root, folder / "tokenizer_config.json")
            cfg = tokenizer
            qwen_processor = name == "tokenizer" and entry[1] == "Qwen2_5_VLProcessor"
            if qwen_processor and (tokenizer.get("tokenizer_class") != "Qwen2Tokenizer"
                                   or tokenizer.get("processor_class") != entry[1]):
                raise AdapterError("MODEL_INVALID", "Kandinsky tokenizer/processor configuration mismatch")
            if entry[1] == "ByT5Tokenizer":
                continue  # Byte tokenizer has no vocabulary/model weight file.
            if not (folder / "tokenizer.json").is_file() and name.startswith("tokenizer"):
                if entry[1].startswith("T5Tokenizer"):
                    safe_file(root, folder / "spiece.model")
                else:
                    safe_file(root, folder / "vocab.json")
                    safe_file(root, folder / "merges.txt")
            else:
                safe_file(root, folder / "tokenizer.json")
            if name == "processor" or qwen_processor:
                combined = folder / "processor_config.json"
                image_config = config(root, combined).get("image_processor") if combined.exists() else None
                if image_config is None:
                    config(root, folder / "preprocessor_config.json")
                elif not isinstance(image_config, dict) or any(key in image_config for key in ("auto_map", "quantization_config", "custom_pipeline", "trust_remote_code")):
                    raise AdapterError("UNSUPPORTED_MODEL", "Invalid/custom-code nested image processor configuration")
                legacy = folder / "chat_template.json"
                if legacy.exists() or legacy.is_symlink():
                    template = config(root, legacy).get("chat_template")
                    if not isinstance(template, str) or not template.strip() or any((folder / "chat_templates").glob("*.jinja")):
                        raise AdapterError("MODEL_INVALID", "Invalid or conflicting legacy processor chat template")
                else:
                    safe_file(root, folder / "chat_template.jinja")
        else:
            cfg = config(root, folder / "config.json")
            if cfg.get("_class_name", entry[1]) != entry[1]:
                raise AdapterError("MODEL_INVALID", f"Unexpected component class: {name}")
            weights = list(folder.glob("*.safetensors"))
            if not weights:
                raise AdapterError("MODEL_INCOMPLETE", f"Missing safetensors weights: {name}")
            for path in weights:
                safe_file(root, path)
            for path in folder.glob("*.safetensors.index.json"):
                mapping = config(root, path).get("weight_map")
                if not isinstance(mapping, dict) or not mapping:
                    raise AdapterError("MODEL_INVALID", f"Invalid shard index: {name}")
                for shard in set(mapping.values()):
                    if not isinstance(shard, str) or any(c in shard for c in "/\\:\0") or not shard.endswith(".safetensors"):
                        raise AdapterError("MODEL_INVALID", f"Unsafe shard: {name}")
                    safe_file(root, folder / shard)
        for key, expected in spec.get("componentConfigs", {}).get(name, {}).items():
            if key not in cfg or not same_index_value(cfg[key], expected):
                raise AdapterError("MODEL_INVALID", f"Unexpected {name}/{key} for this model variant")
    return root


def same_index_value(actual, expected):
    if isinstance(expected, list):
        return (isinstance(actual, list) and len(actual) == len(expected)
                and all(same_index_value(a, b) for a, b in zip(actual, expected)))
    if type(expected) in (int, float):
        return type(actual) in (int, float) and actual == expected
    return type(actual) is type(expected) and actual == expected


def number(data, key, default, low, high, integer=False):
    value = data.get(key, default)
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high or (integer and type(value) is not int):
        raise AdapterError("INVALID_PARAMETER", f"{key} must be {'an integer' if integer else 'a number'} in [{low}, {high}]")
    return value


def validate(job):
    allowed = {"id", "op", "modelDir", "outputPath", "input", "inputImagePath", "lastFramePath", "drivingAudioPath", "drivingVideoPath", "referenceImagePaths", "loras", "upscaleModelPath"}
    if not isinstance(job, dict) or set(job) - allowed or job.get("op") != "generate" or not isinstance(job.get("id"), str) or not job["id"]:
        raise AdapterError("INVALID_REQUEST", "Expected a native adapter generation request")
    data = job.get("input")
    if not isinstance(data, dict) or set(data) - {"modelId", "prompt", "negativePrompt", "width", "height", "steps", "cfg", "seed", "frames", "fps", "audioFrames", "videoAttention", "wanMemoryTier", "h3Decoder", "h3VideoShift", "nativeModelFormat", "mossSampler", "mossAcceleration", "mossSpectrumFlexWindow", "mossTextPrecision", "mossCompile", "mossWeightPrecision", "mossUpscaleScale"}:
        raise AdapterError("UNSUPPORTED_OPTION", "Unsupported adapter input; no silent option fallback")
    spec = model(data.get("modelId"))
    if "audioFrames" in data and (spec.get("runner") != "musetalk-native"
            or type(data["audioFrames"]) is not int or data["audioFrames"] != data.get("frames")):
        raise AdapterError("INVALID_PARAMETER", "MuseTalk 精确帧数与请求不一致。")
    if "wanMemoryTier" in data and (spec.get("runner") != "wan-a14b-sd" or data["wanMemoryTier"] not in ("balanced", "conservative")):
        raise AdapterError("INVALID_PARAMETER", "未知的 Wan 显存档位。")
    if "nativeModelFormat" in data and (spec.get("localPack") is None
            or data["nativeModelFormat"] not in ("diffusers", spec["localPack"]["format"])):
        raise AdapterError("INVALID_PARAMETER", "Unknown native model format")
    is_video = spec["media"] == "video"
    if "h3Decoder" in data and (spec["family"] != "minimax-h3" or data["h3Decoder"] not in ("dwd", "lightvae", "original")):
        raise AdapterError("UNSUPPORTED_OPTION", "H3 视频解码器选项不适用于此配方。")
    if "h3VideoShift" in data and (spec["family"] != "minimax-h3" or data["h3VideoShift"] != 12
            and not (data["h3VideoShift"] == 6 and data.get("steps") == 4)):
        raise AdapterError("INVALID_PARAMETER", "H3 采样偏移与所选权重不匹配。")
    for kind, key in (("audio", "drivingAudioPath"), ("video", "drivingVideoPath")):
        if spec.get("drivingInput") == kind:
            path = job.get(key)
            if not job.get("inputImagePath") or not isinstance(path, str) or not Path(path).is_absolute():
                raise AdapterError("INVALID_PARAMETER", f"Expected a portrait and a host-owned {kind} file")
            safe_file(Path(path).parent.resolve(), Path(path))
        elif key in job:
            raise AdapterError("UNSUPPORTED_OPTION", f"This model does not take {key}")
    if not is_video and ("videoAttention" in data or "lastFramePath" in job):
        raise AdapterError("UNSUPPORTED_OPTION", "Video settings require a video model")
    if "mossUpscaleScale" in data:
        return load_sibling("moss_upscale").validate(job, spec, load_sibling("adapter_contract"))
    if job.get("upscaleModelPath") is not None:
        raise AdapterError("UNSUPPORTED_OPTION", "Upscaler weights require a pixel-upscale operation")
    loras = job.get("loras", [])
    if not isinstance(loras, list) or len(loras) > 2 or (loras and spec["family"] != "krea2"):
        raise AdapterError("UNSUPPORTED_OPTION", "Only Krea supports style LoRAs (up to two)")
    style_files = []
    for row in loras:
        if (not isinstance(row, dict) or set(row) - {"path", "strength"}
                or not isinstance(row.get("path"), str) or not Path(row["path"]).is_absolute()
                or Path(row["path"]).suffix.lower() != ".safetensors"):
            raise AdapterError("UNSUPPORTED_OPTION", "Expected a host-selected Krea style safetensors file")
        number(row, "strength", 1.0, -2, 2)
        path = Path(row["path"])
        safe_file(path.parent.resolve(), path)
        if any(path.samefile(previous) for previous in style_files):
            raise AdapterError("INVALID_PARAMETER", "The same Krea style file was selected twice")
        style_files.append(path)
    if not isinstance(data.get("prompt"), str) or not data["prompt"].strip() or len(data["prompt"]) > 12000:
        raise AdapterError("INVALID_PARAMETER", "prompt must be nonempty and at most 12000 characters")
    negative = data.get("negativePrompt", "")
    if not isinstance(negative, str) or len(negative) > 8000 or (negative and not spec["negative"]):
        raise AdapterError("UNSUPPORTED_OPTION", "Negative prompt is unsupported or invalid for this model")
    result = dict(data, negativePrompt=negative)
    sampling_defaults = spec
    if spec["family"] == "moss-image":
        sampler = data.get("mossSampler", "euler")
        if sampler != "euler":
            sampling_defaults = spec.get("mossPreview", {})
            if not isinstance(sampler, str) or sampler != sampling_defaults.get("sampler"):
                raise AdapterError("INVALID_PARAMETER", "Unsupported MOSS sampler")
        result["mossSampler"] = sampler
        acceleration = data.get("mossAcceleration", "off")
        if (acceleration not in spec["mossAcceleration"]
                and not (acceleration == "spectrum-adaptive" and spec.get("mossAdaptiveSpectrum") is True)):
            raise AdapterError("INVALID_PARAMETER", "Unsupported MOSS acceleration mode")
        result["mossAcceleration"] = acceleration
        result["mossSpectrumFlexWindow"] = number(data, "mossSpectrumFlexWindow", 0.5, 0, 2)
        precision = data.get("mossTextPrecision", "auto")
        if type(precision) is not str or precision not in ("auto", "bf16", "fp8", "int8"):
            raise AdapterError("INVALID_PARAMETER", "MOSS text precision must be auto, bf16, fp8 or int8")
        result["mossTextPrecision"] = precision
        if type(data.get("mossCompile", False)) is not bool:
            raise AdapterError("INVALID_PARAMETER", "MOSS compilation must be a boolean")
        result["mossCompile"] = data.get("mossCompile", False)
        weight_precision = data.get("mossWeightPrecision", "auto")
        if type(weight_precision) is not str or weight_precision not in ("auto", "fp16", "int8"):
            raise AdapterError("INVALID_PARAMETER", "MOSS weight precision must be auto, fp16 or int8")
        result["mossWeightPrecision"] = weight_precision
    elif any(key in data for key in ("mossSampler", "mossAcceleration", "mossSpectrumFlexWindow", "mossTextPrecision", "mossCompile", "mossWeightPrecision")):
        raise AdapterError("UNSUPPORTED_OPTION", "MOSS settings require a MOSS image model")
    for key in ("width", "height"):
        result[key] = number(data, key, 1024, spec.get("minSize", 512), spec["maxSize"], True)
        if result[key] % spec["alignment"]:
            raise AdapterError("INVALID_PARAMETER", f"{key} must be divisible by {spec['alignment']}")
    default_steps = 2 if data.get("h3Decoder") == "dwd" else sampling_defaults["steps"]
    result["steps"] = number(data, "steps", default_steps, spec.get("minSteps", 1), 100, True)
    result["cfg"] = number(data, "cfg", sampling_defaults["cfg"], 1 if spec.get("cfgConvention") == "standard" else 0, 20)
    result["seed"] = number(data, "seed", 0, 0, 2147483647, True)
    if spec["distilled"] and (result["steps"] not in spec.get("stepOptions", (spec["steps"],)) or result["cfg"] != spec["cfg"]):
        raise AdapterError("INVALID_PARAMETER", "Turbo requires its declared step count and guidance")
    if spec["family"] == "qwen-image" and bool(negative) != (result["cfg"] > 1):
        raise AdapterError("INVALID_PARAMETER", "Qwen negative prompt requires cfg > 1; empty negative requires cfg <= 1")
    if job.get("inputImagePath") is not None:
        supported = "image" in spec["modes"] if is_video else spec["edit"]
        if not supported or not isinstance(job["inputImagePath"], str) or not Path(job["inputImagePath"]).is_absolute():
            raise AdapterError("UNSUPPORTED_OPTION", "This model requires a supported local image input")
        first = Path(job["inputImagePath"])
        safe_file(first.parent.resolve(), first)
    if job.get("lastFramePath") is not None:
        last = job["lastFramePath"]
        if (not job.get("inputImagePath") or "first-last-frame" not in spec["modes"]
                or not isinstance(last, str) or not Path(last).is_absolute()):
            raise AdapterError("UNSUPPORTED_OPTION", "A last frame requires a supported first/last-frame model and first frame")
        safe_file(Path(last).parent.resolve(), Path(last))
    references = job.get("referenceImagePaths", [])
    if spec.get("runner") == "wan-a14b-sd" and not job.get("inputImagePath"):
        raise AdapterError("INVALID_PARAMETER", "Wan A14B 图生视频需要首帧。")
    if spec.get("runner") == "wan-a14b-sd" and result["width"] * result["height"] > 1280 * 720:
        raise AdapterError("INVALID_PARAMETER", "Wan A14B 的 16GB 配方最大支持 720p。")
    if spec.get("runner") == "sd-cpp" and not job.get("inputImagePath"):
        raise AdapterError("INVALID_PARAMETER", "关键帧编辑需要一张底图。")
    if (not isinstance(references, list) or len(references) > 3
            or references and (spec["family"] not in ("qwen-image", "keyframe") or not job.get("inputImagePath"))):
        raise AdapterError("UNSUPPORTED_OPTION", "此模型无法使用所选参考图。多图编辑支持一张底图和最多三张附图。")
    seen = {job.get("inputImagePath")}
    for path in references:
        if (not isinstance(path, str) or not Path(path).is_absolute() or not Path(path).is_file() or path in seen):
            raise AdapterError("INVALID_PARAMETER", "Expected distinct host-owned reference images")
        safe_file(Path(path).parent.resolve(), Path(path))
        seen.add(path)
    suffix = ".mp4" if spec["media"] == "video" else ".png"
    if not isinstance(job.get("outputPath"), str) or not Path(job["outputPath"]).is_absolute() or Path(job["outputPath"]).suffix != suffix:
        raise AdapterError("INVALID_OUTPUT", f"Expected a host-selected absolute {suffix} output")
    if spec["media"] == "video":
        attention = data.get("videoAttention", "auto")
        modes = spec.get("attentionModes", ("auto", "sdpa", "sage", "flash2"))
        if attention not in modes and attention not in spec.get("localPack", {}).get("attentionModes", ()):
            raise AdapterError("INVALID_PARAMETER", "Unknown video attention setting")
        result["videoAttention"] = attention
        result["_videoImage"] = job.get("inputImagePath") is not None
        result["frames"] = number(data, "frames", None, spec["minFrames"], spec["maxFrames"], True)
        if (result["frames"] - spec["frameOffset"]) % spec["frameMultiple"] or data.get("fps") != spec["fps"]:
            raise AdapterError("INVALID_PARAMETER", "Video frame count/rate does not match this model")
        if result["cfg"] != spec["cfg"] or ("audioFrames" not in data and result["frames"] not in spec["durationFrames"].values()):
            raise AdapterError("INVALID_PARAMETER", "Unsupported native video guidance/duration recipe")
        if spec.get("canvases") and [result["width"], result["height"]] not in spec["canvases"].values():
            raise AdapterError("INVALID_PARAMETER", "Resolution does not match the selected video variant")
    elif "frames" in data or "fps" in data:
        raise AdapterError("UNSUPPORTED_OPTION", "Image models do not accept video options")
    return result, spec
