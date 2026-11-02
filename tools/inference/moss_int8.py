"""Pinned MIAOKA INT8 ConvRot import identity and plain-tensor operators.

Metadata functions use only the standard library. The inference path reuses
comfy-kitchen's registered INT8 operator, without importing ComfyUI or
dequantizing full weights. Plain parameters keep existing residency ownership.
"""
import importlib.metadata
import json
from pathlib import Path

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


def linear_class():
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

    return Int8Linear


def configure(transformer, weights, contract, variant):
    import torch
    Int8Linear = linear_class()

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
    transformer._huiyu_int8_attention = variant["attentionMetadata"]


def place_resident(transformer):
    import torch
    # Preserve INT8 matrices and FP32 scales. Casting the whole module's dtype
    # would round the scales, and would not implement real INT8 placement.
    for parameter in transformer.parameters():
        if parameter.dtype == torch.float16:
            parameter.data = parameter.to(device="cuda:0", dtype=torch.bfloat16)
    transformer.to(device="cuda:0")
