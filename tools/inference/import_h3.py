"""Register the local FL2VA quantized release for native Diffusers inference."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import stat
import struct
import sys
import tempfile
import urllib.request


LIGHT_DECODER = "accelerators/lightvae-lite-h3-decoder-fp16.safetensors"


def convert_lightvae(source, target):
    """Create deterministic, directly mappable H3 decoder weights with bounded host memory."""
    import numpy as np

    norms = {"latents_mean", "latents_std", "norm1", "norm2", "norm_out", "scale1", "scale2"}
    with source.open("rb") as src, target.open("xb") as dest:
        size = struct.unpack("<Q", src.read(8))[0]
        if not 0 < size < 1024**2:
            raise ValueError("Invalid LightVAE header")
        header = json.loads(src.read(size))
        meta = header.pop("__metadata__")
        architecture = json.loads(meta["architecture"])
        if (meta.get("model_type") != "minimax_h3_pruned_vae" or len(header) != 203
                or architecture["kept_layers"] != [1, 3, 6, 9, 13, 16, 18, 21, 26, 27, 30, 34]):
            raise ValueError("Expected the released 12-layer MiniMax H3 Lite decoder")
        output = {"__metadata__": {"format": "pt", "model_type": "minimax_h3_pruned_vae"}}
        rows = sorted(header.items(), key=lambda pair: pair[1]["data_offsets"][0])
        cursor = offset = 0
        for key, row in rows:
            first, last = row["data_offsets"]
            count = math.prod(row["shape"])
            if row["dtype"] != "F32" or first != cursor or last - first != count * 4:
                raise ValueError(f"Invalid LightVAE source tensor: {key}")
            cursor = last
            fp32 = not norms.isdisjoint(key.split("."))
            end = offset + count * (4 if fp32 else 2)
            output[key] = dict(dtype="F32" if fp32 else "F16", shape=row["shape"], data_offsets=[offset, end])
            offset = end
        if 8 + size + cursor != source.stat().st_size:
            raise ValueError("Truncated LightVAE checkpoint")
        info = json.dumps(output, separators=(",", ":")).encode()
        info += b" " * (-len(info) % 8)
        dest.write(struct.pack("<Q", len(info)) + info)
        for key, row in rows:
            first, last = row["data_offsets"]
            left = last - first
            while left:
                data = src.read(min(left, 8 << 20))
                if not data:
                    raise OSError(f"Short LightVAE read: {key}")
                left -= len(data)
                if output[key]["dtype"] == "F16":
                    with np.errstate(over="raise", invalid="raise"):
                        dest.write(np.frombuffer(data, dtype="<f4").astype("<f2"))
                else:
                    dest.write(data)
        dest.flush()
        os.fsync(dest.fileno())


def read_catalog(name):
    return json.loads(Path(__file__).with_name(name).read_text(encoding="utf-8"))


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _ordinary(path, *, directory=False):
    info = path.lstat()
    if (getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
            or not (stat.S_ISDIR if directory else stat.S_ISREG)(info.st_mode)):
        raise ValueError(f"Expected an ordinary local {'directory' if directory else 'file'}: {path}")
    return info


def _accelerator_receipt(kind, rows):
    return dict(schemaVersion=1, modelId="minimax-h3", accelerator=kind, files=rows)


def _read_receipt(path):
    if _ordinary(path).st_size > 16 * 1024:
        raise ValueError(f"Oversized accelerator receipt: {path}")
    return json.loads(path.read_bytes())


def prepared_accelerators(root):
    """Recognize individually published, pinned optional assets under the model's identity lease."""
    root = Path(root)
    prepared = {}
    try:
        _ordinary(root / "accelerators", directory=True)
        specs = read_catalog("adapter-models.json")["models"]["minimax-h3"]["localPack"]["accelerators"]
    except (OSError, KeyError, ValueError):
        return prepared
    for kind, rows in specs.items():
        marker = root / "accelerators" / (kind + ".receipt")
        try:
            if _read_receipt(marker) != _accelerator_receipt(kind, rows):
                continue
            stamp = marker.stat().st_mtime_ns
            for row in rows:
                info = _ordinary(root / row["path"])
                if info.st_size != row["bytes"] or info.st_mtime_ns > stamp:
                    break
            else:
                prepared[kind] = rows
        except (OSError, ValueError):
            continue
    return prepared


def _verify(path, row):
    if _ordinary(path).st_size != row["bytes"] or digest(path) != row["sha256"]:
        raise ValueError(f"Accelerator differs from the pinned release: {path.name}")


def _publish_accelerator(root, directory, kind, rows):
    folder = root / "accelerators"
    folder.mkdir(exist_ok=True)
    _ordinary(folder, directory=True)
    marker = folder / (kind + ".receipt")
    receipt = _accelerator_receipt(kind, rows)
    if os.path.lexists(marker) and _read_receipt(marker) != receipt:
        raise FileExistsError(f"Unrecognized accelerator receipt: {marker}")
    with tempfile.TemporaryDirectory(prefix=".h3-accelerator-", dir=root.parent) as temp:
        staged = {}
        for row in rows:
            target = root / row["path"]
            if target.parent != folder:
                raise ValueError(f"Invalid accelerator path: {row['path']}")
            if os.path.lexists(target):
                _verify(target, row)
                staged[target] = target
                continue
            local = Path(temp) / target.name
            if row["path"] == LIGHT_DECODER:
                convert_lightvae(staged[root / rows[0]["path"]], local)
            else:
                source = directory / target.name
                if _ordinary(source).st_size != row["bytes"]:
                    raise ValueError(f"Incomplete accelerator source: {source}")
                try:
                    os.link(source, local)
                except OSError:
                    shutil.copyfile(source, local)
            _verify(local, row)
            staged[target] = local
        for row in rows:
            target = root / row["path"]
            if staged[target] != target:
                try:
                    os.link(staged[target], target)
                except FileExistsError:
                    _verify(target, row)
        # The receipt is the visibility boundary. Incomplete files can be
        # reused on the next invocation, but cannot select a partial decoder.
        temporary_marker = Path(temp) / marker.name
        temporary_marker.write_text(json.dumps(receipt, separators=(",", ":")), encoding="utf-8")
        temporary_marker.replace(marker)


def register_accelerators(source, models_root, apply):
    root = models_root / "minimax-h3"
    pack = read_catalog("adapter-models.json")["models"]["minimax-h3"]["localPack"]
    base = _read_receipt(root / "huiyu-model.json")
    if (base.get("modelId") != "minimax-h3" or base.get("representation") != pack["format"]
            or base.get("sourceRevision") != pack["revision"] or base.get("scope") != "converted-local-weights-sha256"):
        raise ValueError("These accelerators require the locally prepared H3 FL2VA Turbo model")
    specs = pack["accelerators"]
    installed = prepared_accelerators(root)
    found = [kind for kind, rows in specs.items()
             if kind in installed or (source / Path(rows[0]["path"]).name).is_file()]
    if not found:
        raise ValueError("No recognized H3 accelerator sources found")
    if apply:
        for kind in found:
            if kind not in installed:
                print(f"Preparing H3 {kind}", file=sys.stderr, flush=True)
                _publish_accelerator(root, source, kind, specs[kind])
        installed = prepared_accelerators(root)
        if any(kind not in installed for kind in found):
            raise OSError("H3 accelerator publication could not be verified")
    return dict(ok=True, preparedModel="minimax-h3", modelDir=str(root), available=found, installed=list(installed))


def register(source_root, models_root, apply, *, discover_dwd=False):
    model_id = "minimax-h3"
    pack = read_catalog("adapter-models.json")["models"][model_id]["localPack"]
    bundle = next(row for row in read_catalog("managed-adapter-models.json")["models"] if row["id"] == model_id)
    inputs = []
    for asset in pack["files"]:
        path = source_root / asset["source"]
        if asset.get("optional") and not path.exists():
            continue
        if not path.is_file() or path.stat().st_size != asset["bytes"] or not path.resolve().is_relative_to(source_root):
            raise ValueError(f"Missing or incomplete local checkpoint: {path}")
        inputs.append(asset)
    destination = models_root / model_id
    result = dict(modelDir=str(destination), preparedModel=model_id)
    if not apply:
        return dict(result, ok=True, sources=[a["source"] for a in inputs])
    if destination.exists():
        raise FileExistsError(f"Model directory already exists: {destination}")
    models_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".minimax-import-", dir=models_root) as temporary:
        stage = Path(temporary) / model_id
        stage.mkdir()
        files, sources = [], []
        for asset in inputs:
            source = source_root / asset["source"]
            target = stage / asset["path"]
            target.parent.mkdir(exist_ok=True)
            try:
                os.link(source, target)
            except OSError:
                if shutil.disk_usage(stage).free < asset["bytes"] + (128 << 20):
                    raise OSError("Insufficient space for a cross-volume model copy")
                shutil.copyfile(source, target)
            print(f"Validating {source.name}", file=sys.stderr, flush=True)
            if digest(target) != asset["sha256"]:
                raise ValueError(f"Checkpoint differs from the pinned release: {source.name}")
            props = dict(bytes=asset["bytes"], sha256=asset["sha256"])
            sources.append(dict(path=asset["source"], **props))
            files.append(dict(path=asset["path"], **props))
        cached = {}
        config_files = {row["path"]: row for row in bundle["files"]}
        for name in pack["configs"]:
            asset = config_files[name]
            target = stage / name
            target.parent.mkdir(exist_ok=True)
            sha = asset["sha256"]
            if sha in cached:
                try:
                    os.link(cached[sha], target)
                except OSError:
                    shutil.copyfile(cached[sha], target)
            else:
                with urllib.request.urlopen(asset["url"], timeout=45) as response, target.open("xb") as stream:
                    data = response.read(asset["bytes"] + 1)
                    if len(data) != asset["bytes"] or hashlib.sha256(data).hexdigest() != sha:
                        raise ValueError(f"Official config integrity check failed: {name}")
                    stream.write(data)
                cached[sha] = target
            files.append(dict(path=name, bytes=asset["bytes"], sha256=sha))
        receipt = dict(schemaVersion=1, modelId=model_id, revision=bundle["revision"],
                       scope="converted-local-weights-sha256", representation=pack["format"],
                       sourceRevision=pack["revision"], sources=sources, files=files)
        (stage / "huiyu-model.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
        if discover_dwd:
            rows = pack["accelerators"]["dwd"]
            folder = source_root / "loras"
            if (folder / Path(rows[0]["path"]).name).is_file():
                try:
                    _publish_accelerator(stage, folder, "dwd", rows)
                    result["h3Dwd"] = True
                except (ValueError, OSError) as exc:
                    # Optional discovery during a base import must not strand a usable Turbo pack.
                    # The explicit --accelerators import surfaces verification errors to the caller.
                    print(f"Skipping optional pi-H3 DWD: {exc}", file=sys.stderr, flush=True)
        stage.rename(destination)
    return dict(result, ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--comfy-models", type=Path)
    source.add_argument("--accelerators", type=Path, help="Directory with optional author-released H3 checkpoints")
    parser.add_argument("--models-root", type=Path, required=True)
    parser.add_argument("--discover-dwd", action="store_true", help="Also import a verified pi-H3 DWD adapter from ComfyUI/models/loras on initial setup")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        if args.accelerators:
            result = register_accelerators(args.accelerators.resolve(), args.models_root.resolve(), args.apply)
        else:
            result = register(args.comfy_models.resolve(), args.models_root.resolve(), args.apply, discover_dwd=args.discover_dwd)
        print(json.dumps(result))
    except (OSError, ValueError, KeyError, FloatingPointError) as exc:
        parser.exit(1, f"{exc}\n")
