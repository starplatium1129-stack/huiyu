"""Inspect and bind Krea 2 W8A8 ConvRot matrices without expanding the DiT."""
import hashlib
import json
import math
import re
import struct
from collections import Counter
from huiyu_worker_lifecycle import load_sibling


PACKED = "transformer/diffusion_pytorch_model.safetensors"
# SHA-256 of sorted [unprefixed key, dtype, shape] in the reviewed release.
# Diffusers' pinned converter reshapes the per-block modulation table to [6, 6144].
SCHEMAS = {"original": "4ef14d323d5b5ba03dbfd6f263f1b5a6fdd2cd5c82e3c1b79f404f2f03e7f57a",
           "diffusers": "893d26e91373d9022790a418ab6c02c7f4c9d2d961c10765188ebd1e2a4e6b03"}


def digest(rows):
    return hashlib.sha256(json.dumps(sorted(rows), separators=(",", ":")).encode()).hexdigest()


def inspect_weights(reader, check=None):
    keys = reader.keys()
    prefix = next((p for p in ("model.diffusion_model.", "diffusion_model.", "transformer.")
                   if all(k.startswith(p) for k in keys)), "")
    rows = [(k[len(prefix):], reader.header[k]["dtype"], reader.header[k]["shape"]) for k in keys]
    schema = "diffusers" if any(k.startswith("transformer_blocks.") for k, _, _ in rows) else "original"
    if digest(rows) != SCHEMAS[schema]:
        raise ValueError(f"Unrecognized Krea ConvRot keys, dtypes or shapes ({schema}, {len(rows)} tensors)")
    floats = Counter()
    quantized = 0
    for key in keys:
        entry = reader.header[key]
        if key.endswith(".weight_scale"):
            continue
        if entry["dtype"] in ("BF16", "F32"):
            family = re.sub(r"\.\d+(?=\.)", ".*", key[len(prefix):])
            floats[(entry["dtype"], family)] += 1
        if entry["dtype"] != "I8":
            continue
        if check:
            check()
        parent = key.removesuffix(".weight")
        def data(name):
            start, end = reader.header[parent + name]["data_offsets"]
            return reader.mapping[reader.offset + start:reader.offset + end]
        meta = json.loads(data(".comfy_quant"), object_pairs_hook=load_sibling("mapped_weights").unique_object)
        if (not isinstance(meta, dict) or meta.get("convrot") is not True or meta.get("per_row") is not True
                or type(meta.get("convrot_groupsize")) is not int or meta["convrot_groupsize"] != 256):
            raise ValueError(f"Unsupported rotation or scale metadata at {parent}")
        if any(not math.isfinite(v) or v < 0 for (v,) in struct.iter_unpack("<f", data(".weight_scale"))):
            raise ValueError(f"Non-finite or negative weight scale at {parent}")
        quantized += 1
    return {"prefix": prefix, "layout": schema, "matrices": quantized, "groupSize": 256, "perRow": True,
            "floating": {d: {k: n for (kind, k), n in sorted(floats.items()) if kind == d} for d in ("F32", "BF16")}}


class Int8Transport:
    def __init__(self, entries, backend, host_time):
        self.entries = entries
        self.backend = backend
        self.host_time = host_time
        self.block_count = len(entries)
        self.packed_count = 0
        self.report = dict(uploads=0, packedBytes=0, int8GemmCalls=0)

    def pack_blocks(self, transformer, check=None):
        if not self.entries:
            return
        import torch
        base = load_sibling("moss_int8").linear_class(self.backend)
        stats = self.report

        class ConvRotLinear(base):
            def forward(self, value):
                result = super().forward(value)
                stats["int8GemmCalls"] += 1
                return result

        for name, (weight, scale) in self.entries.items():
            if check:
                check()
            path, _, attr = name.rpartition(".")
            parent = transformer.get_submodule(path)
            layer = getattr(parent, attr)
            if hasattr(layer, "get_base_layer"):
                parent, attr, layer = layer, "base_layer", layer.get_base_layer()
            if (type(layer) is not torch.nn.Linear or layer.bias is not None
                    or weight.shape != (layer.out_features, layer.in_features)):
                raise ValueError(f"Invalid Krea INT8 projection {name}")
            with torch.device("meta"):
                replacement = ConvRotLinear(layer)
            replacement.weight = torch.nn.Parameter(weight, requires_grad=False)
            replacement.weight_scale = scale
            setattr(parent, attr, replacement)
            self.packed_count += 1
        if self.host_time:
            # A single BF16 time vector per step uses an 864 MiB FP32 matrix.
            # Keep this read-only GEMV on the host, beneath any trainable style.
            projection = transformer.time_mod_proj
            layer = projection.get_base_layer() if hasattr(projection, "get_base_layer") else projection
            for attr in ("weight", "bias"):
                tensor = layer._parameters.pop(attr)
                setattr(layer, attr, tensor.detach())
        self.entries.clear()

    def close(self):
        self.entries.clear()


def load(root, transformer, policy, control):
    import torch
    from diffusers.loaders.single_file_utils import convert_krea2_transformer_checkpoint_to_diffusers as convert

    class FloatProjection(torch.nn.Linear):
        def forward(self, value):
            # These few heads were published in FP32. Cast their small input
            # and output, keeping the stored weight and FP32 scales intact.
            rows = value.to(device=self.weight.device, dtype=torch.float32)
            return torch.nn.functional.linear(rows, self.weight, self.bias).to(value)

    backend = load_sibling("moss_int8").require_backend(load_sibling("adapter_contract"))
    with load_sibling("mapped_weights").ReadOnlyWeights(root / PACKED) as reader:
        info = inspect_weights(reader, control.check)
        state, scales = {}, {}
        for key in reader.keys():
            control.check()
            name = key[len(info["prefix"]):]
            if name.endswith(".comfy_quant"):
                continue
            if name.endswith(".weight_scale"):
                scales[name.removesuffix("_scale")] = reader.get_tensor(key)
            else:
                state[name] = reader.get_tensor(key)
        if info["layout"] == "original":
            state, scales = convert(state), convert(scales)
    entries = {}
    for name, scale in scales.items():
        weight = state[name]
        entries[name.removesuffix(".weight")] = (weight, scale)
        state[name] = torch.empty((), dtype=torch.bfloat16).expand(weight.shape)
    for name, weight in state.items():
        if any(part in transformer._keep_in_fp32_modules for part in name.split(".")):
            state[name] = weight.float()
        if name.endswith(".weight") and weight.dtype == torch.float32:
            path = name.removesuffix(".weight")
            layer = transformer.get_submodule(path)
            if type(layer) is torch.nn.Linear:
                owner, _, attr = path.rpartition(".")
                with torch.device("meta"):
                    setattr(transformer.get_submodule(owner), attr,
                            FloatProjection(layer.in_features, layer.out_features, bias=layer.bias is not None))
    # PyTorch assign=True otherwise inherits requires_grad from floating-point
    # placeholder Linear modules. The real integer tensors are bound after PEFT.
    transformer.load_state_dict(state, strict=True, assign=True)
    transformer.requires_grad_(False)
    transformer._huiyu_transport = Int8Transport(entries, backend, policy == "offload")
    return transformer.eval()
