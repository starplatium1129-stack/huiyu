"""Dependency probing and local model identity checks for native adapters."""
from __future__ import annotations

from collections import deque
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import hashlib
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
from huiyu_worker_lifecycle import load_sibling as sibling


contract = sibling("adapter_contract")
media = sibling("adapter_media")
Error = contract.AdapterError
MODEL_SUFFIXES = {".json", ".safetensors", ".model", ".txt", ".jinja"}


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
    if model.get("packedManga"):
        raise Error("MODEL_CHANGED", "QWEN-Manga 模型文件或准备凭据已变化，请在控制室重新准备")
    return {"sha256": fingerprint(root, control), "scope": "full-byte-chunk-sha256"}
