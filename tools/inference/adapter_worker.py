"""Native image and video inference from local model assets.

Run in the separate requirements-adapters.txt environment. This worker never
installs dependencies, downloads weights, executes repository-provided custom code or invokes ComfyUI.
"""
from __future__ import annotations

import argparse
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import inspect
import json
import os
from pathlib import Path
import sys
import threading
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
Error = contract.AdapterError


def emit(stream, job_id, event, **values):
    stream.write(json.dumps({"id": job_id, "event": event, **values}, ensure_ascii=False) + "\n")
    stream.flush()


@lru_cache(maxsize=2)
def runtime_dependencies(video_runtime=False):
    sibling("resident_adapters")
    sibling("native_memory")
    sibling("locked_identity")
    versions = {}
    expected_versions = {"torch": "2.9.0", "torchvision": "0.24.0", "transformers": "5.17.0",
                         "accelerate": "1.12.0", "safetensors": "0.8.0", "Pillow": "11.3.0", "ftfy": "6.3.1",
                         "huggingface-hub": "1.32.0"}
    try:
        current_torch = importlib.metadata.version("torch").split("+")[0]
    except importlib.metadata.PackageNotFoundError as exc:
        raise Error("DEPENDENCY_MISSING", "Missing torch; prepare the image runtime") from exc
    if current_torch == "2.13.0":
        expected_versions.update(torch="2.13.0", torchvision="0.28.0", transformers="5.14.1",
                                 Pillow="12.2.0")
        if not video_runtime:
            expected_versions["sageattention"] = "2.2.0"
    elif video_runtime and current_torch == "2.9.1":
        expected_versions.update(torch="2.9.1", torchvision="0.24.1")
    for name, expected in expected_versions.items():
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
        versions["diffusers"] = distribution.version
    except Error:
        raise
    except Exception as exc:
        raise Error("DEPENDENCY_IMPORT", f"Native adapter imports failed: {exc}") from exc
    return versions


@lru_cache(maxsize=None)
def pipeline_dependencies(name, layout):
    try:
        import diffusers
        import transformers
        for component, (library, cls, *_) in contract.MANIFEST["layouts"][layout].items():
            if library == "transformers" and (component.startswith("text_encoder") or component == "processor"):
                getattr(transformers, cls)
        if name == "MOSSImagePipeline":
            sibling("moss_adapter").pipeline_class()
            return
        pipeline = getattr(diffusers, name)
        if name not in ("HunyuanVideo15Pipeline", "MiniMaxH3ModularPipeline", "WanAnimate2DistilledModularPipeline"):
            if "callback_on_step_end" not in inspect.signature(pipeline.__call__).parameters:
                raise Error("DEPENDENCY_API", f"{name} lacks the required progress/cancellation callback")
        if name == "QwenImage21Pipeline":
            sibling("qwen_prefix_cache")
            if "sample_sigmas" not in inspect.signature(pipeline.__init__).parameters:
                raise Error("DEPENDENCY_API", "Qwen 2.1 Turbo requires pipeline-configured sample_sigmas")
    except Error:
        raise
    except Exception as exc:
        raise Error("DEPENDENCY_IMPORT", f"{name} import failed: {exc}") from exc


def dependencies(model_id=None):
    if model_id and contract.model(model_id).get("runner") == "musetalk-native":
        return sibling("musetalk_native").dependencies()
    if model_id and contract.model(model_id).get("runner") == "longcat-avatar":
        return sibling("longcat_avatar").validate_runtime(contract.model(model_id))
    if model_id and contract.model(model_id).get("runner") in ("sd-cpp", "wan-a14b-sd"):
        try:
            from PIL import __version__ as pillow_version
        except ImportError as exc:
            raise Error("DEPENDENCY_MISSING", "关键帧工作进程需要 Pillow 读取参考图。") from exc
        if contract.model(model_id).get("runner") == "wan-a14b-sd":
            media.encoder(Error)
        return {"Pillow": pillow_version, "sd.cppRelease": contract.MANIFEST["keyframeRuntime"]["release"]}
    versions = runtime_dependencies(model_id is not None and contract.model(model_id)["media"] == "video")
    models = contract.MANIFEST["models"].values() if model_id is None else (contract.model(model_id),)
    for model in models:
        if model.get("runner") in ("longcat-avatar", "sd-cpp", "wan-a14b-sd", "musetalk-native"):
            continue  # These runners load their own model implementation.
        pipeline_dependencies(model["pipeline"], model.get("layout", model["pipeline"]))
    return versions


MODEL_SUFFIXES = {".json", ".safetensors", ".model", ".txt", ".jinja"}


def fingerprint(root, control):
    # Still read every byte under the identity lease. Hash independent fixed-size
    # chunks in parallel, then bind their ordered digests, paths and file lengths.
    digest = hashlib.sha256(b"huiyu-model-chunk-sha256-v1\0")
    paths = []
    for parent, directories, files in os.walk(root, followlinks=False):
        for directory in directories:
            path = Path(parent) / directory
            if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
                raise Error("MODEL_INVALID", f"Linked model directory: {path}")
        for name in files:
            path = Path(parent) / name
            if path.suffix.lower() in MODEL_SUFFIXES:
                paths.append(path)
                if len(paths) > 10000:
                    raise Error("MODEL_INVALID", "Too many model assets")
    workers = min(4, os.cpu_count() or 1)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for path in sorted(paths):
            control.check()
            contract.safe_file(root, path)
            digest.update(str(path.relative_to(root)).encode("utf-8") + b"\0")
            digest.update(path.stat().st_size.to_bytes(8, "little"))
            pending = deque()
            with path.open("rb") as source:
                while chunk := source.read(8 * 1024 * 1024):
                    control.check()
                    pending.append(pool.submit(lambda value: hashlib.sha256(value).digest(), chunk))
                    if len(pending) >= workers:
                        digest.update(pending.popleft().result())
            for result in pending:
                control.check()
                digest.update(result.result())
    return digest.hexdigest()


def converted_identity(root, receipt, trusted, control, *, read_extra_configs=False, verified_extras=()):
    """Use a pinned local import record only for its complete, unchanged fileset."""
    marker = root / "huiyu-model.json"
    recorded = receipt.get("files")
    if not isinstance(recorded, list) or len(recorded) != len(trusted):
        return None
    expected = {row["path"]: (row["bytes"], row["sha256"]) for row in trusted}
    if any(not isinstance(row, dict) or not isinstance(row.get("path"), str) for row in recorded) or expected != {
            row.get("path"): (row.get("bytes"), row.get("sha256")) for row in recorded}:
        return None
    stamp = marker.stat().st_mtime_ns
    for name, (size, _) in expected.items():
        control.check()
        path = root / name
        if not path.exists():
            return None
        meta = contract.safe_file(root, path).stat()
        if meta.st_size != size or meta.st_mtime_ns > stamp:
            return None
    for asset in verified_extras:
        expected[asset["path"]] = (asset["bytes"], asset["sha256"])
    for path in root.rglob("*"):
        control.check()
        if path == marker or path.suffix.lower() not in MODEL_SUFFIXES:
            continue
        name = path.relative_to(root).as_posix()
        if name not in expected:
            if not read_extra_configs or path.suffix.lower() not in (".json", ".txt", ".jinja"):
                return None
            meta = contract.safe_file(root, path).stat()
            if meta.st_size > 32 << 20:
                return None
            with path.open("rb") as stream:
                expected[name] = (meta.st_size, hashlib.file_digest(stream, "sha256").hexdigest())
    identity = hashlib.sha256(json.dumps(expected, sort_keys=True, separators=(",", ":")).encode())
    return {"sha256": identity.hexdigest(), "scope": "prepared-local-weights"}


def imported_weight_digest(root, asset, control):
    path = contract.safe_file(root, root / asset["path"])
    checksum = sibling("native_hash").file_sha256(path, check=control.check)
    if checksum != asset["sha256"]:
        raise Error("MODEL_CHANGED", "MOSS INT8 权重校验不符，请重新导入该文件")
    return asset["path"].encode() + b"\0" + bytes.fromhex(checksum)


def model_identity(root, model_id, control, *, moss_weight_precision="auto", moss_text_precision=None):
    model = contract.model(model_id)
    moss = model["family"] == "moss-image"
    variant = sibling("moss_int8").selected(root, moss_weight_precision, contract, expected_model=model_id) if moss else None
    marker = root / "huiyu-model.json"
    if marker.is_file():
        receipt = contract.config(root, marker)
        manifest = contract.document(Path(__file__).with_name("managed-adapter-models.json"))
        spec = next((item for item in manifest["models"] if item["id"] == model_id), None)
        known_components = model.get("localConversionComponentsSha256")
        if (known_components and receipt.get("modelId") == model_id and receipt.get("schemaVersion") == 1
                and receipt.get("scope") == "local-fp8-dequantized-bf16"):
            # This legacy exporter hashes the weight shards but omits tokenizer
            # and config files. Read those small files under the same identity lease.
            components = receipt.get("components")
            payload = json.dumps(components, sort_keys=True, separators=(",", ":")).encode()
            if hashlib.sha256(payload).hexdigest() == known_components:
                files = [dict(path=f"{name}/{path}", **item) for name, row in components.items()
                         for path, item in row["files"].items()]
                identity = converted_identity(root, {"files": files}, files, control, read_extra_configs=True)
                if identity:
                    return identity
        if (model_id == "wan2.2-ti2v-5b" and spec and receipt.get("schemaVersion") == 1
                and receipt.get("modelId") == model_id and receipt.get("revision") == spec["revision"]
                and receipt.get("scope") == "converted-local-weights-sha256"):
            recipe = contract.document(Path(__file__).with_name("wan22-import.json"))
            if receipt.get("sources") == list(recipe["sources"].values()):
                identity = converted_identity(root, receipt, recipe["convertedFiles"], control)
                if identity:
                    return identity
        if model_id == "minimax-h3" and spec and contract.local_h3(root, model):
            pack = model["localPack"]
            assets = [row for row in pack["files"] if not row.get("optional") or (root / row["path"]).exists()]
            configs = [row for row in spec["files"] if row["path"] in pack["configs"]]
            extras = sibling("import_h3").prepared_accelerators(root) if (root / "accelerators").is_dir() else {}
            identity = converted_identity(root, receipt, [*assets, *configs], control,
                                          verified_extras=[row for rows in extras.values() for row in rows])
            if identity:
                return identity
        if (spec is not None and receipt.get("schemaVersion") == 1
                and receipt.get("modelId") == model_id and receipt.get("revision") == spec["revision"]
                and receipt.get("scope") == "downloaded-files-sha256"):
            # Setup already hashes every downloaded byte before writing this record.
            # Follow that preparation contract instead of rescanning tens of GB at
            # every worker start. Changed/unmanaged files keep full-byte validation.
            prepared_at = marker.stat().st_mtime_ns
            files = spec["files"]
            if moss and receipt.get("mossTextPrecision") == "int8":
                text = model["mossTextInt8"]
                files = [item for item in files if not item["path"].startswith("text_encoder/model")] + [text]
            ready = True
            for item in files:
                control.check()
                path = root / item["path"]
                if not path.exists():
                    ready = False
                    break
                contract.safe_file(root, path)
                info = path.stat()
                if info.st_size != item["bytes"] or info.st_mtime_ns > prepared_at:
                    ready = False
                    break
            if ready:
                digest = hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(",", ":")).encode())
                imports = {}
                if moss:
                    digest.update(json.dumps(variant or {"precision": "fp16"}, sort_keys=True).encode())
                    if variant:
                        imports[variant["path"]] = variant
                    if moss_text_precision == "int8":
                        text = sibling("moss_int8").selected(root, "int8", contract,
                            component="text_encoder", expected_model=model_id)
                        imports[text["path"]] = text
                known = {item["path"] for item in files}
                extra_weights = []
                for path in sorted(root.rglob("*")):
                    control.check()
                    relative = path.relative_to(root).as_posix()
                    if path == marker or relative in known or path.suffix.lower() not in MODEL_SUFFIXES or path.is_dir():
                        continue
                    # A local tokenizer or weight variant can change what from_pretrained loads.
                    if path.suffix.lower() == ".json":
                        contract.config(root, path)
                        digest.update(relative.encode() + b"\0" + path.read_bytes())
                    elif relative in imports:
                        extra_weights.append(imports[relative])
                    else:
                        break
                else:
                    # Legacy installs can retain the original weights alongside
                    # a separately imported INT8 file. Under the NTFS lease,
                    # verify that entire extra file against its registered SHA.
                    # The download receipt already covers the base components.
                    for asset in extra_weights:
                        digest.update(imported_weight_digest(root, asset, control))
                    return {"sha256": digest.hexdigest(), "scope": "prepared-download-record"}
    return {"sha256": fingerprint(root, control), "scope": "full-byte-chunk-sha256"}


@contextlib.contextmanager
def windows_weight_reads():
    if sys.platform != "win32":
        yield
        return
    import safetensors
    import safetensors.torch
    from transformers import modeling_utils as encoder_loading
    # Diffusers imports safe_open inside its loading functions; changing the
    # public entry point covers those imports without inventing module aliases.
    readers = (safetensors, safetensors.torch, encoder_loading)
    originals = [(module, module.safe_open) for module in readers]
    reader_class = sibling("mapped_weights").ReadOnlyWeights
    async_loading = os.environ.get("HF_DEACTIVATE_ASYNC_LOAD")
    os.environ["HF_DEACTIVATE_ASYNC_LOAD"] = "1"

    def safe_open(*args, **kwargs):
        return reader_class(*args, **kwargs)

    # The pinned loader's writable mmap reserves Windows commit for whole files.
    # Use immutable file views during weight loading, then restore readers.
    for module, _ in originals:
        module.safe_open = safe_open
    try:
        yield
    finally:
        for module, reader in originals:
            module.safe_open = reader
        if async_loading is None:
            os.environ.pop("HF_DEACTIVATE_ASYNC_LOAD", None)
        else:
            os.environ["HF_DEACTIVATE_ASYNC_LOAD"] = async_loading


def resolve_moss_text_precision(root, data):
    if data["mossTextPrecision"] == "auto":
        variant = sibling("moss_int8").selected(root, "auto", contract, component="text_encoder", expected_model=data["modelId"])
        data["mossTextPrecision"] = "int8" if variant else "bf16"


def prepare_moss_start(root, data, resident, control, ready):
    # The lease and DLL imports stay on the owner thread. Preload the stdlib
    # helpers before starting the independent read of the protected bytes.
    sibling("moss_int8")
    sibling("native_hash")
    resolve_moss_text_precision(root, data)

    def import_pipeline():
        try:
            dependencies(data["modelId"])
        finally:
            ready()

    def protected_identity(path):
        stop = threading.Event()

        def check():
            control.check()
            if stop.is_set():
                raise InterruptedError("Stopped model verification after an import failure")

        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="moss-verify") as pool:
            verification = pool.submit(model_identity, path, data["modelId"], SimpleNamespace(check=check),
                moss_weight_precision=data["mossWeightPrecision"], moss_text_precision=data["mossTextPrecision"])
            try:
                import_pipeline()
                if not verification.done():
                    control.stage("fingerprint")
                return verification.result()
            finally:
                stop.set()

    # Without NTFS protection, leave both full reads to the normal loader.
    resident.lease.acquire(root, lambda _: None, prepared_identity=protected_identity)
    if resident.lease.cached:
        policy = os.environ.get("HUIYU_INFERENCE_MEMORY", "resident")
        resident.scope = resident.weight_scope(root, data, policy, None)
    else:
        import_pipeline()


def prepare_job(job, *, resident=None, control=None, ready=None):
    data, spec = contract.validate(job)
    if "mossUpscaleScale" in data:
        runtime_dependencies()
    elif resident is not None and os.name == "nt" and spec["family"] == "moss-image":
        prepare_moss_start(contract.layout(job["modelDir"], spec), data, resident, control, ready)
    else:
        dependencies(data["modelId"])
    return data, spec


def generate(job, control, prepared, *, result_callback=None, resident=None, reference_resolution=None, manga_pixels=None):
    data, spec = prepared if prepared is not None else prepare_job(job)
    runner = spec.get("runner")
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
    if local_steps is not None:
        if data["steps"] not in local_steps:
            raise Error("INVALID_PARAMETER", f"本地 H3 Turbo 已安装的步数为 {local_steps}，请重新选择步数。")
        data["_h3TurboSteps"] = data["steps"]
        mode = data.get("videoAttention")
        data.setdefault("h3VideoShift", 6 if data["steps"] == 4 and mode != "h3-fused" else 12)
        if mode in ("h3-sla", "h3-fused") or data.get("h3Decoder") == "lightvae":
            extras = sibling("import_h3").prepared_accelerators(root)
            if data.get("h3Decoder") == "lightvae" and "lightvae" not in extras:
                raise Error("MODEL_CHANGED", "此配方所需的 H3 LightVAE 权重未就绪。")
            if mode in ("h3-sla", "h3-fused"):
                kind = mode.removeprefix("h3-")
                if data["steps"] != 4 or kind not in extras or data["h3VideoShift"] != (6 if kind == "sla" else 12):
                    raise Error("UNSUPPORTED_ACCELERATION", "所选 H3 加速需要对应的四步权重和采样偏移。")
                data["_h3AccelerationPath"] = contract.safe_file(root, root / extras[kind][0]["path"])
    elif data.get("videoAttention") in ("h3-sol", "h3-sla", "h3-fused") or "h3Decoder" in data or "h3VideoShift" in data:
        raise Error("UNSUPPORTED_ACCELERATION", "此选项需要本机量化版 H3 Turbo。")
    if spec["family"] == "moss-image":
        resolve_moss_text_precision(root, data)
    style_path = Path(job["loras"][0]["path"]) if job.get("loras") else None
    if style_path is not None:
        sibling("krea_style").require_dependency()
    import torch
    import diffusers
    is_video = spec["media"] == "video"
    if is_video:
        acceleration = sibling("video_acceleration")
        video_device, device_backend = acceleration.device()
        selected = acceleration.select(data["videoAttention"], video_device, device_backend)
    elif not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise Error("DEVICE_UNAVAILABLE", "Native adapters require an NVIDIA CUDA device with BF16 support; CPU fallback is disabled")
    policy = os.environ.get("HUIYU_INFERENCE_MEMORY", "resident")
    if policy not in ("resident", "offload"):
        raise Error("INVALID_MEMORY_POLICY", "Use resident or offload")
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
        kwargs = {"local_files_only": True, "use_safetensors": True, "torch_dtype": torch.bfloat16,
                  "low_cpu_mem_usage": True}

        def load_pipeline():
            placement = None
            try:
                if spec["family"] == "moss-image":
                    with windows_weight_reads():
                        template = sibling("moss_adapter").load(root, control, contract, data["modelId"],
                            text_precision=data["mossTextPrecision"], weight_precision=data["mossWeightPrecision"])
                    if policy == "resident":
                        if getattr(template.transformer, "_huiyu_int8_count", 0):
                            sibling("moss_int8").place_resident(template.transformer)
                        else:
                            template.transformer.to(device="cuda:0", dtype=torch.bfloat16)
                elif is_video:
                    with windows_weight_reads():
                        template = video.load(root, spec, data, control, contract)
                    control.stage("uploading")
                    placement = video.placement(template.components, policy, data, spec, video_device, device_backend)
                else:
                    with windows_weight_reads() if spec["family"] in ("qwen-image", "krea2") else contextlib.nullcontext():
                        template = getattr(diffusers, spec["pipeline"]).from_pretrained(str(root), **kwargs)
                    if spec["family"] == "krea2":
                        sibling("krea_adapter").configure(template)
                    if spec["family"] == "qwen-image":
                        encoder = template.text_encoder
                        encoder.set_attn_implementation("sdpa")
                        # This pipeline consumes only the final hidden state. Like
                        # Comfy's conditioning encoder, skip vocabulary logits,
                        # unused LM-head weights, KV cache and all intermediate states.
                        # Its task-local final-norm hook still selects pre-norm output.
                        encoder.lm_head = torch.nn.Identity()
                        def hidden_only(*args, **values):
                            values.update(output_hidden_states=False, use_cache=False)
                            mask = values.get("attention_mask")
                            if mask is not None and bool(mask.all()):
                                values["attention_mask"] = None
                            output = encoder.model(*args, **values)
                            return SimpleNamespace(hidden_states=(output.last_hidden_state,))
                        encoder.forward = hidden_only
                if spec["family"] in ("qwen-image", "moss-image") and policy == "offload":
                    placement = sibling("mapped_residency").Residency(template.components, policy, memory_pixels,
                        image_conditioned=conditioned, decode_pixels=render_pixels,
                        retain_components=spec["family"] == "moss-image", stream_mapped_dit=spec["family"] == "qwen-image")
                control.check()
                return template, placement
            except BaseException:
                if placement is not None:
                    placement.close()
                raise

        pipeline, identity, reused = cache.acquire(root, spec, data, policy, control,
            lambda path, task: {"sha256": fingerprint(path, task), "scope": "full-byte-chunk-sha256"},
            load_pipeline, Error, style_path=style_path,
            prepared_identity=lambda path, task: model_identity(path, data["modelId"], task,
                moss_weight_precision=data.get("mossWeightPrecision", "auto"),
                moss_text_precision=data.get("mossTextPrecision")))
        if spec["family"] in ("qwen-image", "moss-image", "krea2") and policy == "offload":
            cache.memory.plan(memory_pixels, image_conditioned=conditioned, control=control, decode_pixels=render_pixels)
        if is_video and hasattr(cache.memory, "plan_video"):
            cache.memory.plan_video(data, control)
        observation = {"adapter": data["modelId"], "validation": "待主力机验证", "modelSha256": identity["sha256"],
                       "modelIdentityScope": identity["scope"],
                       "memoryPolicy": policy, "weightReuse": reused,
                       "memoryScheduling": cache.memory.observation()}
        if style_path is not None:
            observation["styleLoraSha256"] = cache.style_identity
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
                observation["turboSteps"] = data["steps"]
                observation["h3VideoShift"] = data["h3VideoShift"]
                observation["h3AudioShift"] = 3
                observation["h3Decoder"] = getattr(pipeline.vae, "_huiyu_video_decoder", "original")
                observation["h3Conditioning"] = getattr(pipeline, "_huiyu_h3_conditioning", {})
                observation["h3Modulation"] = sibling("h3_modulation").begin(pipeline.transformer)
            observation["videoAcceleration"] = report
            rotary = sibling("h3_rotary").rotary(pipeline.transformer) if local_steps is not None else contextlib.nullcontext()
            with torch.inference_mode(), acceleration.attention(pipeline, control, report), rotary as rotary_stats:
                if rotary_stats is not None:
                    observation["h3Rotary"] = rotary_stats
                frames, soundtrack, sample_rate = video.generate(pipeline, spec, data, control, device=video_device,
                    image=images[0] if images else None, last_frame=images[1] if len(images) == 2 else None,
                    driving_video=job.get("drivingVideoPath"))
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
                    # Manga has already decoded, oriented and white-composited
                    # its single input. Qwen receives the same opaque RGBA image.
                    from PIL import Image
                    with Image.fromarray(manga_pixels) as source:
                        images.append(source.convert("RGBA"))
                args["image"] = images
                if reference_resolution is not None:
                    args["output_resolution"] = reference_resolution
        else:
            args["guidance_scale"] = data["cfg"]
            if spec["negative"]:
                args["negative_prompt"] = data["negativePrompt"]
        control.stage("encoding")
        use_prefix = policy == "offload" and spec["family"] == "qwen-image"
        branches = 2 if data["cfg"] > 1 and data["negativePrompt"] else 1
        attention = sibling("native_attention").inference_attention(spec["family"] in ("qwen-image", "moss-image"),
            compile_safe=spec["family"] == "moss-image" and data["mossCompile"],
            moss_int8=spec["family"] == "moss-image" and bool(getattr(pipeline.transformer, "_huiyu_int8_attention", False)))
        with torch.inference_mode(), sibling("qwen_prefix_cache").context(
                use_prefix, pipeline, branches, control, observation) as prefix, attention as backend:
            observation["attentionBackend"] = backend
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
            # The nested caller consumes exactly the validated, rounded PNG pixels.
            redraw = media.pixels(output.images[0], data, (3, 4), Error)
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
                        initialize=initialize, cancel_cleanup=resident.clear)
                finally:
                    resident.clear()
        return 0
    except Exception as exc:
        code = exc.code if isinstance(exc, lifecycle.WorkerError) else "NATIVE_ADAPTER_FAILED"
        emit(stream, None, "error", code=code, message=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
