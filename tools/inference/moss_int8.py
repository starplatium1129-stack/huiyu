"""Pinned MIAOKA INT8 ConvRot import identity and plain-tensor operators.

Metadata functions use only the standard library. The inference path reuses
comfy-kitchen's registered INT8 operator, without importing ComfyUI or
dequantizing full weights. Plain parameters keep existing residency ownership.
"""
import importlib.metadata
import json
from pathlib import Path

MODEL_ID = "moss-miaomiao-base-v1.0"
RECEIPT = "huiyu-moss-int8.json"
SPEC = json.loads(Path(__file__).with_name("adapter-models.json").read_text(encoding="utf-8"))["models"][MODEL_ID]["mossInt8"]


def receipt_document():
    return dict(schemaVersion=1, modelId=MODEL_ID, scope="imported-files-sha256",
        path=SPEC["path"], bytes=SPEC["bytes"], sha256=SPEC["sha256"])


def selected(root, choice, contract):
    if choice == "fp16":
        return None
    marker = root / RECEIPT
    if not marker.exists():
        if choice == "int8":
            raise contract.AdapterError("MODEL_INCOMPLETE", "请先导入作者 BASE v1.0 INT8 文件，或选择 FP16")
        return None
    value = contract.config(root, marker)
    if value != receipt_document():
        raise contract.AdapterError("MODEL_CHANGED", "MOSS INT8 导入记录不匹配，请重新导入作者文件")
    path = contract.safe_file(root, root / SPEC["path"])
    info = path.stat()
    if info.st_size != SPEC["bytes"] or info.st_mtime_ns > marker.stat().st_mtime_ns:
        raise contract.AdapterError("MODEL_CHANGED", "MOSS INT8 文件已变化，请重新导入")
    return dict(path=SPEC["path"], bytes=SPEC["bytes"], sha256=SPEC["sha256"], precision="int8-convrot")


def require_backend(contract):
    import torch
    try:
        version = importlib.metadata.version("comfy-kitchen")
    except importlib.metadata.PackageNotFoundError as error:
        raise contract.AdapterError("DEPENDENCY_MISSING", "作者 INT8 需要 comfy-kitchen 0.2.37；可复用本机 ComfyUI Python，或选择 FP16") from error
    if version != "0.2.37" or int((torch.version.cuda or "0").split(".")[0]) < 13:
        raise contract.AdapterError("DEPENDENCY_VERSION", "作者 INT8 当前适配 comfy-kitchen 0.2.37 / CUDA 13 运行库；未自动升级环境")
    try:
        import comfy_kitchen  # Registers the same public operator used by its INT8 layout.
    except (ImportError, OSError) as error:
        raise contract.AdapterError("DEPENDENCY_MISSING", "INT8 算子库无法加载，请检查独立 Python 的 comfy-kitchen / CUDA 13 运行库，或选择 FP16") from error


def configure(transformer, weights, contract):
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
            return torch.ops.comfy_kitchen.int8_linear(value.contiguous(), self.weight,
                self.weight_scale, None, 2, True, 256)

    def metadata(name):
        value = weights.pop(name, None)
        if value is None or value.dtype != torch.uint8 or value.ndim != 1 or value.numel() > 4096:
            raise contract.AdapterError("UNSUPPORTED_MODEL", f"Invalid MOSS INT8 metadata: {name}")
        try:
            return json.loads(bytes(value.tolist()))
        except (ValueError, UnicodeError) as error:
            raise contract.AdapterError("UNSUPPORTED_MODEL", f"Invalid MOSS INT8 JSON: {name}") from error

    count = 0
    expected = {"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": 256}
    for index, layer in enumerate(transformer.layers):
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


def place_resident(transformer):
    import torch
    # Preserve INT8 matrices and FP32 scales. Casting the whole module's dtype
    # would round the scales, and would not implement real INT8 placement.
    for parameter in transformer.parameters():
        if parameter.dtype == torch.float16:
            parameter.data = parameter.to(device="cuda:0", dtype=torch.bfloat16)
    transformer.to(device="cuda:0")
