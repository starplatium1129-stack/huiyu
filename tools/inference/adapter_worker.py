"""Native image/video adapters; local assets only, pending primary-machine validation.

Run in the separate requirements-adapters.txt environment. This worker never
installs dependencies, downloads weights, executes repository-provided custom code or invokes ComfyUI.
"""
from __future__ import annotations

import argparse
import contextlib
import gc
import hashlib
import importlib.metadata
import importlib.util
import inspect
import json
import os
from pathlib import Path
import sys

for _key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"):
    os.environ[_key] = "1"


def sibling(name):
    spec = importlib.util.spec_from_file_location(f"huiyu_{name}", Path(__file__).with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


contract = sibling("adapter_contract")
lifecycle = sibling("worker_lifecycle")
media = sibling("adapter_media")
video = sibling("adapter_video")
Error = contract.AdapterError


def emit(stream, job_id, event, **values):
    stream.write(json.dumps({"id": job_id, "event": event, **values}, ensure_ascii=False) + "\n")
    stream.flush()


def dependencies():
    versions = {}
    for name, expected in {"torch": "2.8.0", "torchvision": "0.23.0", "transformers": "5.17.0",
                           "accelerate": "1.12.0", "safetensors": "0.8.0", "Pillow": "11.3.0", "ftfy": "6.3.1"}.items():
        try:
            value = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError as exc:
            raise Error("DEPENDENCY_MISSING", f"Missing {name}; prepare a separate requirements-adapters.txt environment") from exc
        if value.split("+")[0] != expected:
            raise Error("DEPENDENCY_VERSION", f"Adapter environment requires {name}=={expected}, found {value}; keep Anima unchanged")
        versions[name] = value
    try:
        distribution = importlib.metadata.distribution("diffusers")
        origin = json.loads(distribution.read_text("direct_url.json") or "{}")
        if origin.get("vcs_info", {}).get("commit_id") != contract.MANIFEST["implementation"]["revision"]:
            raise Error("DEPENDENCY_VERSION", "Diffusers must use the reviewed source commit in requirements-adapters.txt")
        import torch
        import numpy
        import diffusers
        from PIL import Image
        from transformers import Qwen3VLModel, Qwen3VLForConditionalGeneration, Qwen3VLProcessor, UMT5EncoderModel
        for name in {model["pipeline"] for model in contract.MANIFEST["models"].values()}:
            pipeline = getattr(diffusers, name)
            if name in ("HunyuanVideo15Pipeline", "MiniMaxH3ModularPipeline"):
                continue  # These use the task-local scheduler observer, not pipeline callbacks.
            if "callback_on_step_end" not in inspect.signature(pipeline.__call__).parameters:
                raise Error("DEPENDENCY_API", f"{name} lacks the required progress/cancellation callback")
        if "sample_sigmas" not in inspect.signature(diffusers.QwenImage21Pipeline.__init__).parameters:
            raise Error("DEPENDENCY_API", "Qwen 2.1 Turbo requires pipeline-configured sample_sigmas")
        versions["diffusers"] = distribution.version
    except Error:
        raise
    except Exception as exc:
        raise Error("DEPENDENCY_IMPORT", f"Native adapter imports failed: {exc}") from exc
    return versions


def fingerprint(root, control):
    # No warm-weight cache: read all bytes before/after loading to reject drift.
    digest = hashlib.sha256()
    paths = []
    for parent, directories, files in os.walk(root, followlinks=False):
        for directory in directories:
            path = Path(parent) / directory
            if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
                raise Error("MODEL_INVALID", f"Linked model directory: {path}")
        for name in files:
            path = Path(parent) / name
            if path.suffix in (".json", ".safetensors", ".model", ".txt", ".jinja"):
                paths.append(path)
                if len(paths) > 10000:
                    raise Error("MODEL_INVALID", "Too many model assets")
    for path in sorted(paths):
        control.check()
        contract.safe_file(root, path)
        digest.update(str(path.relative_to(root)).encode("utf-8") + b"\0")
        with path.open("rb") as source:
            while chunk := source.read(8 * 1024 * 1024):
                control.check()
                digest.update(chunk)
    return digest.hexdigest()


def generate(job, control, _prepared, *, result_callback=None):
    data, spec = contract.validate(job)
    root = contract.layout(job["modelDir"], spec)
    import torch
    import diffusers
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise Error("DEVICE_UNAVAILABLE", "Native adapters require an NVIDIA CUDA device with BF16 support; CPU fallback is disabled")
    policy = os.environ.get("HUIYU_INFERENCE_MEMORY", "resident")
    if policy not in ("resident", "offload"):
        raise Error("INVALID_MEMORY_POLICY", "Use resident or offload")
    if os.environ.get("HUIYU_INFERENCE_ACCELERATION", "native") != "native":
        raise Error("UNSUPPORTED_ACCELERATION", "Anima acceleration modes are not supported by these adapters")
    if spec["media"] == "video":
        media.encoder(Error)  # Fail before allocating/loading weights if encoder is absent.
    control.stage("fingerprint")
    identity = fingerprint(root, control)
    pipeline = None
    image = None
    try:
        control.stage("loading")
        kwargs = {"local_files_only": True, "use_safetensors": True, "torch_dtype": torch.bfloat16}
        pipeline = (video.load(root, spec, data, control, contract) if spec["media"] == "video"
                    else getattr(diffusers, spec["pipeline"]).from_pretrained(str(root), **kwargs))
        kwargs.clear()
        control.stage("fingerprint")
        if fingerprint(root, control) != identity:
            raise Error("MODEL_CHANGED", "Model assets changed during loading; generation rejected")
        control.stage("uploading")
        if spec["media"] == "video":
            video.place(pipeline, spec, policy)
            with torch.inference_mode():
                frames, soundtrack, sample_rate = video.generate(pipeline, spec, data, control)
            control.stage("saving")
            if spec["audio"] and (soundtrack is None or sample_rate != spec["sampleRate"]):
                raise Error("INVALID_MODEL_OUTPUT", "Joint audio output or its sample rate is missing/invalid")
            media.video(frames, job["outputPath"], data, control, Error, soundtrack, sample_rate)
            control.check()
            emit(control.stream, job["id"], "result", outputPath=job["outputPath"],
                 nativeRuntime={"adapter": data["modelId"], "validation": "待主力机验证", "modelSha256": identity,
                                "memoryPolicy": policy, "weightReuse": False})
            return
        if policy == "offload":
            pipeline.enable_model_cpu_offload()
        else:
            pipeline.to("cuda")
        pipeline.set_progress_bar_config(disable=True)

        def on_step(pipe, step, timestep, callback_kwargs):
            control.progress(step + 1, data["steps"])
            if step + 1 == data["steps"]:
                control.stage("decoding")
            return callback_kwargs

        args = dict(prompt=data["prompt"], width=data["width"], height=data["height"],
                    num_inference_steps=data["steps"], generator=torch.Generator("cuda").manual_seed(data["seed"]),
                    output_type="np", callback_on_step_end=on_step, callback_on_step_end_tensor_inputs=[])
        if spec["family"] == "qwen-image":
            args["true_cfg_scale"] = data["cfg"]
            if data["negativePrompt"]:
                args["negative_prompt"] = data["negativePrompt"]
            if job.get("inputImagePath"):
                control.stage("preparing_image")
                image = media.input_image(job["inputImagePath"], Error)
                args["image"] = image
        else:
            args["guidance_scale"] = data["cfg"]
            if spec["negative"]:
                args["negative_prompt"] = data["negativePrompt"]
        control.stage("encoding")
        with torch.inference_mode():
            output = pipeline(**args)
        control.stage("saving")
        media.png(output.images[0], job["outputPath"], data, Error)
        control.check()
        observation = {"adapter": data["modelId"], "validation": "待主力机验证", "modelSha256": identity,
                       "memoryPolicy": policy, "weightReuse": False}
        if result_callback is None:
            emit(control.stream, job["id"], "result", outputPath=job["outputPath"], nativeRuntime=observation)
        else:
            # A MangaScreen task consumes this image privately and publishes only its final page.
            result_callback(observation)
    except torch.cuda.OutOfMemoryError as exc:
        raise Error("NATIVE_OUT_OF_MEMORY", "CUDA 显存不足；尝试 offload 或缩小尺寸。尚未接入量化/块卸载，不会回退 ComfyUI") from exc
    finally:
        if image is not None:
            image.close()
        # Placement policy is per task. Do not retain potentially mutated model
        # state across adapters/cancellation until primary-machine verification.
        if pipeline is not None:
            video.release(pipeline)
        pipeline = None
        gc.collect()


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--serve", action="store_true")
    modes.add_argument("--catalog", action="store_true")
    modes.add_argument("--diagnose", action="store_true")
    modes.add_argument("--validate", metavar="MODEL_DIR")
    parser.add_argument("--model-id")
    args = parser.parse_args()
    stream = sys.stdout
    try:
        with contextlib.redirect_stdout(sys.stderr):
            if args.catalog:
                emit(stream, None, "catalog", **contract.MANIFEST)
            elif args.diagnose:
                versions = dependencies()
                emit(stream, None, "diagnostic", dependencies=versions, scope="imports-only; no weights or inference", validation="待主力机验证")
            elif args.validate:
                root = contract.layout(args.validate, contract.model(args.model_id))
                emit(stream, None, "validation", modelDir=str(root), dependencies=dependencies(),
                     scope="layout-and-imports-only; no weight correctness or GPU inference proof", validation="待主力机验证")
            else:
                def initialize(job, ready):
                    contract.validate(job)
                    dependencies()
                    ready()
                return lifecycle.serve(generate, input_stream=sys.stdin, stream=stream, emit=emit,
                                       error=Error, initialize=initialize)
        return 0
    except Exception as exc:
        emit(stream, None, "error", code=getattr(exc, "code", "NATIVE_ADAPTER_FAILED"), message=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
