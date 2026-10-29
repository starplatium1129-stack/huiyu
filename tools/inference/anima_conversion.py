"""Strict, local CPU conversion. Default planning never imports ML or reads tensors.

No download/install/inference paths. See anima_conversion_profile.py for provenance.
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import time

sys.dont_write_bytecode = True
for _key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
    os.environ[_key] = "1"
os.environ["DO_NOT_TRACK"] = "1"


def sibling(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HERE = Path(__file__).resolve().parent
profile = sibling("huiyu_anima_profile", HERE / "anima_conversion_profile.py")
header_tools = sibling("huiyu_anima_header", HERE.parents[1] / "scripts/maintenance/inspect-anima-checkpoint.py")
WEIGHTS = ("transformer", "text_conditioner", "text_encoder", "vae")


def progress(message):
    print("HUIYU:CONVERT|" + message, file=sys.stderr, flush=True)


def safe_config(value):
    if isinstance(value, dict):
        if "auto_map" in value or "quantization_config" in value:
            raise ValueError("Custom-code/quantization configs are unsupported")
        for item in value.values():
            safe_config(item)
    elif isinstance(value, list):
        for item in value:
            safe_config(item)


def tokenizer_assets(path, kind):
    config = header_tools.read_config(path / "tokenizer_config.json")
    safe_config(config)
    classes = {"qwen_tokenizer": {"Qwen2Tokenizer", "Qwen2TokenizerFast"},
               "t5_tokenizer": {"T5Tokenizer", "T5TokenizerFast"}}[kind]
    if config.get("tokenizer_class") is not None and config["tokenizer_class"] not in classes:
        raise ValueError(f"Unsupported {kind} tokenizer_class")
    for name in ("vocab_file", "merges_file", "tokenizer_file"):
        if config.get(name) not in (None, {"vocab_file": "vocab.json" if kind == "qwen_tokenizer" else "spiece.model",
                                           "merges_file": "merges.txt", "tokenizer_file": "tokenizer.json"}[name]):
            raise ValueError(f"External tokenizer asset reference is unsupported: {name}")
    if "fast_tokenizer_files" in config and config["fast_tokenizer_files"] != ["tokenizer.json"]:
        raise ValueError("Only local tokenizer.json is supported")
    if (path / "config.json").is_file():
        safe_config(header_tools.read_config(path / "config.json"))
    required = (["tokenizer.json"], ["vocab.json", "merges.txt"]) if kind == "qwen_tokenizer" else (["tokenizer.json"], ["spiece.model"])
    if not any(all((path / name).is_file() and (path / name).stat().st_size > 0 for name in group) for group in required):
        raise ValueError(f"Missing local {kind} assets: {required}")


def inputs(args):
    profile.transformer_config(args.profile)
    paths = {}
    for name in ("checkpoint", "transformer_config", "text_encoder", "vae", "qwen_tokenizer", "t5_tokenizer"):
        path = Path(getattr(args, name)).expanduser().resolve(strict=True)
        if name.endswith("tokenizer"):
            if not path.is_dir():
                raise ValueError(f"{name} must be an existing local directory")
            tokenizer_assets(path, name)
        elif not path.is_file() or (name != "transformer_config" and path.suffix != ".safetensors"):
            raise ValueError(f"{name} must be an existing local {'JSON' if name == 'transformer_config' else 'safetensors'} file")
        paths[name] = path
    profile.validate_config(header_tools.read_config(paths["transformer_config"]), args.profile)
    output = Path(args.output_dir).expanduser().absolute()
    if any(path.is_symlink() for path in (output, *output.parents)):
        raise ValueError("Output must not traverse symlinks")
    if output.exists() or not output.parent.is_dir():
        raise ValueError("Output must be a new path under an existing directory")
    output = output.resolve()
    for source in paths.values():
        if output == source or output in source.parents or (source.is_dir() and source in output.parents):
            raise ValueError("Output must be separate from every input/asset directory")
    paths["output"] = output
    headers = {name: header_tools.read_header(paths[name]) for name in ("checkpoint", "text_encoder", "vae")}
    mapping = profile.map_headers(headers, args.profile)
    profile.validate_anchors(headers, args.profile)
    return paths, headers, mapping


def runtime():
    versions = {}
    for line in (HERE / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, expected = line.split("==")
        actual = importlib.metadata.version(name)
        if actual.split("+")[0] != expected:
            raise ValueError(f"{name}=={expected} required; found {actual}")
        versions[name] = actual
    import torch
    from accelerate import init_empty_weights
    from diffusers import CosmosTransformer3DModel, AnimaTextConditioner, AutoencoderKLQwenImage, FlowMatchEulerDiscreteScheduler
    from transformers import Qwen3Config, Qwen3Model, Qwen2Tokenizer, T5TokenizerFast
    from safetensors import safe_open
    return dict(versions=versions, torch=torch, empty=init_empty_weights, safe_open=safe_open,
                transformer=CosmosTransformer3DModel, text_conditioner=AnimaTextConditioner,
                text_encoder=lambda: Qwen3Model(Qwen3Config(**profile.QWEN)), vae=AutoencoderKLQwenImage,
                tokenizer=Qwen2Tokenizer, t5_tokenizer=T5TokenizerFast, scheduler=FlowMatchEulerDiscreteScheduler)


def source_name(component):
    return "checkpoint" if component in ("transformer", "text_conditioner") else component


def schemas_and_models(runtime_info, headers, mapping, profile_name=profile.PROFILE):
    configs = {"transformer": profile.transformer_config(profile_name), "text_conditioner": profile.CONDITIONER,
               "text_encoder": {}, "vae": profile.VAE}
    models = {}
    # Parameters are meta; small non-persistent RoPE buffers must stay on CPU.
    with runtime_info["empty"](include_buffers=False):
        for component in WEIGHTS:
            model = runtime_info[component](**configs[component])
            expected = {key: list(value.shape) for key, value in model.state_dict().items()}
            converted = mapping[component]
            missing, extra = set(expected) - set(converted), set(converted) - set(expected)
            if missing or extra:
                raise ValueError(f"{component} exact key mismatch; missing={sorted(missing)}, unexpected={sorted(extra)}; no unknown tensor keys are discarded")
            for key, shape in expected.items():
                old = converted[key]
                actual = headers[source_name(component)][old]["shape"]
                if actual != shape:
                    raise ValueError(f"{component}.{old} shape {actual} != required {shape}")
            models[component] = model
    return models


def verify_derived_rope(runtime_info, paths, headers, profile_name):
    """Read only Yume's 598 buffer bytes; never approximate unknown frequencies.

    Apache Diffusers' Cosmos 2 converter removes these exact cache keys. Its
    Anima converter uses that mapping; CosmosRotaryPosEmbed regenerates FP32
    ranges, with the profile's theta/NTK/patch configuration unchanged.
    """
    buffers = profile.derived_rope_buffers(headers, profile_name)
    if not buffers:
        return []
    torch = runtime_info["torch"]
    expected = (torch.arange(0, 42, 2, dtype=torch.float32, device="cpu") / 42,
                torch.arange(0, 44, 2, dtype=torch.float32, device="cpu") / 44,
                torch.arange(256, dtype=torch.float32, device="cpu"))
    records = []
    with runtime_info["safe_open"](str(paths["checkpoint"]), framework="pt", device="cpu", backend="pread") as source:
        if set(source.keys()) != set(headers["checkpoint"]):
            raise ValueError("Input keys changed during derived RoPE verification")
        for (name, shape), canonical in zip(buffers.items(), expected):
            tensor = source.get_tensor(name)
            if (list(tensor.shape) != shape or tensor.dtype != torch.bfloat16
                    or tensor.device.type != "cpu" or tensor.layout != torch.strided or not tensor.is_contiguous()
                    or not torch.equal(tensor.view(torch.int16), canonical.to(torch.bfloat16).view(torch.int16))):
                raise ValueError(f"Noncanonical Yume derived RoPE buffer: {name}")
            values = tensor.view(torch.int16).tolist()
            raw = struct.pack("<" + "H" * len(values), *(value & 0xffff for value in values))
            records.append({"source": name, "shape": shape, "dtype": "BF16", "bytes": len(raw),
                            "sha256": hashlib.sha256(raw).hexdigest(), "validation": "canonical-bf16-bitwise",
                            "disposition": "regenerated-by-upstream-CosmosRotaryPosEmbed-fp32"})
    return records


def checked_tokenizer(cls, path, capacity, kind):
    tokenizer = cls.from_pretrained(str(path), local_files_only=True, trust_remote_code=False)
    vocab = tokenizer.get_vocab()
    if not vocab or any(type(value) is not int or not 0 <= value < capacity for value in vocab.values()):
        raise ValueError(f"{kind} token ids exceed the paired embedding table")
    expected = ({"<|endoftext|>": 151643, "<|im_start|>": 151644, "<|im_end|>": 151645}
                if kind == "tokenizer" else {"<pad>": 0, "</s>": 1, "<unk>": 2, "<extra_id_0>": 32099})
    if any(vocab.get(key) != value for key, value in expected.items()) or tokenizer.pad_token_id is None:
        raise ValueError(f"{kind} special-token layout does not match this profile")
    return tokenizer


def tokenizers(runtime_info, paths):
    return {name: checked_tokenizer(runtime_info[name], paths[source], capacity, name)
            for name, source, capacity in (("tokenizer", "qwen_tokenizer", profile.QWEN["vocab_size"]),
                                           ("t5_tokenizer", "t5_tokenizer", profile.CONDITIONER["target_vocab_size"]))}


def save_weights(runtime_info, models, paths, headers, mapping, destination):
    torch = runtime_info["torch"]
    dtype_map = {"F16": torch.float16, "BF16": torch.bfloat16, "F32": torch.float32}
    for component in WEIGHTS:
        progress(f"读取并转换 {component} 参数")
        reported = 0.0
        source = source_name(component)
        # Re-check bounded headers immediately before reading CPU tensor payloads.
        if header_tools.read_header(paths[source]) != headers[source]:
            raise ValueError(f"Input header changed during conversion: {source}")
        state = {}
        with runtime_info["safe_open"](str(paths[source]), framework="pt", device="cpu") as file:
            if set(file.keys()) != set(headers[source]):
                raise ValueError(f"Input keys changed during conversion: {source}")
            for index, (new, old) in enumerate(mapping[component].items()):
                if time.monotonic() - reported >= 0.5:
                    progress(f"读取 {component} 参数：{index}/{len(mapping[component])}")
                    reported = time.monotonic()
                tensor = file.get_tensor(old)
                expected = headers[source][old]
                if (list(tensor.shape) != expected["shape"] or tensor.dtype != dtype_map[expected["dtype"]] or
                        tensor.device.type != "cpu" or tensor.layout != torch.strided or not tensor.is_contiguous()):
                    raise ValueError(f"Unsupported tensor layout/dtype/shape: {source}.{old}")
                state[new] = tensor
        model = models.pop(component)
        model.load_state_dict(state, strict=True, assign=True)
        progress(f"保存 {component} 原生权重分片")
        model.save_pretrained(str(destination / component), safe_serialization=True, max_shard_size="2GB")
        del model, state


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def publish(staged, output):
    # Reserve the destination exclusively. Publish the index last so an interrupted
    # copy cannot be mistaken for a pipeline by the existing worker. Never replace
    # or delete a prior output directory. A publish error leaves an incomplete new
    # directory for inspection, rather than deleting files after a race/failure.
    output.mkdir(exist_ok=False)
    index = "model_index.json"
    for item in list(staged.iterdir()):
        if item.name != index:
            shutil.move(str(item), str(output / item.name))
    shutil.move(str(staged / index), str(output / index))


def apply(runtime_info, models, loaded_tokenizers, paths, headers, mapping, report):
    output = paths["output"]
    with tempfile.TemporaryDirectory(prefix=f".{output.name}.convert-", dir=output.parent) as temporary:
        staged = Path(temporary)
        save_weights(runtime_info, models, paths, headers, mapping, staged)
        for name, tokenizer in loaded_tokenizers.items():
            progress(f"保存并核对 {name} 分词文件")
            folder = staged / name
            tokenizer.save_pretrained(str(folder))
            if name == "tokenizer":
                # Transformers 5 saves tokenizer.json only. Export the same BPE
                # vocabulary too, matching the shipping worker's local contract.
                tokenizer.backend_tokenizer.model.save(str(folder))
        runtime_info["scheduler"](shift=3.0).save_pretrained(str(staged / "scheduler"))
        index = {"_class_name": "AnimaModularPipeline", "_blocks_class_name": "AnimaAutoBlocks",
                 "_diffusers_version": "0.41.0"}
        for name, cls in {"transformer": "CosmosTransformer3DModel", "text_conditioner": "AnimaTextConditioner",
                          "text_encoder": "Qwen3Model", "vae": "AutoencoderKLQwenImage", "tokenizer": "Qwen2Tokenizer",
                          "t5_tokenizer": "T5TokenizerFast", "scheduler": "FlowMatchEulerDiscreteScheduler"}.items():
            index[name] = ["transformers" if name in {"text_encoder", "tokenizer", "t5_tokenizer"} else "diffusers", cls]
        write_json(staged / "model_index.json", index)
        completed = {**report, "mode": "converted", "tensorDataRead": True, "outputWritten": True,
                     "weightTensorDataRead": True,
                     "weightsStrictlyLoaded": True}
        hashing = sibling("huiyu_conversion_hash", HERE / "native_hash.py")
        completed["outputs"] = []
        for path in sorted(staged.rglob("*")):
            if path.is_file():
                progress(f"校验转换结果：{path.relative_to(staged).as_posix()}")
                completed["outputs"].append({"path": path.relative_to(staged).as_posix(), "bytes": path.stat().st_size,
                                             "sha256": hashing.file_sha256(path)})
        write_json(staged / "conversion.json", completed)
        progress("保存已校验的转换结果")
        publish(staged, output)
    return completed


def convert(args):
    paths, headers, mapping = inputs(args)
    report = {"schemaVersion": 1, "profile": args.profile, "mode": "plan", "downloads": False,
              "checkpointPrefix": profile.checkpoint_prefix(headers["checkpoint"]),
              "transformerLayers": profile.PROFILES[args.profile],
              "tensorDataRead": False, "outputWritten": False, "architectureVerified": False,
              "weightTensorDataRead": False, "derivedBufferBytesRead": 0, "derivedBuffers": [],
              "derivedBufferCount": len(profile.derived_rope_buffers(headers, args.profile)),
              "derivedBufferVerification": "pending" if args.profile == profile.YUME_PROFILE else "not-required",
              "readyForInference": False, "generationAcceptance": "not performed",
              "inputs": {name: str(path) for name, path in paths.items() if name != "output"},
              "outputDir": str(paths["output"]), "tensorCounts": {name: len(keys) for name, keys in mapping.items()},
              "sources": profile.SOURCES, "sourceGitBlobs": profile.SOURCE_BLOBS,
              "scope": "Only the selected explicit architecture. Header anchors are preliminary; --check verifies exact meta schemas/tokenizers and Yume's 598 derived-buffer bytes; --apply loads CPU weights. No trainable or unknown tensor keys are discarded. Verified Yume caches follow upstream FP32 regeneration, not BF16 runtime frequency injection.",
              "license": "Conversion mappings: Apache-2.0; source model/tokenizer licenses remain separate."}
    if not args.check and not args.apply:
        return report
    progress("加载原生转换依赖，尚未读取完整权重")
    info = runtime()
    progress("核对模型结构与本地分词器")
    models = schemas_and_models(info, headers, mapping, args.profile)
    derived = verify_derived_rope(info, paths, headers, args.profile)
    loaded_tokenizers = tokenizers(info, paths)
    report.update(mode="checked", architectureVerified=True, dependencies=info["versions"],
                  tensorDataRead=bool(derived), derivedBufferBytesRead=sum(row["bytes"] for row in derived),
                  derivedBuffers=derived, derivedBufferVerification="passed" if derived else "not-required")
    return apply(info, models, loaded_tokenizers, paths, headers, mapping, report) if args.apply else report


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, choices=list(profile.PROFILES))
    for name in ("checkpoint", "transformer-config", "text-encoder", "vae", "qwen-tokenizer", "t5-tokenizer", "output-dir"):
        parser.add_argument("--" + name, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Validate exact meta schemas/tokenizers; Yume reads 598 derived-buffer bytes, no trainable weight data or output")
    mode.add_argument("--apply", action="store_true", help="Explicitly convert CPU tensors into a separate new pipeline directory")
    args = parser.parse_args(argv)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            report = convert(args)
        print(json.dumps({"ok": True, **report}, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "schemaVersion": 1, "readyForInference": False,
                          "error": str(error), "message": str(error)}, ensure_ascii=False))
        return 1
