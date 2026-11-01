"""Pixel-only MOSS result copies using the existing fixed FP32 Remacri."""
from pathlib import Path
import time
from huiyu_worker_lifecycle import load_sibling


def validate(job, spec, contract):
    data = job["input"]
    allowed = {"modelId", "prompt", "negativePrompt", "width", "height", "steps", "cfg", "seed", "mossUpscaleScale"}
    if (spec["family"] != "moss-image" or set(data) - allowed
            or job.get("loras") or job.get("referenceImagePaths")):
        raise contract.AdapterError("UNSUPPORTED_OPTION", "MOSS Remacri accepts only one pixel input")
    scale = contract.number(data, "mossUpscaleScale", None, 1.5, 2)
    if scale not in (1.5, 2):
        raise contract.AdapterError("INVALID_PARAMETER", "Remacri scale must be 1.5 or 2")
    result = dict(data)
    for key in ("width", "height"):
        result[key] = contract.number(data, key, None, 1, 3072, True)
        original = result[key] / scale
        if not 512 <= original <= 1536 or original % 16:
            raise contract.AdapterError("INVALID_PARAMETER", "MOSS source dimensions must be 512–1536, aligned to 16")
    for key in ("steps", "cfg"):
        result[key] = contract.number(data, key, 0, 0, 0, key == "steps")
    result["seed"] = contract.number(data, "seed", 0, 0, 2147483647, True)
    if (not isinstance(data.get("prompt"), str) or len(data["prompt"]) > 12000
            or data.get("negativePrompt", "") != ""):
        raise contract.AdapterError("INVALID_PARAMETER", "Invalid source-prompt metadata for pixel upscaling")
    for key in ("inputImagePath", "upscaleModelPath"):
        path = job.get(key)
        if not isinstance(path, str) or not Path(path).is_absolute():
            raise contract.AdapterError("INVALID_PARAMETER", "Expected host-owned image and upscaler paths")
        contract.safe_file(Path(path).parent.resolve(), Path(path))
    if Path(job["upscaleModelPath"]).name != "4x_foolhardy_Remacri.safetensors":
        raise contract.AdapterError("UNSUPPORTED_MODEL", "Only the fixed Remacri safetensors is supported")
    output = job.get("outputPath")
    if not isinstance(output, str) or not Path(output).is_absolute() or Path(output).suffix != ".png":
        raise contract.AdapterError("INVALID_OUTPUT", "Expected a host-selected PNG output")
    return result, spec


def run(job, data, control, error, resident):
    import numpy as np
    import torch
    from PIL import Image
    started = time.perf_counter()
    if not torch.cuda.is_available():
        raise error("DEVICE_UNAVAILABLE", "Remacri requires the configured CUDA device")
    control.stage("preparing_image")
    with load_sibling("adapter_media").input_image(job["inputImagePath"], error) as image:
        source_size = image.size
        if tuple(round(value * data["mossUpscaleScale"]) for value in source_size) != (data["width"], data["height"]):
            raise error("INVALID_IMAGE", "Upscale dimensions do not match the actual source image")
        with image.convert("RGB") as rgb:
            pixels = torch.from_numpy(np.array(rgb, dtype=np.float32) / 255).permute(2, 0, 1).unsqueeze(0)
    if resident is not None and resident.memory is not None:
        # Preserve cached MOSS weights/conditioning when the bounded RRDB pass
        # fits; retire mapped groups only when CUDA headroom is too small.
        if hasattr(resident.memory, "make_room"):
            resident.memory.make_room(4 * 1024**3)
        else:
            resident.memory.offload_all()
    torch.cuda.empty_cache()
    helper = load_sibling("anima_upscale")
    owned = resident is None
    cache = resident.upscale_cache if resident is not None else None
    if cache is None:
        cache = helper.CpuCache(lease=load_sibling("locked_identity").AssetIdentityLease(tree=False))
        if resident is not None:
            resident.upscale_cache = cache
    try:
        control.stage("upscaling")
        pixels, report = helper.run(pixels, job["upscaleModelPath"], "cuda:0", tools=load_sibling,
            expected=None, error=error, cache=cache, check=control.check, progress=control.progress)
        control.stage("saving")
        with load_sibling("anima_refinement").to_pil(pixels) as full:
            with full.resize((data["width"], data["height"]), Image.Resampling.LANCZOS) as output:
                output.save(job["outputPath"], format="PNG")
        control.check()
        return dict(operation="moss-upscale", upscaler="Remacri", device="cuda",
            scale=data["mossUpscaleScale"], sourceWidth=source_size[0], sourceHeight=source_size[1],
            width=data["width"], height=data["height"], upscaleModelSha256=cache.identity[-1],
            elapsedSeconds=time.perf_counter() - started, tileSize=report["tileSize"],
            tileCount=report["tileCount"], weightsCacheHit=report["loading"]["cacheHit"],
            executionRevision=report["executionRevision"], performanceVerified=False)
    except torch.cuda.OutOfMemoryError as exc:
        raise error("NATIVE_OUT_OF_MEMORY", "Remacri 分块放大仍显存不足，原图已保留") from exc
    finally:
        if owned:
            cache.clear()
