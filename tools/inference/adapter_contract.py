"""Local-only adapter layout and request boundary; no ML imports or model execution."""
from __future__ import annotations

import json
import math
from pathlib import Path
from huiyu_worker_lifecycle import WorkerError


class AdapterError(WorkerError):
    pass


def document(path):
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise AdapterError("MODEL_INCOMPLETE", f"Missing/oversized JSON: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("expected object")
        return data
    except (OSError, ValueError) as exc:
        raise AdapterError("MODEL_INVALID", f"Invalid JSON: {path}: {exc}") from exc


MANIFEST = document(Path(__file__).with_name("adapter-models.json"))


def model(model_id):
    if not isinstance(model_id, str) or model_id not in MANIFEST["models"]:
        raise AdapterError("NATIVE_MODEL_UNSUPPORTED", "Model has no native adapter; no ComfyUI fallback")
    return MANIFEST["models"][model_id]


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
        raise AdapterError("MODEL_INVALID", "modelDir must be a complete absolute local Diffusers directory")
    root = Path(value).resolve()
    index = config(root, root / spec.get("indexFile", "model_index.json"))
    if index.get("_class_name") != spec["pipeline"]:
        raise AdapterError("MODEL_INVALID", f"Expected {spec['pipeline']}; Comfy split files cannot be used")
    if spec["pipeline"] == "Krea2Pipeline" and index.get("is_distilled") is not spec["distilled"]:
        raise AdapterError("MODEL_INVALID", "Krea RAW/Turbo is_distilled does not match selected model")
    if spec["pipeline"] == "QwenImage21Pipeline" and index.get("sample_sigmas") != spec.get("sampleSigmas"):
        raise AdapterError("MODEL_INVALID", "Qwen base/Turbo sample_sigmas does not match selected model")
    if spec["pipeline"] == "WanPipeline" and spec.get("layout") != "WanA14B" and (index.get("expand_timesteps") is not True
            or index.get("boundary_ratio") is not None or index.get("transformer_2", [None, None]) != [None, None]):
        raise AdapterError("MODEL_INVALID", "Expected the single-transformer Wan 2.2 TI2V 5B configuration")
    if spec.get("layout") == "WanA14B" and (index.get("boundary_ratio") != spec["boundaryRatio"] or index.get("expand_timesteps", False) is not False):
        raise AdapterError("MODEL_INVALID", "Expected Wan A14B T2V high/low-noise boundary 0.875")
    modular = spec.get("blocks") is not None
    if modular and index.get("_blocks_class_name") != spec["blocks"]:
        raise AdapterError("MODEL_INVALID", "Expected official MiniMaxH3Blocks modular index")
    for name, types in MANIFEST["layouts"][spec.get("layout", spec["pipeline"])].items():
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
            config(root, folder / "tokenizer_config.json")
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
            if name == "processor":
                combined = folder / "processor_config.json"
                image_config = config(root, combined).get("image_processor") if combined.exists() else None
                if image_config is None:
                    config(root, folder / "preprocessor_config.json")
                elif not isinstance(image_config, dict) or any(key in image_config for key in ("auto_map", "quantization_config", "custom_pipeline", "trust_remote_code")):
                    raise AdapterError("UNSUPPORTED_MODEL", "Invalid/custom-code nested image processor configuration")
                safe_file(root, folder / ("chat_template.json" if modular else "chat_template.jinja"))
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
    return root


def number(data, key, default, low, high, integer=False):
    value = data.get(key, default)
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high or (integer and type(value) is not int):
        raise AdapterError("INVALID_PARAMETER", f"{key} must be {'an integer' if integer else 'a number'} in [{low}, {high}]")
    return value


def validate(job):
    allowed = {"id", "op", "modelDir", "outputPath", "input", "inputImagePath", "referenceImagePaths", "loras"}
    if not isinstance(job, dict) or set(job) - allowed or job.get("op") != "generate" or not isinstance(job.get("id"), str) or not job["id"]:
        raise AdapterError("INVALID_REQUEST", "Expected a native adapter generation request")
    data = job.get("input")
    if not isinstance(data, dict) or set(data) - {"modelId", "prompt", "negativePrompt", "width", "height", "steps", "cfg", "seed", "frames", "fps", "mossAcceleration"}:
        raise AdapterError("UNSUPPORTED_OPTION", "Unsupported adapter input; no silent option fallback")
    spec = model(data.get("modelId"))
    loras = job.get("loras", [])
    if not isinstance(loras, list) or len(loras) > 1 or (loras and spec["family"] != "krea2"):
        raise AdapterError("UNSUPPORTED_OPTION", "Only one Krea style LoRA is supported")
    for row in loras:
        if (not isinstance(row, dict) or set(row) != {"path", "strength"}
                or type(row["strength"]) not in (int, float) or row["strength"] != 1
                or not isinstance(row["path"], str) or not Path(row["path"]).is_absolute()
                or Path(row["path"]).suffix != ".safetensors"):
            raise AdapterError("UNSUPPORTED_OPTION", "Expected a host-selected Krea style safetensors file at strength 1")
        path = Path(row["path"])
        safe_file(path.parent.resolve(), path)
    if not isinstance(data.get("prompt"), str) or not data["prompt"].strip() or len(data["prompt"]) > 12000:
        raise AdapterError("INVALID_PARAMETER", "prompt must be nonempty and at most 12000 characters")
    negative = data.get("negativePrompt", "")
    if not isinstance(negative, str) or len(negative) > 8000 or (negative and not spec["negative"]):
        raise AdapterError("UNSUPPORTED_OPTION", "Negative prompt is unsupported or invalid for this model")
    result = dict(data, negativePrompt=negative)
    if spec["family"] == "moss-image":
        acceleration = data.get("mossAcceleration", "off")
        if type(acceleration) is not str or acceleration not in ("off", "spectrum"):
            raise AdapterError("INVALID_PARAMETER", "MOSS acceleration must be off or spectrum")
        result["mossAcceleration"] = acceleration
    elif "mossAcceleration" in data:
        raise AdapterError("UNSUPPORTED_OPTION", "Only MOSS supports mossAcceleration")
    for key in ("width", "height"):
        result[key] = number(data, key, 1024, spec.get("minSize", 512), spec["maxSize"], True)
        if result[key] % spec["alignment"]:
            raise AdapterError("INVALID_PARAMETER", f"{key} must be divisible by {spec['alignment']}")
    result["steps"] = number(data, "steps", spec["steps"], spec.get("minSteps", 1), 100, True)
    result["cfg"] = number(data, "cfg", spec["cfg"], 0, 20)
    result["seed"] = number(data, "seed", 0, 0, 2147483647, True)
    if spec["distilled"] and (result["steps"] != spec["steps"] or result["cfg"] != spec["cfg"]):
        raise AdapterError("INVALID_PARAMETER", "Turbo requires its declared step count and guidance")
    if spec["family"] == "qwen-image" and bool(negative) != (result["cfg"] > 1):
        raise AdapterError("INVALID_PARAMETER", "Qwen negative prompt requires cfg > 1; empty negative requires cfg <= 1")
    if job.get("inputImagePath") is not None:
        if not spec["edit"] or not isinstance(job["inputImagePath"], str) or not Path(job["inputImagePath"]).is_absolute() or not Path(job["inputImagePath"]).is_file():
            raise AdapterError("UNSUPPORTED_OPTION", "Only Qwen instruction editing is connected")
    references = job.get("referenceImagePaths", [])
    if (not isinstance(references, list) or len(references) > 3
            or references and (spec["family"] != "qwen-image" or not job.get("inputImagePath"))):
        raise AdapterError("UNSUPPORTED_OPTION", "Qwen supports one original and at most three reference images")
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
        result["frames"] = number(data, "frames", None, spec["minFrames"], spec["maxFrames"], True)
        if (result["frames"] - spec["frameOffset"]) % spec["frameMultiple"] or data.get("fps") != spec["fps"]:
            raise AdapterError("INVALID_PARAMETER", "Video frame count/rate does not match this model")
        if result["cfg"] != spec["cfg"] or result["frames"] not in spec["durationFrames"].values():
            raise AdapterError("INVALID_PARAMETER", "Unsupported native video guidance/duration recipe")
        if spec.get("canvases") and [result["width"], result["height"]] not in spec["canvases"].values():
            raise AdapterError("INVALID_PARAMETER", "Resolution does not match the selected video variant")
    elif "frames" in data or "fps" in data:
        raise AdapterError("UNSUPPORTED_OPTION", "Image models do not accept video options")
    return result, spec
