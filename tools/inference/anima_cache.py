"""Product cache selection; explicit calibration remains a maintenance option."""
import time


def select(job, data, root, identity, tools, error, *, collect=False, profile=None,
           measure=False, strategy="phase-envelope"):
    # Calibration can enable a controller even when the recipe disables TeaCache.
    # Composition owns the denoiser and has no compatible calibration scope.
    if (data.get("sketchControl") is not None or data.get("regions")) and (
            data["teaCache"] or collect or measure or profile is not None or job.get("teaCacheProfilePath")):
        raise error("UNSUPPORTED_OPTION", "Anima composition does not support TeaCache execution or calibration")
    if not (data["teaCache"] or collect or measure):
        return None, None
    profile_tools = tools("teacache_profile")
    cache_tools = tools("teacache_anima")
    if data.get("teaCacheThresh") == 0 and data["teaCache"] and not collect and profile is None and not job.get("teaCacheProfilePath"):
        return None, dict(schemaVersion=1, runtime=profile_tools.RUNTIME, teaCacheEnabled=False,
                         compatibility=None, selectionReason="threshold-zero", fingerprintSeconds=0)
    if collect and data["teaCache"]:
        raise error("INVALID_INPUT", "Calibration collection requires TeaCache disabled")
    # Everyday generation has the same threshold/policy as the product's Comfy
    # workflow. Old on-disk calibration files cannot silently disable it.
    if data["teaCache"] and profile is None and not job.get("teaCacheProfilePath"):
        threshold = data.get("teaCacheThresh", 0.10)
        controller = cache_tools.TeaCacheController(threshold=threshold, builtin=True)
        report = dict(schemaVersion=1, runtime=profile_tools.RUNTIME, teaCacheEnabled=True,
                      compatibility=None, selectionReason="builtin-anima", fingerprintSeconds=0,
                      algorithm=cache_tools.BUILTIN_ALGORITHM, threshold=threshold)
        return controller, report
    if not (data["teaCache"] or collect):
        return None, dict(schemaVersion=1, runtime=profile_tools.RUNTIME,
                         teaCacheEnabled=False, compatibility=None, fingerprintSeconds=0)
    import torch
    if not torch.cuda.is_available():
        raise error("DEVICE_UNAVAILABLE", "TeaCache requires the selected CUDA inference device")
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    mode = "masked" if job.get("maskImagePath") or data.get("maskPrompt") else ("img2img" if job.get("inputImagePath") else "txt2img")
    started = time.perf_counter()
    try:
        scope = profile_tools.compatibility(root, job.get("loras", []), data, mode, dtype,
            torch.cuda.get_device_name(0), mask_model_dir=job.get("maskModelDir"),
            upscale_model_path=job.get("upscaleModelPath"), identity=identity)
        supplied = profile is not None
        if data["teaCache"] and profile is None:
            profile = profile_tools.read_profile(job["teaCacheProfilePath"], root,
                expected=scope, auto=False)
        threshold = profile_tools.validate_profile(profile, scope, data.get("teaCacheThresh"),
            require_accepted=not supplied) if profile is not None else None
        local = tools("anima_local_cache")
        controller = cache_tools.TeaCacheController(profile, threshold, collect,
            collect_local=strategy == "local-guard", local_tools=local)
        report = dict(schemaVersion=1, runtime=profile_tools.RUNTIME,
            teaCacheEnabled=profile is not None, compatibility=scope,
            selectionReason="matched-profile" if profile is not None else "calibration",
            fingerprintSeconds=time.perf_counter() - started,
            cacheProfile=local.execution_identity(profile) if profile is not None else None,
            collectionMetric=local.METRIC if controller.local_guard else None)
        return controller, report
    except profile_tools.TeaCacheError as exc:
        raise error(exc.code, str(exc)) from exc
