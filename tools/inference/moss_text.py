"""MOSS's paired Qwen3.5 encoder: pinned W8A8 weights and optional FLA conv.

No ComfyUI imports or model-directory code. The original tokenizer, architecture
and calibrated norms are preserved; placement owns ordinary INT8/FP32 tensors.
"""
import json
from huiyu_worker_lifecycle import load_sibling


def load_int8(root, control, contract):
    import torch
    from accelerate import init_empty_weights
    from transformers import Qwen3_5Config, Qwen3_5Model
    from safetensors.torch import load_file
    quant = load_sibling("moss_int8")
    variant = quant.selected(root, "int8", contract, component="text_encoder")
    quant.require_backend(contract)
    config = Qwen3_5Config.from_pretrained(str(root / "text_encoder"), local_files_only=True)
    with init_empty_weights():
        encoder = Qwen3_5Model(config)
        weights = load_file(str(contract.safe_file(root, root / variant["path"])), device="cpu")
        Int8Linear = quant.linear_class()
        count = 0
        for name, layer in list(encoder.named_modules()):
            control.check()
            weight = weights.get(name + ".weight")
            if weight is None or weight.dtype != torch.int8:
                continue
            metadata = weights.pop(name + ".comfy_quant", None)
            scale = weights.get(name + ".weight_scale")
            if (not isinstance(layer, torch.nn.Linear) or layer.bias is not None
                    or tuple(weight.shape) != (layer.out_features, layer.in_features)
                    or scale is None or scale.dtype != torch.float32
                    or tuple(scale.shape) != (layer.out_features, 1)
                    or metadata is None or metadata.dtype != torch.uint8
                    or metadata.ndim != 1 or metadata.numel() > 4096
                    or json.loads(bytes(metadata.tolist())) != {
                        "format": "int8_tensorwise", "convrot": True, "convrot_groupsize": 256}):
                raise contract.AdapterError("UNSUPPORTED_MODEL", f"Unsupported MOSS INT8 text projection: {name}")
            encoder.set_submodule(name, Int8Linear(layer))
            count += 1
    if count != 248:
        raise contract.AdapterError("UNSUPPORTED_MODEL", "MOSS INT8 text encoder requires 248 calibrated projections")
    encoder.load_state_dict(weights, strict=True, assign=True)
    encoder.set_attn_implementation("sdpa")
    return encoder.eval()


def bind_fast_convolution(encoder):
    # The native path encodes each prompt without KV state or packed sequences.
    # FLA provides the same causal convolution in Triton on Windows, without
    # Dao's separately compiled CUDA extension. Do not replace an installed one.
    layers = [layer for layer in encoder.modules()
              if hasattr(layer, "causal_conv1d_fn") and layer.causal_conv1d_fn is None
              and getattr(getattr(layer, "chunk_gated_delta_rule", None), "__module__", "").startswith("fla.")]
    if not layers:
        return
    from fla.modules.causal_conv1d import causal_conv1d

    def convolution(x, weight, bias=None, activation=None, seq_idx=None):
        if seq_idx is not None:
            raise ValueError("MOSS text encoding does not pack independent sequences")
        output, _ = causal_conv1d(x.transpose(1, 2), weight=weight, bias=bias,
                                  activation=activation, backend="triton")
        return output.transpose(1, 2)

    for layer in layers:
        layer.causal_conv1d_fn = convolution
