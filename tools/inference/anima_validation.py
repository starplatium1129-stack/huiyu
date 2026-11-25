"""Offline layout and request validation for the local Anima worker.

Stdlib-only: never imports ML libraries or executes model code.
"""
from __future__ import annotations

import json
from pathlib import Path

WEIGHTS = ("text_encoder", "text_conditioner", "transformer", "vae")
COMPONENTS = WEIGHTS + ("tokenizer", "t5_tokenizer", "scheduler")


def read_json(path, error):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("expected object")
        return value
    except (OSError, ValueError) as exc:
        raise error("MODEL_INVALID", f"Invalid or missing {path}: {exc}") from exc


def validate_model(value, error):
    if not isinstance(value, str) or not value:
        raise error("MODEL_INVALID", "modelDir must name a complete local Anima Diffusers directory")
    root = Path(value).expanduser().resolve()
    if not root.is_dir():
        raise error("MODEL_INCOMPLETE", "modelDir must be a complete local Diffusers directory; raw Anima/MiaoMiao split safetensors are not a pipeline. Supply configs, tokenizer assets and all seven components.")
    index = next((root / name for name in ("modular_model_index.json", "model_index.json")
                  if (root / name).is_file()), None)
    if index is None or read_json(index, error).get("_class_name") != "AnimaModularPipeline":
        raise error("MODEL_INVALID", "Expected local AnimaModularPipeline model_index.json or modular_model_index.json")
    for name in COMPONENTS:
        folder = root / name
        if not folder.is_dir():
            raise error("MODEL_INCOMPLETE", f"Missing local component: {folder}")
        if name in WEIGHTS:
            config = read_json(folder / "config.json", error)
            if config.get("quantization_config") or config.get("auto_map"):
                raise error("UNSUPPORTED_MODEL", f"Quantized/custom-code component is unsupported: {name}")
            files = [file for file in folder.glob("*.safetensors") if file.stat().st_size > 0]
            if not files:
                raise error("MODEL_INCOMPLETE", f"Missing safetensors weights: {folder}")
            for shard_index in folder.glob("*.safetensors.index.json"):
                mapping = read_json(shard_index, error).get("weight_map", {})
                if not isinstance(mapping, dict) or not mapping:
                    raise error("MODEL_INVALID", f"Invalid shard index: {shard_index}")
                for shard in set(mapping.values()):
                    if not isinstance(shard, str) or Path(shard).name != shard or not shard.endswith(".safetensors") or not (folder / shard).is_file() or not (folder / shard).stat().st_size:
                        raise error("MODEL_INCOMPLETE", f"Missing/unsafe safetensors shard in {shard_index}: {shard}")
        elif name == "scheduler":
            config = read_json(folder / "scheduler_config.json", error)
            if config.get("_class_name") != "FlowMatchEulerDiscreteScheduler" or config.get("stochastic_sampling"):
                raise error("UNSUPPORTED_MODEL", "Only deterministic FlowMatchEulerDiscreteScheduler (stochastic_sampling=false) is supported")
        else:
            read_json(folder / "tokenizer_config.json", error)
            groups = (("tokenizer.json",), ("vocab.json", "merges.txt")) if name == "tokenizer" else (("spiece.model",), ("tokenizer.json",))
            if not any(all((folder / file).is_file() and (folder / file).stat().st_size > 0 for file in group) for group in groups):
                raise error("MODEL_INCOMPLETE", f"Missing nonempty tokenizer assets in {folder}: {groups}")
    return root


def local_file(value, label, extensions, error):
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise error("INVALID_INPUT", f"{label} must be an absolute host-approved local file")
    path = Path(value).resolve()
    if (extensions is not None and path.suffix.lower() not in extensions) or not path.is_file():
        raise error("INVALID_INPUT", f"Missing or unsupported {label}: {path}")
    return path


def validate_job(job, tools, error):
    def number(data, key, default, low, high, integer=False):
        return tools("anima_composition").number(data, key, default, low, high, integer, error=error)

    if not isinstance(job, dict) or job.get("op") != "generate":
        raise error("INVALID_REQUEST", "Expected one object with op=generate")
    if not isinstance(job.get("id"), str) or not job["id"]:
        raise error("INVALID_REQUEST", "id must be a nonempty string")
    if set(job) - {"id", "op", "modelDir", "outputPath", "input", "inputImagePath", "maskImagePath", "maskModelDir", "loras", "teaCacheProfilePath", "upscaleModelPath", "sketchImagePath", "sketchModelPath"}:
        raise error("UNSUPPORTED_OPTION", "Unknown top-level worker option")
    data = job.get("input")
    if not isinstance(data, dict):
        raise error("INVALID_INPUT", "input must be an object")
    # Accept modelId from older hosts; modelDir alone selects the loaded model.
    supported = {"prompt", "negativePrompt", "width", "height", "steps", "cfg", "seed", "family", "modelId", "sampler", "scheduler", "denoisingStrength", "growMaskBy", "maskPrompt", "maskThreshold", "teaCache", "teaCacheAuto", "teaCacheThresh", "hiresFix", "hiresScale", "hiresDenoise", "hiresSteps", "hiresCfg", "hiresUpscaler", "hiresSampler", "hiresScheduler", "superResModel", "rcasStrength", "sketchControl", "regions"}
    # Empty/disabled UI options are harmless; active options never silently degrade.
    supported.add("hiresOnly")
    disabled = {"teacache", "mask", "maskPath", "loras", "lora", "hires", "rcas", "upscaler", "inputImage", "inputImagePath", "image", "initImage"}
    for key, value in data.items():
        if key in disabled and value in (None, False, "", [], {}):
            continue
        if key not in supported:
            raise error("UNSUPPORTED_OPTION", f"Independent Anima does not support {key}")
    if data.get("family", "anima") != "anima":
        raise error("UNSUPPORTED_MODEL", "Only Anima Diffusers directories are supported")
    if data.get("sampler", "euler") not in ("euler", "res_multistep") or data.get("scheduler", "simple") not in ("simple", "normal", "sgm_uniform"):
        raise error("UNSUPPORTED_SAMPLER", "Use euler/res_multistep with simple/normal/sgm_uniform")
    if not isinstance(data.get("prompt"), str) or not data["prompt"].strip():
        raise error("INVALID_INPUT", "prompt must be a nonempty string")
    if not isinstance(data.get("negativePrompt", ""), str):
        raise error("INVALID_INPUT", "negativePrompt must be a string")
    result = dict(data)
    if type(data.get("teaCache", False)) is not bool:
        raise error("INVALID_INPUT", "teaCache must be a boolean")
    result["teaCache"] = data.get("teaCache", False)
    if type(data.get("teaCacheAuto", False)) is not bool or (data.get("teaCacheAuto") and not result["teaCache"]):
        raise error("INVALID_INPUT", "teaCacheAuto requires teaCache enabled")
    if type(data.get("hiresFix", False)) is not bool:
        raise error("INVALID_INPUT", "hiresFix must be a boolean")
    result["rcasStrength"] = number(data, "rcasStrength", 0, 0, 1)
    if data.get("hiresFix", False):
        result["hiresScale"] = number(data, "hiresScale", 1.5, 1.1, 3)
        result["hiresDenoise"] = number(data, "hiresDenoise", 0.8, 0.1, 1)
        if data.get("hiresSteps") is not None:
            result["hiresSteps"] = number(data, "hiresSteps", 10, 1, 60, True)
        if data.get("hiresCfg") is not None:
            result["hiresCfg"] = number(data, "hiresCfg", 5.5, 0.5, 10)
        if data.get("hiresUpscaler", "Latent") not in ("Latent", "Remacri", "Auto", "4x-UltraSharp"):
            raise error("UNSUPPORTED_OPTION", "Native hires supports Latent, Remacri or 4x-UltraSharp")
        if (data.get("hiresSampler") or data.get("sampler", "euler")) not in ("euler", "res_multistep") or (data.get("hiresScheduler") or data.get("scheduler", "simple")) not in ("simple", "normal", "sgm_uniform"):
            raise error("UNSUPPORTED_SAMPLER", "Unsupported hires sampler/scheduler")
    needs_upscale = bool(data.get("hiresFix") and data.get("superResModel"))
    if data.get("hiresFix") and data.get("hiresUpscaler") in ("Remacri", "4x-UltraSharp") and not needs_upscale:
        raise error("INVALID_INPUT", "Pixel upscaling requires its host-resolved checkpoint")
    if needs_upscale:
        path = local_file(job.get("upscaleModelPath"), "upscaleModelPath", {".safetensors", ".pth"}, error)
        expected = {"Remacri": "4x_foolhardy_Remacri.safetensors", "4x-UltraSharp": "4x-UltraSharp.pth"}.get(data.get("hiresUpscaler"))
        if path.name != expected or data["superResModel"] != path.name:
            raise error("UNSUPPORTED_OPTION", "Upscaler must match its fixed checkpoint")
    elif job.get("upscaleModelPath") is not None:
        raise error("INVALID_INPUT", "upscaleModelPath requires a pixel hires operation")
    if "teaCacheThresh" in data:
        result["teaCacheThresh"] = number(data, "teaCacheThresh", None, 0, 1)
        if not result["teaCache"]:
            raise error("INVALID_INPUT", "teaCacheThresh requires teaCache=true")
    if job.get("teaCacheProfilePath") is not None and not result["teaCache"]:
        raise error("INVALID_INPUT", "teaCacheProfilePath requires teaCache=true")
    for key in ("width", "height"):
        result[key] = number(data, key, 1024, 64, 4096, True)
        if result[key] % 16:
            raise error("INVALID_INPUT", f"{key} must be divisible by 16")
    result["steps"] = number(data, "steps", 28, 1, 200, True)
    result["cfg"] = number(data, "cfg", 4.0, 0.5, 30)
    result["seed"] = number(data, "seed", 0, 0, 2**63 - 1, True)
    image_path = job.get("inputImagePath")
    if image_path is not None:
        local_file(image_path, "inputImagePath", None, error)
        result["denoisingStrength"] = number(data, "denoisingStrength", 0.75, 0, 1)
        if result["denoisingStrength"] == 0:
            raise error("INVALID_INPUT", "denoisingStrength must be greater than zero")
    elif "denoisingStrength" in data:
        raise error("INVALID_INPUT", "denoisingStrength requires inputImagePath")
    mask_path = job.get("maskImagePath")
    auto_mask = data.get("maskPrompt")
    hires_only = data.get("hiresOnly", False)
    if type(hires_only) is not bool or (hires_only and (not needs_upscale or image_path is None
            or mask_path is not None or auto_mask is not None or data.get("sketchControl") or data.get("regions"))):
        raise error("INVALID_INPUT", "Source-only upscale needs one input image and a pixel upscaler")
    if auto_mask is not None:
        try:
            tools("clipseg_mask").phrases(auto_mask)
        except ValueError as exc:
            raise error("INVALID_INPUT", str(exc)) from exc
        if image_path is None or mask_path is not None:
            raise error("INVALID_INPUT", "maskPrompt requires inputImagePath and cannot be combined with maskImagePath")
        try:
            tools("clipseg_mask").validate_model(job.get("maskModelDir"))
        except (OSError, ValueError, TypeError) as exc:
            raise error("MASK_MODEL_INVALID", str(exc)) from exc
        result["maskThreshold"] = number(data, "maskThreshold", 0.45, 0.05, 0.95)
        result["growMaskBy"] = number(data, "growMaskBy", 8, 0, 32, True)
    elif job.get("maskModelDir") is not None or "maskThreshold" in data:
        raise error("INVALID_INPUT", "maskModelDir/maskThreshold requires maskPrompt")
    if mask_path is not None:
        if image_path is None:
            raise error("INVALID_INPUT", "maskImagePath requires inputImagePath")
        local_file(mask_path, "maskImagePath", None, error)
        result["growMaskBy"] = number(data, "growMaskBy", 0, 0, 32, True)
    elif not auto_mask and data.get("growMaskBy", 0) != 0:
        raise error("INVALID_INPUT", "growMaskBy requires maskImagePath or maskPrompt")
    loras = job.get("loras", [])
    if not isinstance(loras, list) or len(loras) > 16:
        raise error("INVALID_INPUT", "loras must contain at most 16 local adapters")
    for adapter in loras:
        if not isinstance(adapter, dict) or set(adapter) != {"path", "strength"}:
            raise error("INVALID_INPUT", "Each trusted LoRA needs only path and strength")
        local_file(adapter["path"], "LoRA path", {".safetensors"}, error)
        number(adapter, "strength", 1, -2, 2)
    output = job.get("outputPath")
    if not isinstance(output, str) or not output or Path(output).suffix.lower() != ".png":
        raise error("INVALID_OUTPUT", "outputPath must be a local .png file")
    return tools("anima_composition").validate(job, result, error)
