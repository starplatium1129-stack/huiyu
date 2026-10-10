"""Read-only, offline Anima/MiaoMiao single-file preparation report (standard library only).

Reads at most 16 MiB of safetensors JSON header per checkpoint, never tensor data.
Does not import ML packages, download, convert, install, or run inference.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
from pathlib import Path
import re
import struct
import sys

sys.dont_write_bytecode = True

MAX_HEADER = 16 * 1024 * 1024
SOURCE = "https://github.com/huggingface/diffusers/blob/v0.41.0/scripts/"
UPSTREAM = {"num_layers": 28, "hidden_size": 2048, "attention_head_dim": 128,
            "num_attention_heads": 16, "text_embed_dim": 1024, "intermediate_size": 8192,
            "patch_projection_shape": [2048, 68], "output_projection_shape": [64, 2048]}
DTYPE_BYTES = {"BOOL": 1, "U8": 1, "I8": 1, "I16": 2, "U16": 2, "F16": 2,
               "BF16": 2, "I32": 4, "U32": 4, "F32": 4, "I64": 8, "U64": 8,
               "F64": 8, "F8_E4M3": 1, "F8_E5M2": 1, "F8_E8M0": 1}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read_header(path: Path) -> dict:
    with path.open("rb") as stream:
        prefix = stream.read(8)
        if len(prefix) != 8:
            raise ValueError("Missing safetensors header length")
        size = struct.unpack("<Q", prefix)[0]
        if not 2 <= size <= MAX_HEADER:
            raise ValueError(f"Safetensors header exceeds bounded range (2..{MAX_HEADER} bytes): {size}")
        payload_size = path.stat().st_size - 8 - size
        if payload_size < 0:
            raise ValueError("Truncated safetensors header")
        raw = stream.read(size)
    if not raw.startswith(b"{"):
        raise ValueError("Safetensors header must begin with a JSON object")
    header = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(header, dict):
        raise ValueError("Safetensors header is not an object")
    tensors, spans = {}, []
    for name, entry in header.items():
        if name == "__metadata__":
            continue
        if not isinstance(entry, dict):
            raise ValueError(f"Invalid tensor entry: {name}")
        shape, offsets, dtype = entry.get("shape"), entry.get("data_offsets"), entry.get("dtype")
        if not isinstance(shape, list) or any(type(n) is not int or n < 0 for n in shape):
            raise ValueError(f"Invalid tensor shape: {name}")
        if (not isinstance(offsets, list) or len(offsets) != 2 or
                any(type(n) is not int for n in offsets) or not 0 <= offsets[0] <= offsets[1] <= payload_size):
            raise ValueError(f"Invalid or truncated tensor data offsets: {name}")
        if not isinstance(dtype, str) or dtype not in DTYPE_BYTES:
            raise ValueError(f"Unsupported safetensors dtype {dtype!r}: {name}")
        if math.prod(shape) * DTYPE_BYTES[dtype] != offsets[1] - offsets[0]:
            raise ValueError(f"Tensor shape/data length disagree: {name}")
        tensors[name] = {"shape": shape, "dtype": dtype}
        if offsets[1] > offsets[0]:
            spans.append(tuple(offsets))
    end = 0
    for start, stop in sorted(spans):
        if start != end:
            raise ValueError("Tensor payload has overlapping spans or gaps")
        end = stop
    if end != payload_size or not tensors:
        raise ValueError("Empty tensor map or unindexed trailing tensor data")
    return tensors


def dimension(tensors, key, index, rank):
    shape = tensors.get(key, {}).get("shape", [])
    return shape[index] if len(shape) == rank else None


def layers(tensors, pattern):
    indices = {int(match.group(1)) for key in tensors if (match := re.match(pattern, key))}
    return len(indices) if indices and indices == set(range(max(indices) + 1)) else None


def architecture(tensors):
    # Names follow the official converter, not a filename/version-number heuristic.
    normalized = {key.removeprefix("net."): value for key, value in tensors.items()
                  if not key.startswith("net.llm_adapter.")}
    adapter = {key.removeprefix("net.llm_adapter."): value for key, value in tensors.items()
               if key.startswith("net.llm_adapter.")}
    hidden = dimension(normalized, "blocks.0.self_attn.q_proj.weight", 0, 2)
    head = dimension(normalized, "blocks.0.self_attn.q_norm.weight", 0, 1)
    transformer = {"num_layers": layers(normalized, r"blocks\.(\d+)\."), "hidden_size": hidden,
                   "attention_head_dim": head,
                   "num_attention_heads": hidden // head if hidden and head and hidden % head == 0 else None,
                   "text_embed_dim": dimension(normalized, "blocks.0.cross_attn.k_proj.weight", 1, 2),
                   "intermediate_size": dimension(normalized, "blocks.0.mlp.layer1.weight", 0, 2),
                   "patch_projection_shape": normalized.get("x_embedder.proj.1.weight", {}).get("shape"),
                   "output_projection_shape": normalized.get("final_layer.linear.weight", {}).get("shape")}
    model_dim = dimension(adapter, "blocks.0.self_attn.q_proj.weight", 0, 2)
    adapter_head = dimension(adapter, "blocks.0.self_attn.q_norm.weight", 0, 1)
    conditioner = {"model_dim": model_dim,
                   "source_dim": dimension(adapter, "blocks.0.cross_attn.k_proj.weight", 1, 2),
                   "target_dim": dimension(adapter, "embed.weight", 1, 2),
                   "target_vocab_size": dimension(adapter, "embed.weight", 0, 2),
                   "num_layers": layers(adapter, r"blocks\.(\d+)\."),
                   "num_attention_heads": model_dim // adapter_head if model_dim and adapter_head and model_dim % adapter_head == 0 else None}
    return {"layout": "raw-anima" if hidden and adapter else "unrecognized-or-incomplete",
            "tensor_count": len(tensors), "parameter_count": sum(math.prod(x["shape"]) for x in tensors.values()),
            "dtypes": sorted({x["dtype"] for x in tensors.values()}),
            "transformer": transformer, "text_conditioner": conditioner}


def read_config(path):
    with path.open("rb") as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("Configuration exceeds 1 MiB")
    result = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(result, dict):
        raise ValueError("Configuration must be a JSON object")
    return result


def inspect(args):
    # Local, bundled constants only; this report still imports no ML packages.
    profile_path = Path(__file__).resolve().parents[2] / "tools/inference/anima_conversion_profile.py"
    spec = importlib.util.spec_from_file_location("huiyu_inspection_profile", profile_path)
    profile = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(profile)
    checkpoint = Path(args.checkpoint).absolute()
    model = architecture(read_header(checkpoint))
    blockers, companions = [], {}
    if model["layout"] != "raw-anima":
        blockers.append("Raw Anima transformer and net.llm_adapter key layout not established; no conversion recommendation.")
    for key, expected in UPSTREAM.items():
        actual = model["transformer"][key]
        if actual is None:
            blockers.append(f"Cannot infer transformer {key} from checkpoint header.")
        elif actual != expected:
            blockers.append(f"Official v0.41.0 converter fixed transformer {key}={expected}, checkpoint has {actual}; model-specific converter/configuration required.")
    for key, value in model["text_conditioner"].items():
        if value is None:
            blockers.append(f"Cannot infer text conditioner {key} from checkpoint header.")
        elif value != profile.CONDITIONER[key]:
            blockers.append(f"Supported profile requires text conditioner {key}={profile.CONDITIONER[key]}, checkpoint has {value}.")
    if args.transformer_config:
        config_path = Path(args.transformer_config).absolute()
        config = read_config(config_path)
        companions["transformer_config"] = str(config_path)
        try:
            profile.validate_config(config)
        except ValueError as error:
            blockers.append(str(error))
        for key in ("num_layers", "attention_head_dim", "num_attention_heads", "text_embed_dim"):
            if key not in config:
                blockers.append(f"Local transformer config lacks {key}.")
            elif config[key] != model["transformer"][key]:
                blockers.append(f"Local transformer config {key}={config[key]!r} disagrees with header {model['transformer'][key]!r}.")
    else:
        blockers.append("Missing --transformer-config local explicit supported-profile configuration.")
    for name, markers in {"text_encoder": [("embed_tokens.weight", "model.embed_tokens.weight")],
                          "vae": [("encoder.conv1.weight",), ("decoder.conv1.weight",)]}.items():
        value = getattr(args, name)
        if not value:
            blockers.append(f"Missing --{name.replace('_', '-')} local raw safetensors companion.")
            continue
        path = Path(value).absolute()
        try:
            header = read_header(path)
            if any(not any(key in header for key in alternatives) for alternatives in markers):
                raise ValueError(f"Raw {name} key layout not recognized by this preparation check")
            companions[name] = {"path": str(path), "tensor_count": len(header), "weights_verified": False}
        except (ValueError, OSError) as error:
            blockers.append(f"{name}: {error}")
    for name in ("qwen_tokenizer", "t5_tokenizer"):
        value = getattr(args, name)
        path = Path(value).absolute() if value else None
        if path is None or not path.is_dir():
            blockers.append(f"Missing --{name.replace('_', '-')} local tokenizer directory.")
            continue
        try:
            config = read_config(path / "tokenizer_config.json")
            if config.get("auto_map"):
                raise ValueError("Custom tokenizer code is outside the supported preparation plan")
            assets = ["tokenizer.json", "spiece.model"] if name == "t5_tokenizer" else ["tokenizer.json"]
            if not any((path / asset).is_file() and (path / asset).stat().st_size > 0 for asset in assets):
                raise ValueError(f"Missing nonempty tokenizer asset: {' or '.join(assets)}")
            companions[name] = {"path": str(path), "assets_present": True, "load_verified": False}
        except (ValueError, OSError) as error:
            blockers.append(f"{name}: {error}")
    source = Path(args.diffusers_source).absolute() if args.diffusers_source else None
    if source is not None:
        companions["historical_diffusers_source"] = {"path": str(source), "executed": False,
            "scriptsPresent": all((source / "scripts" / name).is_file() for name in
                                  ("convert_anima_to_diffusers.py", "convert_cosmos_to_diffusers.py"))}
    output = Path(args.output_dir).absolute() if args.output_dir else None
    if output is None:
        blockers.append("Missing --output-dir for a separate, new converted pipeline directory.")
    elif output.exists():
        blockers.append("Conversion output already exists; select a new path to preserve original and converted weights.")
    command = None
    if not blockers:
        command = ["<isolated-inference-python>", "-I", str(Path(__file__).with_name("convert-anima-checkpoint.py").resolve()),
                   "--profile", profile.PROFILE, "--checkpoint", str(checkpoint),
                   "--transformer-config", companions["transformer_config"],
                   "--text-encoder", companions["text_encoder"]["path"], "--vae", companions["vae"]["path"],
                   "--qwen-tokenizer", companions["qwen_tokenizer"]["path"],
                   "--t5-tokenizer", companions["t5_tokenizer"]["path"], "--output-dir", str(output), "--check"]
    return {"schemaVersion": 1, "checkpoint": str(checkpoint), "readOnly": True, "downloads": False,
            "tensorDataRead": False, "readyForInference": False, "compatibility": "not verified",
            "architecture": model, "officialFixedTransformer": UPSTREAM, "companions": companions,
            "blockers": blockers, "preparationStatus": "blocked" if blockers else "candidate-for-strict-offline-conversion",
            "conversionPlan": {"commandArgv": command,
                "environment": {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"},
                "steps": ["Use the bundled guarded converter with the prepared isolated runtime; --check verifies pinned packages and every meta-model key/shape without reading tensor payloads.",
                          "Only the explicit anima-cosmos2b-v041 architecture is supported. Unknown tensors and shapes are rejected rather than discarded.",
                          "After --check succeeds, explicitly replace --check with --apply to write CPU-converted weights into a separate new directory; inputs are preserved.",
                          "Load the saved Anima modular pipeline offline and perform separately authorized device acceptance before declaring inference ready."],
                "configNote": "The local transformer config must match the bundled fixed profile, never executable model code. --diffusers-source is optional historical source evidence and is never executed.",
                "sources": [SOURCE + "convert_anima_to_diffusers.py", SOURCE + "convert_cosmos_to_diffusers.py"]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, help="existing local raw Anima/MiaoMiao .safetensors")
    for name in ("transformer-config", "text-encoder", "vae", "qwen-tokenizer", "t5-tokenizer", "output-dir"):
        parser.add_argument("--" + name)
    parser.add_argument("--diffusers-source", help="optional historical source evidence only; never executed")
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args), indent=2, ensure_ascii=False))
    except (ValueError, OSError, OverflowError, RecursionError) as error:
        print(json.dumps({"schemaVersion": 1, "readyForInference": False, "error": str(error)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
