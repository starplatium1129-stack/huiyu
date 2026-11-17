"""Pinned MIAOKA INT8 ConvRot import identity and plain-tensor operators.

Metadata functions use only the standard library. The inference path uses
PyTorch INT8 matmul or the installed comfy-kitchen operator. Plain INT8 weights
keep existing residency ownership.
"""
import importlib.metadata
from functools import lru_cache
import json
from pathlib import Path
import sys

RECEIPT = "huiyu-moss-int8.json"
MODELS = {key: value for key, value in json.loads(Path(__file__).with_name("adapter-models.json").read_text(encoding="utf-8"))["models"].items()
          if value["family"] == "moss-image"}
TEXT_RECEIPT = "huiyu-moss-text-int8.json"


def component_spec(model_id, component="transformer"):
    if model_id not in MODELS:
        raise ValueError("Select a registered MiaoMiao MOSS model version")
    return MODELS[model_id]["mossTextInt8" if component == "text_encoder" else "mossInt8"]


def receipt_document(model_id, component="transformer"):
    spec = component_spec(model_id, component)
    return dict(schemaVersion=1, modelId=model_id, scope="imported-files-sha256",
        path=spec["path"], bytes=spec["bytes"], sha256=spec["sha256"])


def read_weights(path):
    if sys.platform == "win32":
        from huiyu_worker_lifecycle import load_sibling
        with load_sibling("mapped_weights").ReadOnlyWeights(str(path)) as source:
            return source.get_tensors()
    from safetensors.torch import load_file
    return load_file(str(path), device="cpu")


def selected(root, choice, contract, *, component="transformer"):
    if choice == "fp16":
        return None
    model_id = contract.config(root, root / "huiyu-model.json").get("modelId")
    try:
        spec = component_spec(model_id, component)
    except ValueError as error:
        raise contract.AdapterError("MODEL_CHANGED", str(error)) from error
    marker = root / (TEXT_RECEIPT if component == "text_encoder" else RECEIPT)
    if not marker.exists():
        if choice == "int8":
            raise contract.AdapterError("MODEL_INCOMPLETE", f"请先导入 MOSS {component} INT8 文件，或选择原始精度")
        return None
    value = contract.config(root, marker)
    if value != receipt_document(model_id, component):
        raise contract.AdapterError("MODEL_CHANGED", "MOSS INT8 导入记录不匹配，请重新导入作者文件")
    path = contract.safe_file(root, root / spec["path"])
    info = path.stat()
    if info.st_size != spec["bytes"] or info.st_mtime_ns > marker.stat().st_mtime_ns:
        raise contract.AdapterError("MODEL_CHANGED", "MOSS INT8 文件已变化，请重新导入")
    variant = dict(path=spec["path"], bytes=spec["bytes"], sha256=spec["sha256"], precision="int8-convrot")
    if component == "transformer":
        variant.update(quantMetadata=spec["quantMetadata"], attentionMetadata=spec["attentionMetadata"])
    return variant


def require_backend(contract):
    import torch
    if int((torch.version.cuda or "0").split(".")[0]) >= 13:
        try:
            if importlib.metadata.version("comfy-kitchen") == "0.2.37":
                import comfy_kitchen  # Registers its CUDA INT8 operator.
                return "kitchen"
        except (ImportError, OSError, importlib.metadata.PackageNotFoundError):
            pass
    if torch.cuda.is_available() and (hasattr(torch, "int8_mm") or hasattr(torch, "_int_mm")):
        return "torch"
    raise contract.AdapterError("DEPENDENCY_MISSING", "MOSS INT8 需要带有 INT8 矩阵乘法的 NVIDIA CUDA PyTorch")


@lru_cache(maxsize=4)
def convrot_basis(device, dtype):
    import torch
    # Regular Hadamard basis of the author checkpoint (four Kronecker factors).
    seed = torch.ones((4, 4), device=device, dtype=dtype) - 2 * torch.eye(4, device=device, dtype=dtype).flip(1)
    basis = torch.kron(seed, seed)
    return torch.kron(basis, basis) / 16


def torch_int8_linear(value, weight, weight_scale):
    import torch
    from torch.nn.functional import pad
    features = value.shape[-1]
    rows = value.reshape(-1, features)
    outputs = weight.shape[0]
    result = value.new_empty((rows.shape[0], outputs), dtype=torch.bfloat16)
    if not rows.shape[0]:
        return result.reshape(*value.shape[:-1], outputs)
    # Chunk activations before rotation and INT32 accumulation to bound peak workspace.
    matrix = (pad(weight, (0, 0, 0, -outputs % 8)) if outputs % 8 else weight).t().contiguous()
    basis = convrot_basis(value.device, value.dtype)
    matmul = getattr(torch, "int8_mm", None) or torch._int_mm
    chunk_size = max(32, min(1024, (16 * 1024**2 // (max(features, outputs) * 4)) // 32 * 32))
    for start in range(0, rows.shape[0], chunk_size):
        batch = rows[start:start + chunk_size]
        rotated = (batch.reshape(-1, 256) @ basis).reshape_as(batch)
        scale = (rotated.abs().amax(dim=-1, keepdim=True).float() / 127).clamp_min(1e-30)
        scale_for_math = scale.to(rotated.dtype)
        scale_for_math = torch.where(scale_for_math == 0, torch.finfo(rotated.dtype).tiny, scale_for_math)
        values = (rotated / scale_for_math).round().clamp_(-128, 127).to(torch.int8)
        count = values.shape[0]
        padded = pad(values, (0, 0, 0, -count % 32)) if count % 32 else values
        accum = matmul(padded, matrix)[:count, :outputs]
        result[start:start + count] = accum.float() * (scale * weight_scale.reshape(1, -1))
    return result.reshape(*value.shape[:-1], outputs)


def linear_class(backend):
    import torch
    from torch import nn

    class Int8Linear(nn.Linear):
        def __init__(self, source):
            # Keep Linear's leaf-offload classification, but do not allocate a
            # floating-point matrix or request gradients on integer weights.
            nn.Module.__init__(self)
            self.in_features, self.out_features = source.in_features, source.out_features
            self.compute_dtype = torch.bfloat16
            self.weight = nn.Parameter(torch.empty((self.out_features, self.in_features), dtype=torch.int8), requires_grad=False)
            self.register_parameter("bias", None)
            self.register_buffer("weight_scale", torch.empty((self.out_features, 1), dtype=torch.float32))

        def forward(self, value):
            if backend != "kitchen":
                return torch_int8_linear(value, self.weight, self.weight_scale)
            return torch.ops.comfy_kitchen.int8_linear(value.contiguous(), self.weight,
                self.weight_scale, None, 2, True, 256)

    return Int8Linear


def configure(transformer, weights, contract, variant, backend):
    import torch
    Int8Linear = linear_class(backend)

    def metadata(name):
        value = weights.pop(name, None)
        if value is None or value.dtype != torch.uint8 or value.ndim != 1 or value.numel() > 4096:
            raise contract.AdapterError("UNSUPPORTED_MODEL", f"Invalid MOSS INT8 metadata: {name}")
        try:
            return json.loads(bytes(value.tolist()))
        except (ValueError, UnicodeError) as error:
            raise contract.AdapterError("UNSUPPORTED_MODEL", f"Invalid MOSS INT8 JSON: {name}") from error

    count = 0
    expected = variant["quantMetadata"]
    for index, layer in enumerate(transformer.layers):
        if variant["attentionMetadata"]:
            config = metadata(f"layers.{index}.comfy_attention.config")
            if config != {"attention": "comfy_kitchen_int8"}:
                raise contract.AdapterError("UNSUPPORTED_MODEL", "Unsupported MOSS INT8 attention configuration")
        # Attention is selected by the task's installed Sage/Kitchen dispatcher;
        # this annotation contains no weight data or learned transformation.
        for name in ("qkv", "o", "ffn_up_gate", "ffn_down"):
            path = f"layers.{index}.proj.{name}"
            source = layer.proj[name]
            weight = weights.get(path + ".weight")
            scale = weights.get(path + ".weight_scale")
            if (metadata(path + ".comfy_quant") != expected or weight is None or weight.dtype != torch.int8
                    or tuple(weight.shape) != (source.out_features, source.in_features)
                    or scale is None or scale.dtype != torch.float32 or tuple(scale.shape) != (source.out_features, 1)):
                raise contract.AdapterError("UNSUPPORTED_MODEL", f"Unsupported MOSS INT8 projection: {path}")
            layer.proj[name] = Int8Linear(source)
            count += 1
    transformer._huiyu_int8_count = count
    transformer._huiyu_int8_attention = variant["attentionMetadata"] and backend == "kitchen"


def place_resident(transformer):
    import torch
    # Preserve INT8 matrices and FP32 scales. Casting the whole module's dtype
    # would round the scales, and would not implement real INT8 placement.
    for parameter in transformer.parameters():
        if parameter.dtype == torch.float16:
            parameter.data = parameter.to(device="cuda:0", dtype=torch.bfloat16)
    transformer.to(device="cuda:0")
