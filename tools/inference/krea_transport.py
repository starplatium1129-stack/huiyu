"""Transport Krea's original packed weights, then restore the prepared BF16 values on CUDA."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import sys
import tempfile


# Comfy-Org/Krea-2, diffusion_models/krea2_turbo_fp8_scaled.safetensors
SOURCE_SHA256 = "eb4dd8c612cfd10f64f25b057e6e6bbcb5737c94a7372177e456dbf7579502f1"
SOURCE_BYTES = 13_141_730_784
DIRECTORY = ".huiyu-krea-transport"
PACKED = "transformer.fp8"
TEXT_DIRECTORY = ".huiyu-krea-text-transport"
TEXT_PACKED = "text_encoder.fp8"
TEXT_SHA256 = "7443c2b8df026a3271b3095d5d1dc07800dc5cf460b6e3586692253c7a7bc17c"
TEXT_BYTES = 4_831_492_476
RECEIPT = "receipt"


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


def _base(root, component):
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
    _regular(root / component, directory=True)
    return digest, components[component]["files"]


def _asset(component):
    if component == "text_encoder":
        return TEXT_DIRECTORY, TEXT_PACKED, TEXT_BYTES, TEXT_SHA256
    return DIRECTORY, PACKED, SOURCE_BYTES, SOURCE_SHA256


def _receipt(root, folder, component, base_digest, shards):
    _regular(folder, directory=True)
    _, name, size, digest = _asset(component)
    return dict(schemaVersion=1, sourceSha256=digest, conversionSha256=base_digest,
                packedFile=_stamp(folder / name, size),
                baseFiles={name: _stamp(root / component / name, row["bytes"]) for name, row in shards.items()})


def prepared(root, component="transformer"):
    """A readiness hint. Reading packed bytes for inference also requires a live whole-tree lease."""
    root = Path(root)
    folder = root / _asset(component)[0]
    try:
        _regular(folder, directory=True)
        record = _json(folder / RECEIPT)
        return record == _receipt(root, folder, component, *_base(root, component))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def prepare(root, source, component="transformer"):
    from native_hash import file_sha256

    root = Path(root).resolve(strict=True)
    digest, shards = _base(root, component)
    directory, name, size, expected = _asset(component)
    destination = root / directory
    if prepared(root, component):
        return destination
    if os.path.lexists(destination):
        raise FileExistsError(f"An unrecognized transport already exists: {destination}")
    source = Path(source).absolute()
    _stamp(source, size)
    # Publish both files together. A failed hash, cross-volume link or concurrent
    # installer leaves the current model and the original checkpoint intact.
    with tempfile.TemporaryDirectory(prefix=".krea-transport-", dir=root.parent) as temp:
        stage = Path(temp) / directory
        stage.mkdir()
        packed = stage / name
        os.link(source, packed, follow_symlinks=False)
        before = _receipt(root, stage, component, digest, shards)
        if file_sha256(packed) != expected:
            raise ValueError(f"The original Krea {component} FP8 checksum differs from the registered release")
        for name, row in shards.items():
            if file_sha256(root / component / name) != row["sha256"]:
                raise ValueError(f"Converted Krea shard checksum differs: {name}")
        if before != _receipt(root, stage, component, *_base(root, component)):
            raise OSError("Krea weights changed during preparation")
        (stage / RECEIPT).write_text(json.dumps(before, separators=(",", ":")), encoding="utf-8")
        stage.rename(destination)
    return destination


class Transport:
    def __init__(self, entries):
        self.entries = entries
        self.packed_count = 0
        self.block_count = sum(name.startswith("transformer_blocks.") for name in entries)
        self.hooks = []
        self.report = dict(uploads=0, packedBytes=0, fp8GemmCalls=0, fp8InputHits=0, fusedInputPacks=0)

    def pack_blocks(self, transformer):
        """Keep base weights packed, including the base_layer inside a PEFT adapter."""
        import torch

        functional = torch.nn.functional
        use_fp8 = torch.cuda.get_device_capability(0) >= (8, 9) and (
            hasattr(functional, "scaled_mm") or hasattr(torch, "_scaled_mm"))
        report = self.report
        packer = None
        if use_fp8:
            from huiyu_worker_lifecycle import load_sibling
            try:
                packer = load_sibling("krea_fp8").PackedKernels()
            except (ImportError, OSError):
                pass

        def quantize(value):
            rows = value.reshape(-1, value.shape[-1])
            lo, hi = torch.aminmax(rows)
            scale = torch.maximum(-lo, hi).float().clamp_min_(1e-12) / 448
            if packer is not None:
                packed = packer.pack(rows, scale)
                if packed is not None:
                    report["fusedInputPacks"] += 1
                    return packed
            return (rows / scale).clamp_(-448, 448).to(torch.float8_e4m3fn), scale

        class ProjectionInputs:
            # Only siblings within this attention/FF call read the same unchanged
            # activation. PEFT can pass a different tensor to its base layer.
            source = packed = None

            def __init__(self, consumers):
                self.consumers = consumers

            def enter(self, _module, args):
                self.source = args[0] if args and torch.is_inference_mode_enabled() else None
                self.packed = None
                self.remaining = self.consumers

            def clear(self, *_args):
                self.source = self.packed = None

            def get(self, value):
                if value is not self.source:
                    return quantize(value)
                if self.packed is None:
                    self.packed = quantize(value)
                else:
                    report["fp8InputHits"] += 1
                result = self.packed
                self.remaining -= 1
                if self.remaining == 0:
                    self.clear()
                return result

        class PackedLinear(torch.nn.Linear):
            inputs = None
            _huiyu_packed_linear = True

            def __init__(self, linear, packed, scale, fast):
                torch.nn.Module.__init__(self)
                self.in_features, self.out_features = linear.in_features, linear.out_features
                self.weight = torch.nn.Parameter(packed, requires_grad=False)
                self.bias, self.scale = linear.bias, scale
                self.training = linear.training
                self.fast = use_fp8 and fast
                if self.fast:
                    self.register_buffer("weight_scale", torch.tensor(scale, dtype=torch.float32))

            def forward(self, value):
                if self.fast and value.is_cuda and value.dtype == torch.bfloat16:
                    packed, scale = (self.inputs.get(value) if self.inputs is not None
                                     else quantize(value))
                    try:
                        if hasattr(functional, "scaled_mm"):
                            recipe = functional.ScalingType.TensorWise
                            out = functional.scaled_mm(packed, self.weight.t(), scale, recipe,
                                self.weight_scale, recipe, bias=self.bias, output_dtype=value.dtype)
                        else:
                            out = torch._scaled_mm(packed, self.weight.t(), scale_a=scale,
                                scale_b=self.weight_scale, bias=self.bias, out_dtype=value.dtype)
                    except RuntimeError as exc:
                        message = str(exc).lower().replace("_", " ")
                        if not isinstance(exc, NotImplementedError) and not any(
                                s in message for s in ("not supported", "not implemented", "unsupported")):
                            raise
                        self.fast = False
                    else:
                        report["fp8GemmCalls"] += 1
                        return out.reshape(*value.shape[:-1], self.out_features)
                # Identical two roundings to upload(): E4M3 to BF16 first,
                # then multiply by the converter's BF16-rounded scale.
                weight = packer.expand(self.weight, self.scale) if packer is not None else None
                if weight is None:
                    weight = self.weight.to(torch.bfloat16).mul_(self.scale)
                return torch.nn.functional.linear(value, weight, self.bias)

        for path, (packed, scale, fast) in self.entries.items():
            parent_name, _, attr = path.rpartition(".")
            parent = transformer.get_submodule(parent_name)
            layer = getattr(parent, attr)
            if hasattr(layer, "get_base_layer"):
                parent, attr, layer = layer, "base_layer", layer.get_base_layer()
            if type(layer) is not torch.nn.Linear or tuple(packed.shape) != (layer.out_features, layer.in_features):
                raise ValueError(f"Krea packed projection no longer matches {path}")
            setattr(parent, attr, PackedLinear(layer, packed, scale, fast))
            self.packed_count += 1
        self.entries.clear()
        for block in getattr(transformer, "transformer_blocks", ()):
            for owner, names in ((block.attn, ("to_q", "to_k", "to_v", "to_gate")), (block.ff, ("gate", "up"))):
                projections = [getattr(owner, attr) for attr in names]
                bases = [p.get_base_layer() if hasattr(p, "get_base_layer") else p for p in projections]
                shared = [p for p in bases if isinstance(p, PackedLinear) and p.fast]
                if len(shared) < 2:
                    continue
                inputs = ProjectionInputs(len(shared))
                for p in shared:
                    p.inputs = inputs
                self.hooks.append(owner.register_forward_pre_hook(inputs.enter))
                self.hooks.append(owner.register_forward_hook(inputs.clear, always_call=True))

    def close(self):
        for handle in self.hooks:
            handle.remove()
        self.hooks.clear()
        self.entries.clear()


def load_packed(root, component, module, control):
    """Called only under the verified conversion lease. Never open the converted DiT shards."""
    import torch
    from diffusers.loaders.single_file_utils import convert_krea2_transformer_checkpoint_to_diffusers as convert
    from huiyu_worker_lifecycle import load_sibling

    directory, name, _, _ = _asset(component)
    dit = component == "transformer"
    state, entries = {}, {}
    with load_sibling("mapped_weights").ReadOnlyWeights(root / directory / name) as reader:
        layouts = json.loads(reader.meta["_quantization_metadata"])["layers"]
        if dit:
            # The pinned converter also reshapes the BF16 modulation tables. Only
            # data pointers change: those small weights are already in the original.
            originals = {key: reader.get_tensor(key) for key in reader.keys() if not key.endswith(".weight_scale")}
            weights = convert(originals)
            names = convert({key: key for key in reader.keys() if reader.header[key]["dtype"] == "F8_E4M3"})
        else:
            names = {key: "model." + key.removeprefix("language_model.") for key in module.state_dict()}
            weights = {key: reader.get_tensor(original) for key, original in names.items()}
        for dest, weight in weights.items():
            control.check()
            if weight.dtype == torch.bfloat16:
                # Krea RMSNorm evaluates 1 + weight before multiplying the
                # FP32 activation. Its pinned loader promotes the scale first.
                keep_fp32 = dit and any(part in module._keep_in_fp32_modules for part in dest.split("."))
                state[dest] = weight.float() if keep_fp32 else weight
                continue
            original = names[dest].removesuffix(".weight")
            scale = reader.get_tensor(original + ".weight_scale")
            layout = layouts[original]
            if (weight.dtype != torch.float8_e4m3fn or weight.ndim != 2 or not dest.endswith(".weight")
                    or scale.ndim != 0 or scale.dtype != torch.float32 or layout["format"] != "float8_e4m3fn"):
                raise ValueError(f"Invalid Krea packed matrix {dest}")
            rounded = scale.to(torch.bfloat16).item()
            if not math.isfinite(rounded) or rounded <= 0:
                raise ValueError(f"Invalid Krea packed scale {dest}")
            # CPU shape/dtype metadata lets PEFT install and validate A/B matrices
            # in BF16 before the packed base is attached. No dense BF16 storage.
            state[dest] = torch.empty((), dtype=torch.bfloat16).expand(weight.shape)
            fast = dest.startswith("transformer_blocks.") and not layout.get("full_precision_matrix_mult", False)
            entries[dest.removesuffix(".weight")] = (weight, rounded, fast)
    if dit and len(entries) != 256:
        raise ValueError("Incomplete Krea FP8 transformer")
    module.load_state_dict(state, strict=True, assign=True)
    transport = Transport(entries)
    if dit:
        module._huiyu_transport = transport
    else:
        transport.pack_blocks(module)
        module._huiyu_packed_text_layers = transport.packed_count
    return module.eval()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--text-source", type=Path)
    parser.add_argument("--apply", action="store_true", help="Verify and hard-link the optional local transport")
    args = parser.parse_args()
    if args.apply and not (args.source or args.text_source):
        parser.error("--apply requires --source or --text-source")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        if args.apply and args.source:
            prepare(args.model_dir, args.source)
        if args.apply and args.text_source:
            prepare(args.model_dir, args.text_source, "text_encoder")
        print(json.dumps(dict(ok=True, prepared=prepared(args.model_dir), textPrepared=prepared(args.model_dir, "text_encoder"),
                              modelDir=str(args.model_dir))))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps(dict(ok=False, error=str(error))), file=sys.stderr)
        sys.exit(1)
