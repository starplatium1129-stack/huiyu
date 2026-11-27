"""Preview or atomically import a pinned Krea 2 ConvRot checkpoint using only the CPU."""
import argparse
from collections import Counter
import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import worker_lifecycle
    sys.path.pop(0)
    sys.modules["huiyu_worker_lifecycle"] = worker_lifecycle
from huiyu_worker_lifecycle import load_sibling

packed = load_sibling("krea_int8")
contract = load_sibling("adapter_contract")
SCOPE = "local-krea-int8-convrot"
CONVERTED = "b71ca17405a63fd1dcf3a0fca812c84d64be1a2b210f7cbe187ba69bb39d0669"
MARKER = "huiyu-model.json"
COMMON = {"scheduler/scheduler_config.json", "text_encoder/config.json", "transformer/config.json",
          "vae/config.json", "vae/diffusion_pytorch_model.safetensors", "tokenizer/tokenizer_config.json",
          "tokenizer/tokenizer.json", "tokenizer/chat_template.jinja"}


def ordinary(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ValueError(f"Expected an ordinary local file: {path}")
    return path


def names(root):
    parts = set(COMMON)
    idx = root / "text_encoder/model.safetensors.index.json"
    if idx.exists():
        mapping = contract.config(root, idx)["weight_map"]
        if not isinstance(mapping, dict) or not mapping:
            raise ValueError("Empty text encoder index")
        parts.add(idx.relative_to(root).as_posix())
        for shard in set(mapping.values()):
            if not isinstance(shard, str) or Path(shard).name != shard or any(c in shard for c in "/\\:") or not shard.endswith(".safetensors"):
                raise ValueError("Invalid text encoder shard name")
            parts.add("text_encoder/" + shard)
    else:
        parts.add("text_encoder/model.safetensors")
    return sorted(parts)


def pipeline_index(tokenizer):
    if tokenizer not in ("Qwen2Tokenizer", "Qwen2TokenizerFast"):
        raise ValueError("Expected the Krea 2 Qwen tokenizer")
    return {"_class_name": "Krea2Pipeline", "patch_size": 2, "is_distilled": True,
            "text_encoder_select_layers": list(range(2, 36, 3)),
            "scheduler": ["diffusers", "FlowMatchEulerDiscreteScheduler"],
            "text_encoder": ["transformers", "Qwen3VLModel"], "tokenizer": ["transformers", tokenizer],
            "transformer": ["diffusers", "Krea2Transformer2DModel"], "vae": ["diffusers", "AutoencoderKLQwenImage"]}


def rows_for(root, paths, check=None):
    values = []
    for name in paths:
        path = ordinary(contract.safe_file(root, root / name))
        values.append((name, path.stat().st_size, load_sibling("native_hash").file_sha256(path, check=check)))
    return values


def git_blob(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def shared_source(root, rows):
    if packed.digest(rows) == CONVERTED:
        return "prepared-krea2-turbo"
    registry = contract.document(Path(__file__).with_name("managed-adapter-models.json"))
    for base in registry["models"]:
        if base["id"] not in ("krea2-raw", "krea2-turbo"):
            continue
        official = {item["path"]: item for item in base["files"]}
        for name, size, sha in rows:
            item = official.get(name, {})
            if item.get("bytes") != size:
                break
            if sha == item.get("sha256"):
                continue
            # Gated HF manifests pin Git object IDs, including the LFS pointer.
            pointer = f"version https://git-lfs.github.com/spec/v1\noid sha256:{sha}\nsize {size}\n".encode()
            expected = item.get("gitBlobId")
            if git_blob(pointer) != expected and (size > 32 << 20 or git_blob((root / name).read_bytes()) != expected):
                break
        else:
            return base["id"]
    raise ValueError("Shared components do not match the registered Krea 2 Turbo/Raw assets")


def document(root, model_id, check=None):
    spec = contract.model(model_id)
    asset = spec["kreaInt8"]
    packed_path = ordinary(contract.safe_file(root, root / packed.PACKED))
    if packed_path.stat().st_size != asset["bytes"]:
        raise ValueError("Incorrect Krea ConvRot checkpoint length")
    parts = names(root)
    expected_files = {*parts, packed.PACKED, "model_index.json", MARKER}
    for folder, dirs, files in os.walk(root, followlinks=False):
        for directory in dirs:
            path = Path(folder) / directory
            if path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError(f"Linked model directory: {directory}")
        for file in files:
            if (Path(folder) / file).relative_to(root).as_posix() not in expected_files:
                raise ValueError(f"Unexpected model asset: {file}")
    index = contract.config(root, root / "model_index.json")
    if index != pipeline_index(index["tokenizer"][1]):
        raise ValueError("Unexpected Krea sampling or pipeline components")
    shared = rows_for(root, parts, check)
    base = shared_source(root, shared)
    files = [*shared, *rows_for(root, ("model_index.json", packed.PACKED), check)]
    if files[-1][2] != asset["sha256"]:
        raise ValueError("Krea ConvRot full SHA-256 does not match the publisher")
    return {"schemaVersion": 1, "scope": SCOPE, "modelId": model_id, "revision": spec["revision"], "base": base,
            "checkpoint": asset, "componentsSha256": packed.digest(files),
            "files": [{"path": name, "bytes": size, "sha256": sha} for name, size, sha in files]}


def identity(root, model_id, control):
    actual = contract.config(root, root / MARKER)
    verified = document(root, model_id, control.check)
    if verified != actual:
        raise ValueError("Krea ConvRot import receipt does not match local files")
    return {"sha256": verified["componentsSha256"], "scope": SCOPE}


def link_or_copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, target)
    except OSError as error:
        if error.errno != errno.EXDEV and getattr(error, "winerror", None) != 17:
            raise
        shutil.copyfile(source, target)


def inspect_source(source):
    source = ordinary(source.absolute())
    with load_sibling("mapped_weights").ReadOnlyWeights(source, framework="metadata") as reader:
        keys = reader.keys()
        sample = next((name for name in keys if name.endswith(".comfy_quant")), None)
        result = {"bytes": source.stat().st_size, "tensors": len(keys),
                  "dtypes": dict(Counter(reader.header[k]["dtype"] for k in keys)),
                  "sampleKey": keys[0] if keys else None, "quantMetadataKey": sample}
        if sample:
            start, end = reader.header[sample]["data_offsets"]
            if reader.header[sample]["dtype"] == "U8" and 0 < end - start <= 4096:
                result["quantMetadata"] = reader.mapping[reader.offset + start:reader.offset + end].decode("utf-8", "replace")
        try:
            result["structure"] = packed.inspect_weights(reader)
        except (ValueError, KeyError) as exc:
            result["unsupportedLayout"] = str(exc)
        return result


def prepare(model_id, source, base, destination, apply):
    spec = contract.model(model_id)
    asset = spec["kreaInt8"]
    source = ordinary(source.absolute())
    if source.stat().st_size != asset["bytes"]:
        raise ValueError(f"Expected {asset['bytes']} bytes in {asset['filename']}")
    with load_sibling("mapped_weights").ReadOnlyWeights(source, framework="metadata") as reader:
        info = packed.inspect_weights(reader)
    if not apply:
        sha = load_sibling("native_hash").file_sha256(source)
        if sha != asset["sha256"]:
            raise ValueError("Krea ConvRot full SHA-256 mismatch")
        return dict(modelId=model_id, bytes=asset["bytes"], sha256=sha, structure=info, applied=False)
    if base is None or destination is None:
        raise ValueError("--apply needs --base-dir and --models-root")
    base, destination = base.resolve(strict=True), destination.resolve() / model_id
    if destination.exists():
        # Repeated imports verify both the supplied bytes and the installed bundle.
        installed = ordinary(contract.safe_file(destination, destination / packed.PACKED))
        if not source.samefile(installed) and load_sibling("native_hash").file_sha256(source) != asset["sha256"]:
            raise ValueError("Input checkpoint SHA-256 mismatch")
        verified = document(destination, model_id)
        if contract.config(destination, destination / MARKER) != verified:
            raise ValueError("Existing destination has a different receipt")
        return dict(preparedModel=model_id, installed=str(destination), receipt=verified, reused=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".krea-import-", dir=destination.parent) as temp:
        stage = Path(temp) / "bundle"
        for name in names(base):
            link_or_copy(ordinary(contract.safe_file(base, base / name)), stage / name)
        link_or_copy(source, stage / packed.PACKED)
        base_index = contract.config(base, base / "model_index.json")
        index = pipeline_index(base_index["tokenizer"][1])
        for key, value in index.items():
            if key != "is_distilled" and base_index.get(key) != value:
                raise ValueError(f"Unexpected shared Krea pipeline setting: {key}")
        (stage / "model_index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
        receipt = document(stage, model_id)
        contract.layout(str(stage), spec)
        (stage / MARKER).write_text(json.dumps(receipt, indent=2), encoding="utf-8")
        stage.rename(destination)
    return dict(preparedModel=model_id, installed=str(destination), receipt=receipt, structure=info, reused=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-id", choices=[k for k, v in contract.MANIFEST["models"].items() if "kreaInt8" in v])
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--base-dir", type=Path, help="Installed Krea 2 Turbo or Raw with its shared components")
    parser.add_argument("--models-root", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--inspect", action="store_true", help="Inspect a local checkpoint header without a registered model or GPU")
    args = parser.parse_args()
    try:
        if args.inspect:
            print(json.dumps(inspect_source(args.source)))
        elif args.model_id:
            print(json.dumps(prepare(args.model_id, args.source, args.base_dir, args.models_root, args.apply)))
        else:
            parser.error("Use --inspect or select a registered --model-id")
    except (ValueError, OSError, KeyError, contract.AdapterError) as exc:
        parser.exit(1, f"{exc}\n")
