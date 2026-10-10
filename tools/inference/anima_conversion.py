"""Strict, local CPU conversion. Default planning never imports ML or reads tensors.

No download/install/inference paths. See anima_conversion_profile.py for provenance.
"""
from __future__ import annotations

import contextlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

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
PROBES = ["", "A small blue bird.", "动漫，水彩画。"]


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
    if args.profile != profile.PROFILE:
        raise ValueError(f"Only explicit profile {profile.PROFILE} is supported")
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
    profile.validate_config(header_tools.read_config(paths["transformer_config"]))
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
    mapping = profile.map_headers(headers)
    profile.validate_anchors(headers)
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


def schemas_and_models(runtime_info, headers, mapping):
    configs = {"transformer": profile.TRANSFORMER, "text_conditioner": profile.CONDITIONER,
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
                raise ValueError(f"{component} exact key mismatch; missing={sorted(missing)}, unexpected={sorted(extra)}; no tensor keys are discarded")
            for key, shape in expected.items():
                old = converted[key]
                actual = headers[source_name(component)][old]["shape"]
                if actual != shape:
                    raise ValueError(f"{component}.{old} shape {actual} != required {shape}")
            models[component] = model
    return models


def checked_tokenizer(cls, path, capacity, kind):
    tokenizer = cls.from_pretrained(str(path), local_files_only=True, trust_remote_code=False)
    vocab = tokenizer.get_vocab()
    if not vocab or any(type(value) is not int or not 0 <= value < capacity for value in vocab.values()):
        raise ValueError(f"{kind} token ids exceed the paired embedding table")
    expected = ({"<|endoftext|>": 151643, "<|im_start|>": 151644, "<|im_end|>": 151645}
                if kind == "tokenizer" else {"<pad>": 0, "</s>": 1, "<unk>": 2, "<extra_id_0>": 32099})
    if any(vocab.get(key) != value for key, value in expected.items()) or tokenizer.pad_token_id is None:
        raise ValueError(f"{kind} special-token layout does not match this profile")
    tokens = tokenizer(PROBES, padding=True, truncation=True, max_length=64)["input_ids"]
    if len(tokens) != len(PROBES) or any(not row or any(type(i) is not int or not 0 <= i < capacity for i in row) for row in tokens):
        raise ValueError(f"{kind} failed local tokenizer probe")
    return tokenizer


def tokenizers(runtime_info, paths):
    return {name: checked_tokenizer(runtime_info[name], paths[source], capacity, name)
            for name, source, capacity in (("tokenizer", "qwen_tokenizer", profile.QWEN["vocab_size"]),
                                           ("t5_tokenizer", "t5_tokenizer", profile.CONDITIONER["target_vocab_size"]))}


def save_weights(runtime_info, models, paths, headers, mapping, destination):
    torch = runtime_info["torch"]
    dtype_map = {"F16": torch.float16, "BF16": torch.bfloat16, "F32": torch.float32}
    for component in WEIGHTS:
        source = source_name(component)
        # Re-check bounded headers immediately before reading CPU tensor payloads.
        if header_tools.read_header(paths[source]) != headers[source]:
            raise ValueError(f"Input header changed during conversion: {source}")
        state = {}
        with runtime_info["safe_open"](str(paths[source]), framework="pt", device="cpu") as file:
            if set(file.keys()) != set(headers[source]):
                raise ValueError(f"Input keys changed during conversion: {source}")
            for new, old in mapping[component].items():
                tensor = file.get_tensor(old)
                expected = headers[source][old]
                if (list(tensor.shape) != expected["shape"] or tensor.dtype != dtype_map[expected["dtype"]] or
                        tensor.device.type != "cpu" or tensor.layout != torch.strided or not tensor.is_contiguous()):
                    raise ValueError(f"Unsupported tensor layout/dtype/shape: {source}.{old}")
                state[new] = tensor
        model = models.pop(component)
        model.load_state_dict(state, strict=True, assign=True)
        model.save_pretrained(str(destination / component), safe_serialization=True, max_shard_size="2GB")
        del model, state


def verify_saved_weights(destination, headers, mapping):
    for component in WEIGHTS:
        saved = {}
        for shard in (destination / component).glob("*.safetensors"):
            for name, entry in header_tools.read_header(shard).items():
                if name in saved:
                    raise ValueError(f"Duplicate saved tensor: {component}.{name}")
                saved[name] = entry
        expected = {new: headers[source_name(component)][old] for new, old in mapping[component].items()}
        if saved != expected:
            raise ValueError(f"Saved key/shape/dtype verification failed: {component}")


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
            folder = staged / name
            tokenizer.save_pretrained(str(folder))
            if name == "tokenizer":
                # Transformers 5 saves tokenizer.json only. Export the same BPE
                # vocabulary too, matching the shipping worker's local contract.
                tokenizer.backend_tokenizer.model.save(str(folder))
            reloaded = checked_tokenizer(runtime_info[name], folder,
                                         profile.QWEN["vocab_size"] if name == "tokenizer" else profile.CONDITIONER["target_vocab_size"], name)
            if reloaded.get_vocab() != tokenizer.get_vocab() or reloaded(PROBES)["input_ids"] != tokenizer(PROBES)["input_ids"]:
                raise ValueError(f"Saved {name} changed token ids")
        runtime_info["scheduler"](shift=3.0).save_pretrained(str(staged / "scheduler"))
        index = {"_class_name": "AnimaModularPipeline", "_blocks_class_name": "AnimaAutoBlocks",
                 "_diffusers_version": "0.41.0"}
        for name, cls in {"transformer": "CosmosTransformer3DModel", "text_conditioner": "AnimaTextConditioner",
                          "text_encoder": "Qwen3Model", "vae": "AutoencoderKLQwenImage", "tokenizer": "Qwen2Tokenizer",
                          "t5_tokenizer": "T5TokenizerFast", "scheduler": "FlowMatchEulerDiscreteScheduler"}.items():
            index[name] = ["transformers" if name in {"text_encoder", "tokenizer", "t5_tokenizer"} else "diffusers", cls]
        write_json(staged / "model_index.json", index)
        verify_saved_weights(staged, headers, mapping)
        sibling("huiyu_anima_worker_layout", HERE / "worker.py").validate_model(str(staged))
        completed = {**report, "mode": "converted", "tensorDataRead": True, "outputWritten": True,
                     "weightsStrictlyLoaded": True, "savedKeyShapeDtypeVerified": True}
        write_json(staged / "conversion.json", completed)
        publish(staged, output)
    return completed


def convert(args):
    paths, headers, mapping = inputs(args)
    report = {"schemaVersion": 1, "profile": profile.PROFILE, "mode": "plan", "downloads": False,
              "tensorDataRead": False, "outputWritten": False, "architectureVerified": False,
              "readyForInference": False, "generationAcceptance": "not performed",
              "inputs": {name: str(path) for name, path in paths.items() if name != "output"},
              "outputDir": str(paths["output"]), "tensorCounts": {name: len(keys) for name, keys in mapping.items()},
              "sources": profile.SOURCES, "sourceGitBlobs": profile.SOURCE_BLOBS,
              "scope": "Only this fixed architecture, not arbitrary Anima/MiaoMiao versions. Header anchors are preliminary; --check performs exact meta-schema/tokenizer checks; --apply loads CPU weights.",
              "license": "Conversion mappings: Apache-2.0; source model/tokenizer licenses remain separate."}
    if not args.check and not args.apply:
        return report
    info = runtime()
    models = schemas_and_models(info, headers, mapping)
    loaded_tokenizers = tokenizers(info, paths)
    report.update(mode="checked", architectureVerified=True, dependencies=info["versions"])
    return apply(info, models, loaded_tokenizers, paths, headers, mapping, report) if args.apply else report


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, choices=[profile.PROFILE])
    for name in ("checkpoint", "transformer-config", "text-encoder", "vae", "qwen-tokenizer", "t5-tokenizer", "output-dir"):
        parser.add_argument("--" + name, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Validate exact meta schemas and local tokenizers; no weight data read or output")
    mode.add_argument("--apply", action="store_true", help="Explicitly convert CPU tensors into a separate new pipeline directory")
    args = parser.parse_args(argv)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            report = convert(args)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print(json.dumps({"schemaVersion": 1, "readyForInference": False, "error": str(error)}, ensure_ascii=False))
        return 1
