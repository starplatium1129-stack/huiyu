"""Native image and video inference from local model assets.

Run in the separate requirements-adapters.txt environment. This worker never
installs dependencies, downloads weights, executes repository-provided custom code or invokes ComfyUI.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

for _key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"):
    os.environ[_key] = "1"


# -I omits the script directory. Bootstrap only this fixed owner; all other
# bundled imports go through its same-file module cache, including nested manga.
_lifecycle_path = Path(__file__).with_name("worker_lifecycle.py").resolve()
lifecycle = sys.modules.get("huiyu_worker_lifecycle")
if lifecycle is None:
    _spec = importlib.util.spec_from_file_location("huiyu_worker_lifecycle", _lifecycle_path)
    lifecycle = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = lifecycle
    try:
        _spec.loader.exec_module(lifecycle)
    except BaseException:
        sys.modules.pop(_spec.name, None)
        raise
elif Path(getattr(lifecycle, "__file__", "")).resolve() != _lifecycle_path:
    raise ImportError("Bundled worker lifecycle belongs to another runtime")
sibling = lifecycle.load_sibling


contract = sibling("adapter_contract")
media = sibling("adapter_media")
video = sibling("adapter_video")
_identity = sibling("adapter_identity")
_loading = sibling("adapter_loading")
Error = contract.AdapterError

MODEL_SUFFIXES = _identity.MODEL_SUFFIXES
runtime_dependencies = _identity.runtime_dependencies
pipeline_dependencies = _identity.pipeline_dependencies
dependencies = _identity.dependencies
fingerprint = _identity.fingerprint
converted_identity = _identity.converted_identity
imported_weight_digest = _identity.imported_weight_digest
model_identity = _identity.model_identity
windows_weight_reads = _loading.windows_weight_reads
resolve_moss_text_precision = _loading.resolve_moss_text_precision
prepare_moss_start = _loading.prepare_moss_start
prepare_job = _loading.prepare_job
load_qwen_pipeline = _loading.load_qwen_pipeline


def emit(stream, job_id, event, **values):
    stream.write(json.dumps({"id": job_id, "event": event, **values}, ensure_ascii=False) + "\n")
    stream.flush()


def generate(job, control, prepared, *, result_callback=None, resident=None, reference_resolution=None, manga_pixels=None):
    data, spec = prepared if prepared is not None else prepare_job(job)
    runner = spec.get("runner")
    packed_manga = spec.get("packedManga", False)
    if runner in ("wan-a14b-sd", "musetalk-native") or (runner == "sd-cpp" and resident is not None):
        owned = resident is None
        cache = sibling("resident_adapters").PipelineCache() if owned else resident
        if runner == "musetalk-native":
            server_type = sibling("musetalk_native").MuseTalk
        elif runner == "wan-a14b-sd":
            server_type = sibling("wan_a14b_sd").WanServer
        else:
            server_type = sibling("keyframe_server").KeyframeServer
        if type(cache.sd_server) is not server_type:
            cache.clear()
            cache.sd_server = server_type()
        try:
            observation = cache.sd_server.generate(job, data, spec, control)
            control.check()
            emit(control.stream, job["id"], "result", outputPath=job["outputPath"], nativeRuntime=observation)
        except BaseException:
            cache.clear()
            raise
        finally:
            if owned:
                cache.clear()
        return
    if resident is not None and resident.sd_server is not None:
        resident.clear()
    if runner in ("longcat-avatar", "sd-cpp"):
        if resident is not None:
            resident.clear()
        module = sibling("keyframe_sd" if runner == "sd-cpp" else "longcat_avatar")
        observation = module.generate(job, data, spec, control)
        control.check()
        emit(control.stream, job["id"], "result", outputPath=job["outputPath"], nativeRuntime=observation)
        return
    if "mossUpscaleScale" in data:
        observation = sibling("moss_upscale").run(job, data, control, Error, resident)
        emit(control.stream, job["id"], "result", outputPath=job["outputPath"], nativeRuntime=observation)
        return
    root = contract.layout(job["modelDir"], spec)
    local_steps = contract.local_h3(root, spec)
    actual_format = spec["localPack"]["format"] if local_steps is not None else "diffusers"
    if data.get("nativeModelFormat", actual_format) != actual_format:
        raise Error("MODEL_CHANGED", "视频模型已更换，请使用当前模型重新提交任务。")
    contract.resolve_local_h3(root, spec, data, local_steps, auto_steps="steps" not in job["input"])
    if spec["family"] == "moss-image":
        resolve_moss_text_precision(root, data)
    styles = _loading.style_selection(job)
    if styles:
        sibling("krea_style").require_dependency()
    import torch
    is_video = spec["media"] == "video"
    video_device = device_backend = None
    if is_video:
        acceleration = sibling("video_acceleration")
        video_device, device_backend = acceleration.device()
        selected = acceleration.select(data["videoAttention"], video_device, device_backend)
    elif not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise Error("DEVICE_UNAVAILABLE", "Native adapters require an NVIDIA CUDA device with BF16 support; CPU fallback is disabled")
    policy = os.environ.get("HUIYU_INFERENCE_MEMORY", "resident")
    if policy not in ("resident", "offload"):
        raise Error("INVALID_MEMORY_POLICY", "Use resident or offload")
    if packed_manga and policy == "resident" and torch.cuda.mem_get_info()[0] < 26 * 1024**3:
        policy = "offload"  # Two model components, condition cache and activations do not fit together.
    if os.environ.get("HUIYU_INFERENCE_ACCELERATION", "native") != "native":
        raise Error("UNSUPPORTED_ACCELERATION", "Anima acceleration modes are not supported by these adapters")
    render_pixels = data["width"] * data["height"]
    conditioned = bool(job.get("inputImagePath"))
    # Manga can match its reference encoding to the requested output area. Account
    # for 32-pixel alignment when reserving activation memory for that input.
    reference_pixels = (reference_resolution + 64) ** 2 if reference_resolution is not None else 1024**2
    memory_pixels = render_pixels + ((1 + len(job.get("referenceImagePaths", []))) * reference_pixels if conditioned else 0)
    if is_video:
        media.encoder(Error)  # Fail before allocating/loading weights if encoder is absent.
    owned = resident is None
    cache = sibling("resident_adapters").PipelineCache() if owned else resident
    pipeline = None
    images = []
    success = False
    try:
        def load_pipeline(model_identity, protection):
            return _loading.load_adapter_pipeline(root, spec, data, policy, control, is_video=is_video,
                video_device=video_device, device_backend=device_backend, memory_pixels=memory_pixels,
                conditioned=conditioned, render_pixels=render_pixels, model_identity=model_identity, protection=protection)

        def prepared(path, task):
            return model_identity(path, data["modelId"], task, moss_weight_precision=data.get("mossWeightPrecision", "auto"),
                                  moss_text_precision=data.get("mossTextPrecision"))

        def unprotected(path, task):
            if spec.get("kreaInt8"):
                return prepared(path, task)
            return {"sha256": fingerprint(path, task), "scope": "full-byte-chunk-sha256"}

        pipeline, identity, reused = cache.acquire(root, spec, data, policy, control, unprotected,
            load_pipeline, Error, styles=styles, prepared_identity=prepared)
        if spec["family"] in ("qwen-image", "moss-image", "krea2") and policy == "offload":
            cache.memory.plan(memory_pixels, image_conditioned=conditioned, control=control, decode_pixels=render_pixels)
        if is_video and hasattr(cache.memory, "plan_video"):
            cache.memory.plan_video(data, control)
        observation = {"adapter": data["modelId"], "validation": "待主力机验证", "modelSha256": identity["sha256"],
                       "modelIdentityScope": identity["scope"],
                       "memoryPolicy": policy, "weightReuse": reused,
                       "memoryScheduling": cache.memory.observation()}
        if styles:
            observation["styleLoraSha256s"] = [identity for _, identity, _ in cache.style_assets]
            observation["styleLoraSha256"] = observation["styleLoraSha256s"][0]
        video.prepare(pipeline, spec, data)
        if policy == "offload" and spec["family"] in ("qwen-image", "moss-image"):
            pipeline.vae.enable_tiling()
        if is_video:
            for path in (job.get("inputImagePath"), job.get("lastFramePath")):
                if path is not None:
                    control.stage("preparing_image")
                    with media.input_image(path, Error) as frame:
                        images.append(frame.convert("RGB"))
            report = dict(device=device_backend, requested=data["videoAttention"], selected=selected,
                          calls=dict(sdpa=0, slicedSdpa=0, flash2=0, sage=0))
            if local_steps is not None:
                observation["nativeModelFormat"] = actual_format
                if data.get("h3Decoder") != "dwd":
                    observation["turboSteps"] = data["steps"]
                    observation["h3Decoder"] = getattr(pipeline.vae, "_huiyu_video_decoder", "original")
                observation["h3VideoShift"] = data["h3VideoShift"]
                observation["h3AudioShift"] = 3
                observation["h3Conditioning"] = getattr(pipeline, "_huiyu_h3_conditioning", {})
                observation["h3Modulation"] = sibling("h3_modulation").begin(pipeline.transformer)
            observation["videoAcceleration"] = report
            rotary = sibling("h3_rotary").rotary(pipeline.transformer) if local_steps is not None else contextlib.nullcontext()
            with torch.inference_mode(), acceleration.attention(pipeline, control, report,
                    dwd=data.get("h3Decoder") == "dwd"), rotary as rotary_stats:
                if rotary_stats is not None:
                    observation["h3Rotary"] = rotary_stats
                frames, soundtrack, sample_rate = video.generate(pipeline, spec, data, control, device=video_device,
                    image=images[0] if images else None, last_frame=images[1] if len(images) == 2 else None,
                    driving_video=job.get("drivingVideoPath"))
            if data.get("h3Decoder") == "dwd":
                observation.update(pipeline._huiyu_dwd_observation)
            control.stage("saving")
            if spec["audio"] and (soundtrack is None or sample_rate != spec["sampleRate"]):
                raise Error("INVALID_MODEL_OUTPUT", "Joint audio output or its sample rate is missing/invalid")
            report["encoder"] = media.video(frames, job["outputPath"], data, control, Error, soundtrack,
                                            sample_rate, device_backend=device_backend)
            control.check()
            success = True
            return

        prefix = None
        def on_step(pipe, step, timestep, callback_kwargs):
            total = pipe.num_timesteps if spec["family"] == "qwen-image" else data["steps"]
            control.progress(step + 1, total)
            if spec["family"] == "krea2" and policy == "offload":
                cache.memory.step_finished(step + 1, total)
            if step + 1 == total:
                if prefix is not None:
                    prefix.retire()
                if policy == "offload" and spec["family"] == "krea2":
                    cache.memory.enter("vae")
                if policy == "offload" and spec["family"] not in ("qwen-image", "moss-image", "krea2"):
                    cache.memory.offload_all()
                    torch.cuda.empty_cache()
                control.stage("decoding")
            return callback_kwargs

        args = dict(prompt=data["prompt"], width=data["width"], height=data["height"],
                    num_inference_steps=data["steps"], generator=torch.Generator("cuda").manual_seed(data["seed"]),
                    output_type="np", callback_on_step_end=on_step, callback_on_step_end_tensor_inputs=[])
        if packed_manga:
            # The upstream RandomNoise node samples FP32 on the CPU, then moves
            # those same values to the device for the eight Euler steps.
            h, w = data["height"] // pipeline.vae_scale_factor, data["width"] // pipeline.vae_scale_factor
            channels = pipeline.latent_channels
            noise = torch.randn((1, channels, h, w), dtype=torch.float32, device="cpu",
                                generator=torch.Generator("cpu").manual_seed(data["seed"]))
            args["latents"] = noise.flatten(2).transpose(1, 2)
        if spec["family"] == "qwen-image":
            args["true_cfg_scale"] = data["cfg"]
            if data["negativePrompt"]:
                args["negative_prompt"] = data["negativePrompt"]
            if job.get("inputImagePath"):
                control.stage("preparing_image")
                if manga_pixels is None:
                    for path in [job["inputImagePath"], *job.get("referenceImagePaths", [])]:
                        control.check()
                        images.append(media.input_image(path, Error))
                else:
                    # Manga has already applied the selected workflow's RGB
                    # and orientation rules. Qwen expects an opaque RGBA image.
                    from PIL import Image
                    with Image.fromarray(manga_pixels) as source:
                        if packed_manga and source.size != (data["width"], data["height"]):
                            with source.resize((data["width"], data["height"]), Image.Resampling.LANCZOS) as scaled:
                                images.append(scaled.convert("RGBA"))
                        else:
                            images.append(source.convert("RGBA"))
                args["image"] = images
                if reference_resolution is not None:
                    args["output_resolution"] = reference_resolution
        else:
            args["guidance_scale"] = data["cfg"]
            if spec["family"] == "krea2" and spec.get("cfgConvention") == "standard":
                # Krea applies guidance to the conditional prediction: CFG 1 needs only that branch.
                args["guidance_scale"] -= 1
            if spec["negative"]:
                args["negative_prompt"] = data["negativePrompt"]
        control.stage("encoding")
        use_prefix = policy == "offload" and spec["family"] == "qwen-image"
        branches = 2 if data["cfg"] > 1 and data["negativePrompt"] else 1
        attention = sibling("native_attention").inference_attention(spec["family"] in ("qwen-image", "moss-image") and not packed_manga,
            compile_safe=spec["family"] == "moss-image" and data["mossCompile"],
            moss_int8=spec["family"] == "moss-image" and bool(getattr(pipeline.transformer, "_huiyu_int8_attention", False)))
        with torch.inference_mode(), sibling("qwen_prefix_cache").context(
                use_prefix, pipeline, branches, control, observation,
                directory=Path(job["outputPath"]).parent, allow_partial=packed_manga) as prefix, attention as backend:
            observation["attentionBackend"] = ("comfy-kitchen-int8" if packed_manga
                and pipeline.transformer._huiyu_manga_int8_attention else backend)
            if spec["family"] == "moss-image":
                output = sibling("moss_adapter").generate(pipeline, data, control, observation, spec)
            elif spec["family"] == "krea2":
                output = sibling("krea_adapter").generate(pipeline, args, control, observation)
            else:
                output = pipeline(**args)
        control.stage("saving")
        if manga_pixels is None:
            media.png(output.images[0], job["outputPath"], data, Error)
        else:
            # Upstream MangaFinish and its line annotator truncate the VAE channels.
            redraw = media.pixels(output.images[0], data, (3, 4), Error, truncate=packed_manga)
        control.check()
        success = True
        if manga_pixels is not None:
            return redraw
    except torch.OutOfMemoryError as exc:
        if spec["family"] == "krea2" or is_video:
            import traceback
            if cache.memory is not None:
                print("Native memory plan:", cache.memory.observation(), file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)
        raise Error("NATIVE_OUT_OF_MEMORY", "显存不足，请选择分层卸载或缩小画幅。") from exc
    except Exception as exc:
        if is_video and not isinstance(exc, Error):
            import traceback
            traceback.print_exc(file=sys.stderr)
        raise
    finally:
        for image in images:
            image.close()
        # Retire the task-local shell/solver before acknowledging cleanup. Manga
        # calls without a cache still release Qwen before CPU line extraction.
        pipeline = None
        cache.finish(success and not owned)
        if success:
            control.check()
            if result_callback is not None:
                result_callback(observation)
            elif manga_pixels is None:
                emit(control.stream, job["id"], "result", outputPath=job["outputPath"], nativeRuntime=observation)


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--serve", action="store_true")
    modes.add_argument("--catalog", action="store_true")
    modes.add_argument("--diagnose", action="store_true")
    modes.add_argument("--validate", metavar="MODEL_DIR")
    modes.add_argument("--prepare-moss", metavar="MODEL_DIR")
    parser.add_argument("--model-id")
    args = parser.parse_args()
    stream = sys.stdout
    try:
        with contextlib.redirect_stdout(sys.stderr):
            if args.catalog:
                emit(stream, None, "catalog", **contract.MANIFEST)
            elif args.diagnose:
                versions = dependencies(args.model_id)
                if args.model_id and contract.model(args.model_id).get("runner") == "musetalk-native":
                    import torch
                    emit(stream, None, "diagnostic", valid=True, dependencies=versions, deviceName=torch.cuda.get_device_name(),
                         scope="imports, CUDA visibility and FFmpeg")
                    return 0
                if args.model_id and contract.model(args.model_id).get("runner") in ("sd-cpp", "wan-a14b-sd"):
                    emit(stream, None, "diagnostic", valid=True, dependencies=versions,
                         scope="Python image decoding; use --validate for runner and model files")
                    return 0
                if args.model_id and contract.model(args.model_id)["media"] == "video":
                    acceleration = sibling("video_acceleration")
                    target, backend = acceleration.device()
                    selected = ("flash2" if contract.model(args.model_id).get("runner") == "longcat-avatar"
                                else acceleration.select("auto", target, backend))
                    emit(stream, None, "diagnostic", valid=True, dependencies=versions, device=str(target),
                         deviceBackend=backend, autoAttention=selected,
                         ffmpeg=media.encoder(Error), scope="imports, encoder path and device visibility",
                         validation="待主力机验证")
                    return 0
                sibling("krea_style").require_dependency()
                import torch
                cuda = torch.cuda.is_available()
                if args.model_id and contract.model(args.model_id).get("kreaInt8"):
                    versions = dict(versions, kreaInt8Backend=sibling("moss_int8").require_backend(contract))
                emit(stream, None, "diagnostic", valid=True, dependencies=versions, cudaAvailable=cuda,
                     deviceName=torch.cuda.get_device_name() if cuda else None,
                     scope="imports and device visibility; no weights or inference", validation="待主力机验证")
            elif args.validate:
                root = contract.layout(args.validate, contract.model(args.model_id))
                emit(stream, None, "validation", valid=True, modelDir=str(root), dependencies=dependencies(args.model_id),
                     scope="layout-and-imports-only; no weight correctness or GPU inference proof", validation="待主力机验证")
            elif args.prepare_moss:
                spec = contract.model(args.model_id)
                if spec["family"] != "moss-image":
                    raise Error("NATIVE_MODEL_UNSUPPORTED", "请选择已登记的 MOSS 模型")
                root = contract.layout(args.prepare_moss, spec)
                control = SimpleNamespace(check=lambda: None)
                precision = spec.get("managedPrecision", {})
                variant = spec["mossInt8"] if precision.get("transformer") == "int8" else None
                print("HUIYU:CONVERT|核对并适配 MOSS 主模型结构", file=sys.stderr, flush=True)
                sibling("moss_adapter").load_transformer(root, control, contract, variant, None)
                if precision.get("text_encoder") == "int8":
                    print("HUIYU:CONVERT|核对并适配 INT8 文本编码器", file=sys.stderr, flush=True)
                    sibling("moss_text").load_int8(root, control, contract, spec["mossTextInt8"], None)
                print(json.dumps({"ok": True, "preparedModel": args.model_id, "weightsMapped": True}), file=stream, flush=True)
            else:
                resident = sibling("resident_adapters").PipelineCache()
                def initialize(job, ready, control):
                    prepared = prepare_job(job, resident=resident, control=control, ready=ready)
                    ready()
                    return prepared
                try:
                    return lifecycle.serve(lambda job, control, prepared: generate(job, control, prepared, resident=resident),
                        input_stream=sys.stdin, stream=stream, emit=emit, error=Error,
                        initialize=initialize, cancel_cleanup=resident.clear, idle_cleanup=resident.offload_idle_images)
                finally:
                    resident.clear()
        return 0
    except Exception as exc:
        code = exc.code if isinstance(exc, lifecycle.WorkerError) else "NATIVE_ADAPTER_FAILED"
        emit(stream, None, "error", code=code, message=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
