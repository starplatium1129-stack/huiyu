"""Transport Krea's original packed weights, then restore the prepared BF16 values on CUDA."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile


# Comfy-Org/Krea-2, diffusion_models/krea2_turbo_fp8_scaled.safetensors
SOURCE_SHA256 = "eb4dd8c612cfd10f64f25b057e6e6bbcb5737c94a7372177e456dbf7579502f1"
SOURCE_BYTES = 13_141_730_784
DIRECTORY = ".huiyu-krea-transport"
PACKED = "transformer.fp8"
RECEIPT = "receipt"
CHUNK = 32 * 1024**2


def _regular(path, *, directory=False):
    info = path.lstat()
    if (getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
            or not (stat.S_ISDIR if directory else stat.S_ISREG)(info.st_mode)):
        raise ValueError(f"Expected an ordinary local {'directory' if directory else 'file'}: {path}")
    return info


def _json(path):
    if _regular(path).st_size > 1024**2:
        raise ValueError(f"Oversized metadata: {path}")
    record = json.loads(path.read_bytes())
    if not isinstance(record, dict):
        raise ValueError(f"Invalid metadata: {path}")
    return record


def _stamp(path, size):
    info = _regular(path)
    if info.st_size != size or not info.st_ino:
        raise ValueError(f"Weight size or local file identity differs: {path}")
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]


def _base(root):
    marker = root / "huiyu-model.json"
    record = _json(marker)
    if (record.get("modelId") != "krea2-turbo" or record.get("schemaVersion") != 1
            or record.get("scope") != "local-fp8-dequantized-bf16"):
        raise ValueError("This transport requires the prepared local Krea 2 Turbo conversion")
    models = _json(Path(__file__).with_name("adapter-models.json"))
    expected = models["models"]["krea2-turbo"]["localConversionComponentsSha256"]
    components = record["components"]
    digest = hashlib.sha256(json.dumps(components, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if digest != expected:
        raise ValueError("Krea's converted weights do not match the trusted recipe")
    _regular(root / "transformer", directory=True)
    return digest, components["transformer"]["files"]


def _receipt(root, folder, base_digest, shards):
    _regular(folder, directory=True)
    return dict(schemaVersion=1, sourceSha256=SOURCE_SHA256, conversionSha256=base_digest,
                packedFile=_stamp(folder / PACKED, SOURCE_BYTES),
                baseFiles={name: _stamp(root / "transformer" / name, row["bytes"]) for name, row in shards.items()})


def prepared(root):
    """A readiness hint. Reading packed bytes for inference also requires a live whole-tree lease."""
    root = Path(root)
    folder = root / DIRECTORY
    try:
        _regular(folder, directory=True)
        record = _json(folder / RECEIPT)
        return record == _receipt(root, folder, *_base(root))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def prepare(root, source):
    from native_hash import file_sha256

    root = Path(root).resolve(strict=True)
    digest, shards = _base(root)
    destination = root / DIRECTORY
    if prepared(root):
        return destination
    if os.path.lexists(destination):
        raise FileExistsError(f"An unrecognized transport already exists: {destination}")
    source = Path(source).absolute()
    _stamp(source, SOURCE_BYTES)
    # Publish both files together. A failed hash, cross-volume link or concurrent
    # installer leaves the current model and the original checkpoint intact.
    with tempfile.TemporaryDirectory(prefix=".krea-transport-", dir=root.parent) as temp:
        stage = Path(temp) / DIRECTORY
        stage.mkdir()
        packed = stage / PACKED
        os.link(source, packed, follow_symlinks=False)
        before = _receipt(root, stage, digest, shards)
        if file_sha256(packed) != SOURCE_SHA256:
            raise ValueError("The original Krea FP8 checksum differs from the Comfy-Org release")
        for name, row in shards.items():
            if file_sha256(root / "transformer" / name) != row["sha256"]:
                raise ValueError(f"Converted Krea shard checksum differs: {name}")
        if before != _receipt(root, stage, *_base(root)):
            raise OSError("Krea weights changed during preparation")
        (stage / RECEIPT).write_text(json.dumps(before, separators=(",", ":")), encoding="utf-8")
        stage.rename(destination)
    return destination


class Transport:
    def __init__(self, entries, file):
        self.entries = entries
        self.file = file
        self.report = dict(layers=len(entries), uploads=0, packedBytes=0)

    def upload(self, source, raw_upload):
        """Pack only the transfer. The existing nn.Linear always receives its normal BF16 matrix."""
        import torch

        if source.device.type != "cpu" or source.dtype != torch.bfloat16:
            return None
        row = self.entries.get(source.data_ptr())
        if row is None:
            return None
        base, packed, scale = row
        if source.shape != base.shape or not source.is_contiguous():
            return None
        target = torch.empty_like(source, device="cuda:0")
        result = target.view(-1)
        packed = packed.view(-1)
        for start in range(0, packed.numel(), CHUNK):
            end = min(start + CHUNK, packed.numel())
            # Keep the extra CUDA allocation bounded. copy_ performs exactly the
            # E4M3 -> BF16 cast; multiply separately using the BF16-rounded scale.
            result[start:end].copy_(raw_upload(packed[start:end]))
            result[start:end].mul_(scale)
        self.report["uploads"] += 1
        self.report["packedBytes"] += packed.numel()
        return target

    def close(self):
        self.entries.clear()
        self.file.close()


def open_transport(root, transformer, *, identity, protection):
    """Bind known BF16 base parameters after PEFT installation and before GPU placement."""
    if protection is None or identity.get("scope") != "prepared-local-weights" or not prepared(root):
        return None
    try:
        import torch
        from diffusers.loaders.single_file_utils import convert_krea2_transformer_checkpoint_to_diffusers
        from huiyu_worker_lifecycle import load_sibling

        reader = load_sibling("mapped_weights").ReadOnlyWeights(Path(root) / DIRECTORY / PACKED)
        with reader:
            # The pinned Diffusers conversion only renames the 2D FP8 matrices;
            # the separately reshaped modulation tables are already native BF16.
            packed_names = {name: name for name in reader.keys() if reader.header[name]["dtype"] == "F8_E4M3"}
            renamed = convert_krea2_transformer_checkpoint_to_diffusers(packed_names)
            entries = {}
            for dest, original in renamed.items():
                if not dest.endswith(".weight") or not original.endswith(".weight"):
                    return None
                layer = transformer.get_submodule(dest.removesuffix(".weight"))
                if getattr(layer, "merged", False):
                    return None
                if hasattr(layer, "get_base_layer"):
                    layer = layer.get_base_layer()
                packed = reader.get_tensor(original)
                scale = reader.get_tensor(original.removesuffix(".weight") + ".weight_scale")
                weight = layer.weight
                if (not isinstance(layer, torch.nn.Linear) or weight.device.type != "cpu"
                        or weight.dtype != torch.bfloat16 or not weight.is_contiguous()
                        or weight.ndim != 2 or weight.shape != packed.shape
                        or scale.ndim != 0 or scale.dtype != torch.float32):
                    return None
                # The local converter first rounded the file's F32 scale to BF16.
                rounded = scale.to(torch.bfloat16).item()
                if not math.isfinite(rounded) or rounded <= 0:
                    return None
                entries[weight.data_ptr()] = (weight.detach(), packed, rounded)
            if len(entries) != 256:
                return None
            return Transport(entries, reader.file)
    except (OSError, ValueError, KeyError, AttributeError, TypeError, ImportError, struct.error):
        return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--apply", action="store_true", help="Verify and hard-link the optional local transport")
    args = parser.parse_args()
    if args.apply and args.source is None:
        parser.error("--apply requires --source")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        if args.apply:
            prepare(args.model_dir, args.source)
        print(json.dumps(dict(ok=True, prepared=prepared(args.model_dir), modelDir=str(args.model_dir))))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps(dict(ok=False, error=str(error))), file=sys.stderr)
        sys.exit(1)
