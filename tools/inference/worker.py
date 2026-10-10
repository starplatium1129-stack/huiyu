"""Local-only Anima generation; --serve reuses weights with fresh per-job state.

No dependency installation, downloads, arbitrary model code, or single-file conversion.
--validate checks local layout/dependency imports, not weight correctness or GPU fit.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.metadata
from functools import lru_cache
import json
import math
import os
import re
from pathlib import Path
import sys
import time

# Set before any ML imports. Component classes and paths below are explicit.
for _key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
    os.environ[_key] = "1"
os.environ["DO_NOT_TRACK"] = "1"

WEIGHTS = ("text_encoder", "text_conditioner", "transformer", "vae")
COMPONENTS = WEIGHTS + ("tokenizer", "t5_tokenizer", "scheduler")
PINS = {"torch": "2.8.0", "diffusers": "0.41.0", "transformers": "5.10.1",
        "accelerate": "1.12.0", "safetensors": "0.8.0", "Pillow": "11.3.0",
        "peft": "0.19.0", "sentencepiece": "0.2.1", "protobuf": "6.33.5",
        "huggingface-hub": "1.32.0"}


class WorkerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def emit(stream, job_id, event, **values):
    stream.write(json.dumps({"id": job_id, "event": event, **values}, ensure_ascii=False) + "\n")
    stream.flush()


def read_json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("expected object")
        return value
    except (OSError, ValueError) as exc:
        raise WorkerError("MODEL_INVALID", f"Invalid or missing {path}: {exc}") from exc


def validate_model(value):
    if not isinstance(value, str) or not value:
        raise WorkerError("MODEL_INVALID", "modelDir must name a complete local Anima Diffusers directory")
    root = Path(value).expanduser().resolve()
    if not root.is_dir():
        raise WorkerError("MODEL_INCOMPLETE", "modelDir must be a complete local Diffusers directory; raw Anima/MiaoMiao split safetensors are not a pipeline. Supply configs, tokenizer assets and all seven components.")
    index = next((root / name for name in ("modular_model_index.json", "model_index.json")
                  if (root / name).is_file()), None)
    if index is None or read_json(index).get("_class_name") != "AnimaModularPipeline":
        raise WorkerError("MODEL_INVALID", "Expected local AnimaModularPipeline model_index.json or modular_model_index.json")
    for name in COMPONENTS:
        folder = root / name
        if not folder.is_dir():
            raise WorkerError("MODEL_INCOMPLETE", f"Missing local component: {folder}")
        if name in WEIGHTS:
            config = read_json(folder / "config.json")
            if config.get("quantization_config") or config.get("auto_map"):
                raise WorkerError("UNSUPPORTED_MODEL", f"Quantized/custom-code component is unsupported: {name}")
            files = list(folder.glob("*.safetensors"))
            if not files:
                raise WorkerError("MODEL_INCOMPLETE", f"Missing safetensors weights: {folder}")
            for shard_index in folder.glob("*.safetensors.index.json"):
                mapping = read_json(shard_index).get("weight_map", {})
                if not isinstance(mapping, dict) or not mapping:
                    raise WorkerError("MODEL_INVALID", f"Invalid shard index: {shard_index}")
                for shard in set(mapping.values()):
                    if not isinstance(shard, str) or Path(shard).name != shard or not shard.endswith(".safetensors") or not (folder / shard).is_file():
                        raise WorkerError("MODEL_INCOMPLETE", f"Missing/unsafe safetensors shard in {shard_index}: {shard}")
        elif name == "scheduler":
            config = read_json(folder / "scheduler_config.json")
            if config.get("_class_name") != "FlowMatchEulerDiscreteScheduler":
                raise WorkerError("UNSUPPORTED_MODEL", "Only FlowMatchEulerDiscreteScheduler is supported")
        else:
            read_json(folder / "tokenizer_config.json")
            required = ("vocab.json", "merges.txt") if name == "tokenizer" else (() if (folder / "spiece.model").is_file() else ("tokenizer.json",))
            if any(not (folder / file).is_file() for file in required):
                raise WorkerError("MODEL_INCOMPLETE", f"Missing tokenizer assets in {folder}: {', '.join(required)}")
    return root


@lru_cache(maxsize=16)
def load_mask_tools(name="masked_anima"):
    # -I excludes the script directory: load only this bundled sibling, never PYTHONPATH.
    import importlib.util
    try:
        spec = importlib.util.spec_from_file_location(f"huiyu_{name}", Path(__file__).with_name(f"{name}.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except (OSError, ImportError, AttributeError) as exc:
        raise WorkerError("RUNTIME_INCOMPLETE", f"Cannot load bundled {name}.py: {exc}") from exc


def dependencies():
    # A diagnostic/first-job check reads the bundled code afresh. A resident
    # worker freezes those modules after successful initialization.
    load_mask_tools.cache_clear()
    load_mask_tools()
    load_mask_tools("clipseg_mask")
    load_mask_tools("teacache_anima")
    load_mask_tools("teacache_profile")
    load_mask_tools("resident_anima")
    load_mask_tools("anima_text_cache")
    load_mask_tools("inference_metrics")
    versions = {}
    for name, expected in PINS.items():
        try:
            version = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError as exc:
            raise WorkerError("DEPENDENCY_MISSING", f"Missing {name}; prepare the dedicated environment with requirements.txt") from exc
        if version.split("+")[0] != expected:
            raise WorkerError("DEPENDENCY_VERSION", f"{name}=={expected} required; found {version}")
        versions[name] = version
    try:
        import torch
        from diffusers import AnimaModularPipeline, AnimaTextConditioner, AutoencoderKLQwenImage, CosmosTransformer3DModel, FlowMatchEulerDiscreteScheduler, ClassifierFreeGuidance
        from transformers import Qwen3Model, Qwen2Tokenizer, T5Tokenizer, T5TokenizerFast, CLIPSegForImageSegmentation, CLIPTokenizer, ViTImageProcessorPil
        from PIL import Image, ImageOps
        from peft import LoraConfig, get_peft_model_state_dict
        from safetensors import safe_open
    except Exception as exc:
        raise WorkerError("DEPENDENCY_IMPORT", f"Inference dependency import failed: {exc}") from exc
    return versions


def number(data, key, default, low, high, integer=False):
    value = data.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high or (integer and not isinstance(value, int)):
        raise WorkerError("INVALID_INPUT", f"{key} must be {'an integer' if integer else 'a number'} in [{low}, {high}]")
    return value


def validate_job(job):
    if not isinstance(job, dict) or job.get("op") != "generate":
        raise WorkerError("INVALID_REQUEST", "Expected one object with op=generate")
    if not isinstance(job.get("id"), str) or not job["id"]:
        raise WorkerError("INVALID_REQUEST", "id must be a nonempty string")
    if set(job) - {"id", "op", "modelDir", "outputPath", "input", "inputImagePath", "maskImagePath", "maskModelDir", "loras", "teaCacheProfilePath"}:
        raise WorkerError("UNSUPPORTED_OPTION", "Unknown top-level worker option")
    data = job.get("input")
    if not isinstance(data, dict):
        raise WorkerError("INVALID_INPUT", "input must be an object")
    supported = {"prompt", "negativePrompt", "width", "height", "steps", "cfg", "seed", "family", "modelId", "sampler", "scheduler", "denoisingStrength", "growMaskBy", "maskPrompt", "maskThreshold", "teaCache", "teaCacheThresh"}
    # Empty/disabled UI options are harmless; active options never silently degrade.
    disabled = {"teacache", "mask", "maskPath", "loras", "lora", "hires", "rcas", "upscaler", "inputImage", "inputImagePath", "image", "initImage"}
    for key, value in data.items():
        if key in disabled and value in (None, False, "", [], {}):
            continue
        if key not in supported:
            raise WorkerError("UNSUPPORTED_OPTION", f"Independent Anima does not support {key}")
    if data.get("family", "anima") != "anima":
        raise WorkerError("UNSUPPORTED_MODEL", "Only Anima Diffusers directories are supported")
    if data.get("sampler", "euler") != "euler" or data.get("scheduler", "simple") != "simple":
        raise WorkerError("UNSUPPORTED_SAMPLER", "Use euler/simple: native Diffusers FlowMatch Euler schedule; res_multistep and ComfyUI schedule equivalence are unsupported")
    if not isinstance(data.get("prompt"), str) or not data["prompt"].strip():
        raise WorkerError("INVALID_INPUT", "prompt must be a nonempty string")
    if not isinstance(data.get("negativePrompt", ""), str):
        raise WorkerError("INVALID_INPUT", "negativePrompt must be a string")
    result = dict(data)
    if type(data.get("teaCache", False)) is not bool:
        raise WorkerError("INVALID_INPUT", "teaCache must be a boolean")
    result["teaCache"] = data.get("teaCache", False)
    if "teaCacheThresh" in data:
        result["teaCacheThresh"] = number(data, "teaCacheThresh", None, 0.01, 1)
        if not result["teaCache"]:
            raise WorkerError("INVALID_INPUT", "teaCacheThresh requires teaCache=true")
    if job.get("teaCacheProfilePath") is not None and not result["teaCache"]:
        raise WorkerError("INVALID_INPUT", "teaCacheProfilePath requires teaCache=true")
    for key in ("width", "height"):
        result[key] = number(data, key, 1024, 64, 4096, True)
        if result[key] % 16:
            raise WorkerError("INVALID_INPUT", f"{key} must be divisible by 16")
    result["steps"] = number(data, "steps", 28, 1, 200, True)
    result["cfg"] = number(data, "cfg", 4.0, 1, 30)
    result["seed"] = number(data, "seed", 0, 0, 2**63 - 1, True)
    image_path = job.get("inputImagePath")
    if image_path is not None:
        local_file(image_path, "inputImagePath", None)
        result["denoisingStrength"] = number(data, "denoisingStrength", 0.75, 0, 1)
        if result["denoisingStrength"] == 0:
            raise WorkerError("INVALID_INPUT", "denoisingStrength must be greater than zero")
    elif "denoisingStrength" in data:
        raise WorkerError("INVALID_INPUT", "denoisingStrength requires inputImagePath")
    mask_path = job.get("maskImagePath")
    auto_mask = data.get("maskPrompt")
    if auto_mask is not None:
        try:
            load_mask_tools("clipseg_mask").phrases(auto_mask)
        except ValueError as exc:
            raise WorkerError("INVALID_INPUT", str(exc)) from exc
        if image_path is None or mask_path is not None:
            raise WorkerError("INVALID_INPUT", "maskPrompt requires inputImagePath and cannot be combined with maskImagePath")
        try:
            load_mask_tools("clipseg_mask").validate_model(job.get("maskModelDir"))
        except (OSError, ValueError, TypeError) as exc:
            raise WorkerError("MASK_MODEL_INVALID", str(exc)) from exc
        result["maskThreshold"] = number(data, "maskThreshold", 0.45, 0.05, 0.95)
        result["growMaskBy"] = number(data, "growMaskBy", 8, 0, 32, True)
    elif job.get("maskModelDir") is not None or "maskThreshold" in data:
        raise WorkerError("INVALID_INPUT", "maskModelDir/maskThreshold requires maskPrompt")
    if mask_path is not None:
        if image_path is None:
            raise WorkerError("INVALID_INPUT", "maskImagePath requires inputImagePath")
        local_file(mask_path, "maskImagePath", None)
        result["growMaskBy"] = number(data, "growMaskBy", 0, 0, 32, True)
    elif not auto_mask and data.get("growMaskBy", 0) != 0:
        raise WorkerError("INVALID_INPUT", "growMaskBy requires maskImagePath or maskPrompt")
    loras = job.get("loras", [])
    if not isinstance(loras, list) or len(loras) > 16:
        raise WorkerError("INVALID_INPUT", "loras must contain at most 16 local adapters")
    for adapter in loras:
        if not isinstance(adapter, dict) or set(adapter) != {"path", "strength"}:
            raise WorkerError("INVALID_INPUT", "Each trusted LoRA needs only path and strength")
        local_file(adapter["path"], "LoRA path", {".safetensors"})
        number(adapter, "strength", 1, -2, 2)
    output = job.get("outputPath")
    if not isinstance(output, str) or not output or Path(output).suffix.lower() != ".png":
        raise WorkerError("INVALID_OUTPUT", "outputPath must be a local .png file")
    return result


def local_file(value, label, extensions):
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise WorkerError("INVALID_INPUT", f"{label} must be an absolute host-approved local file")
    path = Path(value).resolve()
    if (extensions is not None and path.suffix.lower() not in extensions) or not path.is_file():
        raise WorkerError("INVALID_INPUT", f"Missing or unsupported {label}: {path}")
    return path


def load_input_image(path):
    from PIL import Image, ImageOps
    try:
        with Image.open(path) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise WorkerError("INVALID_INPUT", "Input image must be PNG, JPEG or WebP")
            if image.width * image.height > 4096 * 4096 or getattr(image, "n_frames", 1) != 1:
                raise WorkerError("INVALID_INPUT", "Input must be one still image of at most 16 megapixels")
            return ImageOps.exif_transpose(image).convert("RGB")
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise WorkerError("INVALID_INPUT", f"Cannot decode input image: {exc}") from exc


def load_loras(pipeline, adapters):
    if not adapters:
        return
    from safetensors import safe_open
    from peft import get_peft_model_state_dict, LoraConfig
    from dataclasses import fields
    config_fields = {field.name for field in fields(LoraConfig)}
    names, scales = [], []
    for index, adapter in enumerate(adapters):
        path = Path(adapter["path"])
        name = f"huiyu_{index}"
        # Inspect before upstream can silently discard DoRA or unknown component keys.
        with safe_open(str(path), framework="pt", device="cpu") as file:
            keys = set(file.keys())
            metadata = file.metadata() or {}
        if any(key.startswith("diffusion_model.") for key in keys):
            from diffusers.loaders.lora_conversion_utils import _convert_non_diffusers_anima_lora_to_diffusers
            # This pinned upstream helper only renames Anima keys; inspect without loading tensors.
            converted = _convert_non_diffusers_anima_lora_to_diffusers(dict.fromkeys(keys))
            if len(converted) != len(keys):
                raise WorkerError("UNSUPPORTED_LORA", "Anima LoRA conversion contains colliding target keys")
            keys = set(converted)
        targets = {}
        for key in keys:
            match = re.fullmatch(r"(transformer|text_conditioner)\.(.+)\.lora_([AB])\.weight", key)
            if not match:
                raise WorkerError("UNSUPPORTED_LORA", f"Expected native or diffusion_model-prefixed Anima LoRA A/B weights; unsupported key: {key}")
            component, target, side = match.groups()
            other = f"{component}.{target}.lora_{'B' if side == 'A' else 'A'}.weight"
            if other not in keys:
                raise WorkerError("UNSUPPORTED_LORA", f"Unpaired LoRA weight: {key}")
            try:
                getattr(pipeline, component).get_submodule(target)
            except (AttributeError, KeyError) as exc:
                raise WorkerError("UNSUPPORTED_LORA", f"Unknown Anima LoRA target: {component}.{target}") from exc
            targets.setdefault(component, set()).add(key.removeprefix(component + "."))
        if not targets:
            raise WorkerError("UNSUPPORTED_LORA", "LoRA contains no supported weights")
        if "lora_adapter_metadata" in metadata:
            try:
                config = json.loads(metadata["lora_adapter_metadata"])
            except (ValueError, TypeError) as exc:
                raise WorkerError("UNSUPPORTED_LORA", "Malformed LoRA adapter metadata") from exc
            if not isinstance(config, dict):
                raise WorkerError("UNSUPPORTED_LORA", "LoRA adapter metadata must be an object")
            for key, value in config.items():
                component, _, field = key.partition(".")
                if component not in targets or field not in config_fields:
                    raise WorkerError("UNSUPPORTED_LORA", f"Unsupported LoRA metadata: {key}")
                if field in {"use_dora", "modules_to_save", "target_parameters", "layer_replication", "trainable_token_indices", "alora_invocation_tokens", "lora_bias"} and value:
                    raise WorkerError("UNSUPPORTED_LORA", f"Unsupported LoRA option: {key}")
                if field == "bias" and value != "none":
                    raise WorkerError("UNSUPPORTED_LORA", "LoRA bias weights are unsupported")
        pipeline.load_lora_weights(str(path.parent), weight_name=path.name, adapter_name=name,
                                   local_files_only=True, use_safetensors=True)
        # Upstream warns on unhandled keys. Fail instead of silently generating a partial adapter.
        for component, expected in targets.items():
            actual = set(get_peft_model_state_dict(getattr(pipeline, component), adapter_name=name, save_embedding_layers=False))
            if actual != expected:
                raise WorkerError("UNSUPPORTED_LORA", f"Loaded {component} adapter keys do not match the checkpoint")
        names.append(name)
        scales.append(adapter["strength"])
    pipeline.set_adapters(names, adapter_weights=scales)
    # PEFT injection adds training-mode children after the base model was evaluated.
    # https://github.com/huggingface/peft/blob/v0.19.0/src/peft/tuners/lora/layer.py#L189-L198
    pipeline.transformer.eval()
    pipeline.text_conditioner.eval()


def load_pipeline(root, cfg, blocks=None):
    import torch
    from diffusers import AnimaModularPipeline, AnimaTextConditioner, AutoencoderKLQwenImage, CosmosTransformer3DModel, FlowMatchEulerDiscreteScheduler, ClassifierFreeGuidance
    from transformers import Qwen3Model, Qwen2Tokenizer, T5Tokenizer, T5TokenizerFast
    if not torch.cuda.is_available():
        raise WorkerError("DEVICE_UNAVAILABLE", "A CUDA-capable PyTorch installation and NVIDIA GPU are required; no CPU fallback is attempted")
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    pipeline = AnimaModularPipeline(blocks=blocks) if blocks is not None else AnimaModularPipeline()
    classes = {"text_encoder": Qwen3Model, "text_conditioner": AnimaTextConditioner,
               "transformer": CosmosTransformer3DModel, "vae": AutoencoderKLQwenImage,
               "tokenizer": Qwen2Tokenizer, "t5_tokenizer": (T5Tokenizer if (root / "t5_tokenizer" / "spiece.model").is_file() else T5TokenizerFast),
               "scheduler": FlowMatchEulerDiscreteScheduler}
    components = {}
    for name, cls in classes.items():
        kwargs = {"local_files_only": True}
        if name in WEIGHTS:
            kwargs.update(use_safetensors=True, torch_dtype=dtype)
        if name in ("text_encoder", "tokenizer", "t5_tokenizer"):
            kwargs["trust_remote_code"] = False
        components[name] = cls.from_pretrained(str(root / name), **kwargs)
    # CFG is a component, not an ignored call-time guidance_scale argument.
    components["guider"] = ClassifierFreeGuidance(guidance_scale=cfg)
    pipeline.update_components(**components)
    pipeline.to("cuda")
    pipeline.set_progress_bar_config(disable=True)
    return pipeline


def generate(job, stream, *, collect_teacache=False, teacache_profile=None, measure_teacache=False, resident=None, cache_text=True, cache_mask=True):
    job_started = time.perf_counter()
    data = validate_job(job)
    root = validate_model(job.get("modelDir"))
    if resident is None:
        dependencies()
    else:
        resident.prepare(dependencies)
    import torch
    metrics = load_mask_tools("inference_metrics").RuntimeMetrics(torch, job_started)
    tea, tea_report, blocks = None, None, None
    identity_started = time.perf_counter()
    identity = load_mask_tools("teacache_profile").model_identity(root, job.get("loras", [])) if resident is not None else None
    resident_fingerprint = time.perf_counter() - identity_started if resident is not None else 0
    if data["teaCache"] or collect_teacache:
        profile_tools = load_mask_tools("teacache_profile")
        if collect_teacache and data["teaCache"]:
            raise WorkerError("INVALID_INPUT", "Calibration collection requires TeaCache disabled")
        try:
            profile = (teacache_profile if teacache_profile is not None else
                profile_tools.read_profile(job.get("teaCacheProfilePath"), root)) if data["teaCache"] else None
            if not torch.cuda.is_available():
                raise WorkerError("DEVICE_UNAVAILABLE", "TeaCache requires the selected CUDA inference device")
            dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
            mode = "masked" if job.get("maskImagePath") or data.get("maskPrompt") else ("img2img" if job.get("inputImagePath") else "txt2img")
            started = time.perf_counter()
            scope = profile_tools.compatibility(root, job.get("loras", []), data, mode, dtype, torch.cuda.get_device_name(0),
                mask_model_dir=job.get("maskModelDir"), identity=identity)
            tea_report = dict(schemaVersion=1, runtime=profile_tools.RUNTIME, teaCacheEnabled=data["teaCache"], compatibility=scope,
                fingerprintSeconds=time.perf_counter() - started)
            threshold = profile_tools.validate_profile(profile, scope, data.get("teaCacheThresh"),
                require_accepted=teacache_profile is None) if profile is not None else None
            tea = load_mask_tools("teacache_anima").TeaCacheController(profile, threshold, collect_teacache)
        except profile_tools.TeaCacheError as exc:
            raise WorkerError(exc.code, str(exc)) from exc
    elif measure_teacache:
        tea_report = dict(schemaVersion=1, runtime=load_mask_tools("teacache_profile").RUNTIME, teaCacheEnabled=False, compatibility=None, fingerprintSeconds=0)
    metrics.begin_memory(tea_report is not None)
    mask_started = time.perf_counter()
    image = load_input_image(job["inputImagePath"]) if job.get("inputImagePath") else None
    mask_tools = None
    if job.get("maskImagePath") or data.get("maskPrompt"):
        mask_tools = load_mask_tools()
        try:
            size = (data["width"], data["height"])
            if data.get("maskPrompt"):
                from PIL import Image
                image = image.resize(size, Image.Resampling.LANCZOS)
                auto_tools = load_mask_tools("clipseg_mask")
                if resident is not None and cache_mask and resident.mask_cache is None:
                    resident.mask_cache = auto_tools.MaskCache()
                mask = auto_tools.generate_mask(Path(job["maskModelDir"]).resolve(), image, data["maskPrompt"], data["maskThreshold"],
                    **({"cache": resident.mask_cache} if resident is not None and cache_mask else {}),
                    **({"expected_mask_sha256": tea_report["compatibility"]["maskModelSha256"]}
                       if tea_report is not None and tea_report["compatibility"] is not None else {}))
                image, mask = mask_tools.prepare_mask(image, mask, size, data["growMaskBy"])
            else:
                image, mask = mask_tools.prepare_images(image, job["maskImagePath"], size, data["growMaskBy"])
        except ValueError as exc:
            raise WorkerError("INVALID_INPUT", str(exc)) from exc
        blocks = mask_tools.masked_blocks()
    metrics.image_prepared(mask_started, tea_report, resident, cache_mask, bool(data.get("maskPrompt")))
    if blocks is None and (tea is not None or (resident is not None and cache_text)):
        from diffusers.modular_pipelines.anima.modular_blocks_anima import AnimaAutoBlocks
        blocks = AnimaAutoBlocks()
    if tea is not None:
        blocks = load_mask_tools("teacache_anima").apply_blocks(blocks, tea)
    if resident is not None and cache_text:
        text_tools = load_mask_tools("anima_text_cache")
        if resident.text_cache is None:
            resident.text_cache = text_tools.TextCache()
        blocks = text_tools.apply_text_cache(blocks, resident.text_cache)
    started = time.perf_counter()
    post_load_fingerprint, reused = 0, False
    if resident is None:
        pipeline = load_pipeline(root, data["cfg"], blocks=blocks) if blocks is not None else load_pipeline(root, data["cfg"])
        load_loras(pipeline, job.get("loras", []))
    else:
        key = {"root": str(root), **identity}
        pipeline, reused = resident.acquire(key, root, data["cfg"], blocks, job.get("loras", []), load_pipeline, load_loras)
        if resident.weights_loaded:
            verified_at = time.perf_counter()
            loaded_identity = load_mask_tools("teacache_profile").model_identity(root, job.get("loras", []))
            post_load_fingerprint = time.perf_counter() - verified_at
            resident_fingerprint += post_load_fingerprint
            if loaded_identity != identity:
                resident.clear()
                raise WorkerError("MODEL_CHANGED", "Model or LoRA bytes changed while loading; retry after preparation completes")
    metrics.model_acquired(started, tea_report, reused, resident_fingerprint, post_load_fingerprint)
    if resident is not None and resident.text_cache is not None:
        resident.text_cache.begin_job()
    total = data["steps"] - int(data["steps"] - data["steps"] * data["denoisingStrength"]) if image is not None else data["steps"]
    step = 0
    original_step = pipeline.scheduler.step

    def report_step(*args, **kwargs):
        nonlocal step
        value = original_step(*args, **kwargs)
        step += 1
        emit(stream, job["id"], "progress", step=step, total=total)
        return value

    pipeline.scheduler.step = report_step
    image_kwargs = {"image": image, "strength": data["denoisingStrength"]} if image is not None else {}
    if mask_tools is not None:
        image_kwargs["mask_image"] = mask
    started = time.perf_counter()
    try:
        images = pipeline(prompt=data["prompt"], negative_prompt=data.get("negativePrompt", ""),
                          width=data["width"], height=data["height"], num_inference_steps=data["steps"],
                          generator=torch.Generator(device="cuda").manual_seed(data["seed"]),
                          output_type="pil", output="images", **image_kwargs)
    finally:
        pipeline.scheduler.step = original_step
        if tea is not None:
            tea.clear()
    metrics.pipeline_finished(started, tea_report, tea, resident is not None and cache_text)
    if tea_report is not None and (collect_teacache or measure_teacache or teacache_profile is not None):
        tea_report["schedule"] = load_mask_tools("resident_benchmark").capture_schedule(pipeline.scheduler, step)
    if not images or len(images) != 1:
        raise WorkerError("GENERATION_FAILED", "Pipeline returned no single image")
    started = time.perf_counter()
    if mask_tools is not None:
        images[0] = mask_tools.composite(images[0], image, mask)
    metrics.timings["compositeWallSeconds"] = time.perf_counter() - started
    output_report = load_mask_tools().save_png(images[0], job["outputPath"])
    if tea_report is not None:
        tea_report.update(output_report)
    emit(stream, job["id"], "result", outputPath=job["outputPath"], modelReused=reused,
         nativeRuntime=metrics.result(output_report, reused, resident, cache_text, cache_mask, tea, tea_report, step),
         **({"textCache": resident.text_cache.stats()} if resident is not None and cache_text else {}),
         **({"teaCache": dict(tea.stats)} if tea is not None else {}))
    return tea_report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--validate", metavar="MODEL_DIR")
    mode.add_argument("--diagnose", action="store_true")
    mode.add_argument("--serve", action="store_true", help="Serial JSONL jobs; reuse one exact model/LoRA weight set")
    args = parser.parse_args(argv)
    stream = sys.stdout
    job_id = None
    try:
        # Libraries may print diagnostics. Keep all nonprotocol output on stderr.
        with contextlib.redirect_stdout(sys.stderr):
            if args.diagnose:
                versions = dependencies()
                import torch
                available = torch.cuda.is_available()
                emit(stream, None, "diagnostic", valid=True, dependencies=versions,
                     cudaAvailable=available, deviceName=torch.cuda.get_device_name(0) if available else None,
                     scope="imports-and-device-only; no weights loaded or generation tested")
            elif args.validate:
                root = validate_model(args.validate)
                versions = dependencies()
                emit(stream, None, "validation", valid=True, modelDir=str(root), dependencies=versions,
                     scope="layout-and-imports-only; weights and GPU generation not tested")
            else:
                resident = load_mask_tools("resident_anima").PipelineCache() if args.serve else None
                try:
                    while True:
                        line = sys.stdin.readline(2 * 1024 * 1024 + 1)
                        if not line and args.serve:
                            break
                        if len(line) > 2 * 1024 * 1024:
                            raise WorkerError("INVALID_REQUEST", "JSONL request exceeds 2 MiB")
                        try:
                            job = json.loads(line)
                        except ValueError as exc:
                            raise WorkerError("INVALID_REQUEST", "Expected a JSONL generation request") from exc
                        job_id = job.get("id") if isinstance(job, dict) else None
                        generate(job, stream, resident=resident)
                        if not args.serve:
                            break
                        emit(stream, job_id, "ready")
                finally:
                    if resident is not None:
                        resident.clear()
        return 0
    except Exception as exc:
        code = exc.code if isinstance(exc, WorkerError) else "GENERATION_FAILED"
        emit(stream, job_id, "error", code=code, message=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
