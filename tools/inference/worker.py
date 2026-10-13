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
from pathlib import Path
import sys
import time

# Set before any ML imports. Component classes and paths below are explicit.
for _key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
    os.environ[_key] = "1"
os.environ["DO_NOT_TRACK"] = "1"

WEIGHTS = ("text_encoder", "text_conditioner", "transformer", "vae")
COMPONENTS = WEIGHTS + ("tokenizer", "t5_tokenizer", "scheduler")
PINS = {"torch": "2.8.0", "torchvision": "0.23.0", "diffusers": "0.41.0", "transformers": "5.10.1",
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
            if config.get("_class_name") != "FlowMatchEulerDiscreteScheduler" or config.get("stochastic_sampling"):
                raise WorkerError("UNSUPPORTED_MODEL", "Only deterministic FlowMatchEulerDiscreteScheduler (stochastic_sampling=false) is supported")
        else:
            read_json(folder / "tokenizer_config.json")
            required = ("vocab.json", "merges.txt") if name == "tokenizer" else (() if (folder / "spiece.model").is_file() else ("tokenizer.json",))
            if any(not (folder / file).is_file() for file in required):
                raise WorkerError("MODEL_INCOMPLETE", f"Missing tokenizer assets in {folder}: {', '.join(required)}")
    return root


@lru_cache(maxsize=32)
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
    load_mask_tools("anima_cache")
    load_mask_tools("worker_lifecycle")
    load_mask_tools("anima_local_cache")
    load_mask_tools("teacache_profile")
    load_mask_tools("resident_anima")
    load_mask_tools("anima_text_cache")
    load_mask_tools("inference_metrics")
    load_mask_tools("anima_lora")
    load_mask_tools("anima_lora_fusion")
    load_mask_tools("anima_sampling")
    load_mask_tools("anima_refinement")
    load_mask_tools("anima_vae")
    load_mask_tools("anima_tiling")
    load_mask_tools("anima_postprocess")
    load_mask_tools("anima_prompt_weights")
    load_mask_tools("anima_upscale")
    load_mask_tools("native_hash")
    load_mask_tools("native_upload")
    load_mask_tools("anima_loader")
    load_mask_tools("anima_memory").validate()
    load_mask_tools("locked_identity")
    load_mask_tools("anima_acceleration").validate()
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
        from torchvision.transforms.functional import resize
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
    if set(job) - {"id", "op", "modelDir", "outputPath", "input", "inputImagePath", "maskImagePath", "maskModelDir", "loras", "teaCacheProfilePath", "upscaleModelPath"}:
        raise WorkerError("UNSUPPORTED_OPTION", "Unknown top-level worker option")
    data = job.get("input")
    if not isinstance(data, dict):
        raise WorkerError("INVALID_INPUT", "input must be an object")
    supported = {"prompt", "negativePrompt", "width", "height", "steps", "cfg", "seed", "family", "modelId", "sampler", "scheduler", "denoisingStrength", "growMaskBy", "maskPrompt", "maskThreshold", "teaCache", "teaCacheAuto", "teaCacheThresh", "hiresFix", "hiresScale", "hiresDenoise", "hiresUpscaler", "hiresSampler", "hiresScheduler", "superResModel", "rcasStrength"}
    # Empty/disabled UI options are harmless; active options never silently degrade.
    disabled = {"teacache", "mask", "maskPath", "loras", "lora", "hires", "rcas", "upscaler", "inputImage", "inputImagePath", "image", "initImage"}
    for key, value in data.items():
        if key in disabled and value in (None, False, "", [], {}):
            continue
        if key not in supported:
            raise WorkerError("UNSUPPORTED_OPTION", f"Independent Anima does not support {key}")
    if data.get("family", "anima") != "anima":
        raise WorkerError("UNSUPPORTED_MODEL", "Only Anima Diffusers directories are supported")
    if data.get("sampler", "euler") not in ("euler", "res_multistep") or data.get("scheduler", "simple") not in ("simple", "normal", "sgm_uniform"):
        raise WorkerError("UNSUPPORTED_SAMPLER", "Use euler/res_multistep with simple/normal/sgm_uniform")
    if not isinstance(data.get("prompt"), str) or not data["prompt"].strip():
        raise WorkerError("INVALID_INPUT", "prompt must be a nonempty string")
    if not isinstance(data.get("negativePrompt", ""), str):
        raise WorkerError("INVALID_INPUT", "negativePrompt must be a string")
    result = dict(data)
    if type(data.get("teaCache", False)) is not bool:
        raise WorkerError("INVALID_INPUT", "teaCache must be a boolean")
    result["teaCache"] = data.get("teaCache", False)
    if type(data.get("teaCacheAuto", False)) is not bool or (data.get("teaCacheAuto") and not result["teaCache"]):
        raise WorkerError("INVALID_INPUT", "teaCacheAuto requires teaCache enabled")
    if type(data.get("hiresFix", False)) is not bool:
        raise WorkerError("INVALID_INPUT", "hiresFix must be a boolean")
    result["rcasStrength"] = number(data, "rcasStrength", 0, 0, 1)
    if data.get("hiresFix", False):
        result["hiresScale"] = number(data, "hiresScale", 2, 1.1, 3)
        result["hiresDenoise"] = number(data, "hiresDenoise", 0.35, 0.1, 0.7)
        if data.get("hiresUpscaler", "Latent") not in ("Latent", "Remacri", "Auto"):
            raise WorkerError("UNSUPPORTED_OPTION", "Native hires supports Latent or Remacri")
        if (data.get("hiresSampler") or data.get("sampler", "euler")) not in ("euler", "res_multistep") or (data.get("hiresScheduler") or data.get("scheduler", "simple")) not in ("simple", "normal", "sgm_uniform"):
            raise WorkerError("UNSUPPORTED_SAMPLER", "Unsupported hires sampler/scheduler")
    needs_upscale = bool(data.get("hiresFix") and data.get("superResModel"))
    if data.get("hiresFix") and data.get("hiresUpscaler") == "Remacri" and not needs_upscale:
        raise WorkerError("INVALID_INPUT", "Remacri requires its host-resolved checkpoint")
    if needs_upscale:
        path = local_file(job.get("upscaleModelPath"), "upscaleModelPath", {".safetensors"})
        if path.name != "4x_foolhardy_Remacri.safetensors" or data["superResModel"] != path.name:
            raise WorkerError("UNSUPPORTED_OPTION", "Only the fixed Remacri checkpoint is supported")
    elif job.get("upscaleModelPath") is not None:
        raise WorkerError("INVALID_INPUT", "upscaleModelPath requires a Remacri hires operation")
    if "teaCacheThresh" in data:
        result["teaCacheThresh"] = number(data, "teaCacheThresh", None, 0, 1)
        if not result["teaCache"]:
            raise WorkerError("INVALID_INPUT", "teaCacheThresh requires teaCache=true")
    if job.get("teaCacheProfilePath") is not None and not result["teaCache"]:
        raise WorkerError("INVALID_INPUT", "teaCacheProfilePath requires teaCache=true")
    for key in ("width", "height"):
        result[key] = number(data, key, 1024, 64, 4096, True)
        if result[key] % 16:
            raise WorkerError("INVALID_INPUT", f"{key} must be divisible by 16")
    result["steps"] = number(data, "steps", 28, 1, 200, True)
    result["cfg"] = number(data, "cfg", 4.0, 0.5, 30)
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
            if image.mode != "RGB":
                ImageOps.exif_transpose(image, in_place=True)
                return image.convert("RGB")
            oriented = ImageOps.exif_transpose(image)
            # Transposed EXIF needs convert's copy to normalize nested IFD offsets.
            untransposed = image.getexif().get(274) not in range(2, 9)
            return oriented if oriented.mode == "RGB" and untransposed else oriented.convert("RGB")
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise WorkerError("INVALID_INPUT", f"Cannot decode input image: {exc}") from exc


def load_loras(pipeline, adapters):
    if not adapters:
        return
    helper = load_mask_tools("anima_lora")
    try:
        helper.load_loras(pipeline, adapters)
    except helper.UnsupportedLora as exc:
        raise WorkerError("UNSUPPORTED_LORA", str(exc)) from exc


def try_hotswap_loras(pipeline, adapters):
    helper = load_mask_tools("anima_lora")
    try:
        return helper.try_hotswap(pipeline, adapters, upload=load_mask_tools("native_upload").try_packed_upload)
    except helper.UnsupportedLora as exc:
        raise WorkerError("UNSUPPORTED_LORA", str(exc)) from exc


def load_pipeline(root, cfg, blocks=None, reusable=None, stage=None):
    return load_mask_tools("anima_loader").load(validate_model(str(root)), cfg,
        blocks, reusable, load_mask_tools, WorkerError, stage=stage)


def generate(job, stream, *, collect_teacache=False, teacache_profile=None, measure_teacache=False, resident=None, cache_text=True, cache_mask=True, collect_cache_strategy="phase-envelope", control=None):
    job_started = control.started if control is not None else time.perf_counter()
    def stage(name, component=None):
        if control is not None:
            control.stage(name, component=component)
    stage("dependencies")
    data = validate_job(job)
    root = validate_model(job.get("modelDir"))
    identity, resident_fingerprint = None, 0
    if resident is None:
        dependencies()
    else:
        stage("fingerprint")
        identity, resident_fingerprint = resident.prepare_and_fingerprint(
            dependencies, root, job.get("loras", []), load_mask_tools)
    import torch
    if not torch.cuda.is_available():
        raise WorkerError("DEVICE_UNAVAILABLE", "A CUDA-capable PyTorch installation and NVIDIA GPU are required")
    # Device setup is required by inference; initialize before the allocator
    # observation window so the first job has real peaks instead of an error.
    torch.cuda.get_device_properties(0)
    metrics = load_mask_tools("inference_metrics").RuntimeMetrics(torch, job_started)
    metrics.timings["dependencySetupWallSeconds"] = control.initialization_seconds if control is not None else 0.0
    tea, tea_report = load_mask_tools("anima_cache").select(
        job, data, root, identity, load_mask_tools, WorkerError,
        collect=collect_teacache, profile=teacache_profile, measure=measure_teacache,
        strategy=collect_cache_strategy)
    blocks = None
    metrics.begin_memory(tea_report is not None)
    stage("preparing_image")
    mask_started = time.perf_counter()
    image = load_input_image(job["inputImagePath"]) if job.get("inputImagePath") else None
    mask_tools = None
    if job.get("maskImagePath") or data.get("maskPrompt"):
        mask_tools = load_mask_tools()
        try:
            size = (data["width"], data["height"])
            if data.get("maskPrompt"):
                image = mask_tools.resize_image(image, size)
                auto_tools = load_mask_tools("clipseg_mask")
                if resident is not None and cache_mask and resident.mask_cache is None:
                    resident.mask_cache = auto_tools.MaskCache()
                mask = auto_tools.generate_mask(Path(job["maskModelDir"]).resolve(), image, data["maskPrompt"], data["maskThreshold"],
                    grow=data["growMaskBy"],
                    **({"cache": resident.mask_cache} if resident is not None and cache_mask else {}),
                    **({"expected_mask_sha256": tea_report["compatibility"]["maskModelSha256"]}
                       if tea_report is not None and tea_report["compatibility"] is not None else {}))
            else:
                image, mask = mask_tools.prepare_images(image, job["maskImagePath"], size, data["growMaskBy"])
        except ValueError as exc:
            raise WorkerError("INVALID_INPUT", str(exc)) from exc
        blocks = mask_tools.masked_blocks()
    elif image is not None:
        image = load_mask_tools().resize_image(image, (data["width"], data["height"]))
    metrics.image_prepared(mask_started, tea_report, resident, cache_mask, auto_tools.EXECUTION_REVISION if data.get("maskPrompt") else None)
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
    blocks = load_mask_tools("anima_prompt_weights").apply_prompt_weights(blocks,
        cache=resident.text_cache if resident is not None and cache_text else None)
    blocks = load_mask_tools("anima_vae").apply_blocks(blocks, load_mask_tools("anima_tiling"))
    started = time.perf_counter()
    post_load_fingerprint, reused = 0, False
    from functools import partial
    loader = partial(load_pipeline, stage=stage)
    if resident is None:
        pipeline = loader(root, data["cfg"], blocks=blocks)
        stage("adapters")
        load_loras(pipeline, job.get("loras", []))
        if load_mask_tools("anima_acceleration").MODE == "compiled-fused-sage":
            pipeline.transformer._huiyu_lora_fusion.fuse(pipeline.components,
                stage_device="cuda:0" if load_mask_tools("anima_memory").POLICY == "offload" else None)
        memory = load_mask_tools("anima_memory").Residency(pipeline.components)
        memory.bind(pipeline)
    else:
        key = {"root": str(root), **identity}
        stage("adapters")
        pipeline, reused = resident.acquire(key, root, data["cfg"], blocks, job.get("loras", []), loader, load_loras, try_hotswap_loras,
            memory_tools=load_mask_tools("anima_memory"))
        if resident.weights_loaded:
            protected_load = resident.file_identity.cached
            verified_at = time.perf_counter()
            loaded_identity = resident.fingerprint(root, job.get("loras", []), load_mask_tools)
            post_load_fingerprint = time.perf_counter() - verified_at
            resident_fingerprint += post_load_fingerprint
            if loaded_identity != identity or (protected_load and not resident.file_identity.reused):
                resident.clear()
                raise WorkerError("MODEL_CHANGED", "Model or LoRA bytes changed while loading; retry after preparation completes")
    metrics.model_acquired(started, tea_report, reused, resident_fingerprint, post_load_fingerprint, pipeline)
    pipeline.vae._huiyu_vae_events = []
    sampling = load_mask_tools("anima_sampling")
    if data.get("sampler", "euler") != "euler":
        pipeline.update_components(scheduler=sampling.new_scheduler(data["sampler"], dict(pipeline.scheduler.config)))
    if resident is not None and resident.text_cache is not None:
        resident.text_cache.begin_job()
    def upscale(images):
        stage("upscaling")
        helper = load_mask_tools("anima_upscale")
        pipeline._huiyu_memory.offload_all()
        expected = (tea_report.get("compatibility") or {}).get("upscaleModelSha256") if tea_report else None
        result, pipeline._huiyu_upscale_report = helper.run(images, job["upscaleModelPath"], pipeline._execution_device,
            tools=load_mask_tools, expected=expected, error=WorkerError)
        return result
    def prepare_second(blocks):
        stage("encoding")
        if tea is not None:
            if tea.stats["nonfinite"]:
                raise WorkerError("NONFINITE_INFERENCE", "The first pass left the finite calibration scope; no result is published")
            tea.clear()
            return load_mask_tools("teacache_anima").apply_blocks(blocks, tea)
        return blocks
    def before_decode():
        stage("decoding")
        if tea is not None:
            if tea.stats["nonfinite"]:
                raise WorkerError("NONFINITE_INFERENCE", "Denoising left the finite calibration scope; no result is published")
            tea.clear()  # Retain observations, release GPU residuals before VAE.
    capture = tea_report is not None and (collect_teacache or measure_teacache or teacache_profile is not None)
    started = time.perf_counter()
    try:
        stage("encoding")
        result, step, refinement = load_mask_tools("anima_refinement").run(pipeline, data,
            image=image, mask=mask if mask_tools is not None else None, mask_tools=mask_tools,
            sampling=sampling, postprocess=load_mask_tools("anima_postprocess"),
            upscale=upscale if job.get("upscaleModelPath") else None,
            prepare_second_blocks=prepare_second,
            before_decode=before_decode,
            vae_tools=load_mask_tools("anima_vae"), tiling=load_mask_tools("anima_tiling"),
            observe_schedule=(lambda phase, scheduler, count: load_mask_tools("resident_benchmark").capture_schedule(scheduler, count)) if capture and data.get("hiresFix") else None,
            progress=control.progress if control is not None else lambda step, total: emit(stream, job["id"], "progress", step=step, total=total))
    finally:
        if tea is not None:
            tea.clear()
        if resident is None:
            memory.close()
    if tea is not None and tea.stats["nonfinite"]:
        raise WorkerError("NONFINITE_INFERENCE", "Inference left the finite calibration scope; no result is published")
    metrics.pipeline_finished(started, tea_report, tea, resident is not None and cache_text)
    if capture:
        tea_report["schedule"] = ({"schemaVersion": 2, "passes": refinement["schedules"]} if data.get("hiresFix") else
            load_mask_tools("resident_benchmark").capture_schedule(pipeline.scheduler, step))
    metrics.timings.update({key: refinement[key] for key in ("compositeWallSeconds", "postprocessWallSeconds")})
    metrics.refinement = {key: refinement[key] for key in ("vaeOperations", "rcasExecutionRevision") if key in refinement}
    metrics.refinement["upscale"] = getattr(pipeline, "_huiyu_upscale_report", None)
    stage("saving")
    output_report = load_mask_tools().save_png(result, job["outputPath"])
    if tea_report is not None:
        tea_report.update(output_report)
        tea_report["refinement"] = refinement
    emit(stream, job["id"], "result", outputPath=job["outputPath"], modelReused=reused,
         nativeRuntime=metrics.result(output_report, reused, resident, cache_text, cache_mask, tea, tea_report, step,
             memory_policy=pipeline._huiyu_memory.policy, component_reuse=getattr(pipeline, "_huiyu_component_reuse", ())),
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
                    if args.serve:
                        return load_mask_tools("worker_lifecycle").serve(
                            lambda job, control: generate(job, stream, resident=resident, control=control),
                            input_stream=sys.stdin, stream=stream, emit=emit, error=WorkerError,
                            initialize=lambda: resident.prepare(dependencies))
                    line = sys.stdin.readline(2 * 1024 * 1024 + 1)
                    if len(line) > 2 * 1024 * 1024:
                        raise WorkerError("INVALID_REQUEST", "JSONL request exceeds 2 MiB")
                    try:
                        job = json.loads(line)
                    except ValueError as exc:
                        raise WorkerError("INVALID_REQUEST", "Expected a JSONL generation request") from exc
                    job_id = job.get("id") if isinstance(job, dict) else None
                    generate(job, stream)
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
