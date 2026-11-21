"""Import the pinned, local Comfy-Org Wan 2.2 TI2V 5B split weights. CPU only."""
import argparse
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import sys
import tempfile


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from mapped_weights import ReadOnlyWeights
from native_hash import file_sha256


def progress(message):
    print(f"HUIYU:CONVERT|{message}", file=sys.stderr, flush=True)


def write_json(path, value):
    path.write_bytes((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def vae_key(key):
    """Wan 2.2 has nested residual/down/up groups, unlike the Wan 2.1 VAE."""
    prefix, rest = key.split(".", 1)
    if prefix in ("conv1", "conv2"):
        return ("quant_conv." if prefix == "conv1" else "post_quant_conv.") + rest
    old, new = ("downsamples", "down") if prefix == "encoder" else ("upsamples", "up")
    if rest.startswith(old + "."):
        rest = rest.replace(old + ".", new + "_blocks.", 1)
        rest = (rest.replace("." + old + ".", ".resnets.") if ".residual." in rest or ".shortcut." in rest
                else re.sub(r"\." + old + r"\.\d+\.", "." + new + "sampler.", rest))
    for before, after in (
        ("middle.0.", "mid_block.resnets.0."), ("middle.1.", "mid_block.attentions.0."),
        ("middle.2.", "mid_block.resnets.1."), ("head.0.", "norm_out."), ("head.2.", "conv_out."),
        ("residual.0.", "norm1."), ("residual.2.", "conv1."), ("residual.3.", "norm2."),
        ("residual.6.", "conv2."), ("shortcut.", "conv_shortcut."),
    ):
        rest = rest.replace(before, after)
    if rest.startswith("conv1."):
        rest = rest.replace("conv1.", "conv_in.", 1)
    return prefix + "." + rest


def weight_layout(component, reader, config):
    import torch
    from diffusers import AutoencoderKLWan, WanTransformer3DModel
    from diffusers.loaders.single_file_utils import convert_wan_transformer_to_diffusers
    from transformers import UMT5Config, UMT5EncoderModel

    names = reader.keys()
    if component == "text_encoder":
        # The Comfy checkpoint embeds SentencePiece and a scalar FP32 dequantizer
        # for each FP8 projection. All other floating weights are ordinary FP16.
        sources = {k: k for k in names if k.endswith(".weight")}
        with torch.device("meta"):
            model = UMT5EncoderModel(UMT5Config.from_dict(config))
    elif component == "transformer":
        # This TI2V variant only renames keys. Passing source names as values
        # reuses Diffusers' mapping without materializing the 5B model here.
        sources = convert_wan_transformer_to_diffusers({k: k for k in names})
        with torch.device("meta"):
            model = WanTransformer3DModel.from_config(config)
    else:
        sources = {vae_key(k): k for k in names}
        with torch.device("meta"):
            model = AutoencoderKLWan.from_config(config)

    expected = model.state_dict()
    if component == "text_encoder":
        # Older Transformers snapshots store only shared.weight. The worker
        # ties the lookup used by the encoder to that table during loading.
        expected.pop("encoder.embed_tokens.weight", None)
    if expected.keys() != sources.keys():
        raise ValueError(f"{component}: key mismatch, missing {sorted(expected.keys()-sources.keys())[:5]}, "
                         f"unexpected {sorted(sources.keys()-expected.keys())[:5]}")

    used = set(sources.values())
    layout = {}
    for name, old in sources.items():
        entry = reader.header[old]
        shape = entry["shape"]
        if list(expected[name].shape) != shape:
            raise ValueError(f"{component}/{name}: incorrect weight shape {shape}")
        scale = None
        if component == "text_encoder" and entry["dtype"] == "F8_E4M3":
            scale_key = old.removesuffix(".weight") + ".scale_weight"
            if reader.header[scale_key]["dtype"] != "F32" or reader.header[scale_key]["shape"] != []:
                raise ValueError(f"Invalid FP8 scale for {name}")
            scale = reader.get_tensor(scale_key).item()
            if not math.isfinite(scale) or scale <= 0:
                raise ValueError(f"Invalid FP8 scale for {name}")
            used.add(scale_key)
        elif entry["dtype"] != "F16":
            raise ValueError(f"Unexpected source precision for {component}/{name}")
        # Match the dtypes selected by the actual worker, including Wan's
        # time embedding, modulation and norms. Avoid expanding them on load.
        fp32 = component == "vae" or (component == "transformer" and
            not set(name.split(".")).isdisjoint(model._keep_in_fp32_modules))
        layout[name] = (old, shape, "F32" if fp32 else "BF16", scale)
    if component == "text_encoder":
        used.update(("scaled_fp8", "spiece_model"))
    if used != set(names):
        raise ValueError(f"Unexpected source tensors in {component}: {sorted(set(names)-used)[:5]}")
    return layout


def write_weights(path, reader, layout):
    import torch
    header = {"__metadata__": {"format": "pt"}}
    offset = 0
    for name, (_, shape, dtype, _) in layout.items():
        end = offset + math.prod(shape) * (4 if dtype == "F32" else 2)
        header[name] = {"dtype": dtype, "shape": shape, "data_offsets": [offset, end]}
        offset = end
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 8)
    prefix = struct.pack("<Q", len(encoded)) + encoded
    digest = hashlib.sha256(prefix)
    with path.open("xb") as dest:
        dest.write(prefix)
        for old, _, dtype, scale in layout.values():
            target_dtype = torch.float32 if dtype == "F32" else torch.bfloat16
            # The shared embedding is >2 GB. Bound cast temporaries even for
            # that single tensor and read through the immutable source mapping.
            for chunk in reader.get_tensor(old).reshape(-1).split(4 * 1024**2):
                if scale is not None:
                    chunk = chunk.float().mul_(scale)
                data = memoryview(chunk.to(target_dtype).view(torch.uint8).numpy())
                dest.write(data)
                digest.update(data)
        dest.flush()
        os.fsync(dest.fileno())
    return {"bytes": len(prefix) + offset, "sha256": digest.hexdigest()}


def write_tokenizer(folder, reader, recipe):
    from sentencepiece import sentencepiece_model_pb2
    from tokenizers import Tokenizer
    raw = reader.get_tensor("spiece_model").numpy().tobytes()
    spm = sentencepiece_model_pb2.ModelProto.FromString(raw)
    folder.mkdir()
    (folder / "spiece.model").write_bytes(raw)
    # Reconstruct the official *fast* tokenizer, including its normalizer and
    # unknown id 3. T5's generic defaults use a different vocabulary layout.
    config = recipe["tokenizerConfig"]
    sentinels = [f"<extra_id_{i}>" for i in range(config["extra_ids"])]
    vocab = [(p.piece, p.score) for p in spm.pieces] + [(s, 0.0) for s in reversed(sentinels)]
    specials = [(i, t) for i, (t, _) in enumerate(vocab) if i < 4 or i >= len(spm.pieces)]
    token = dict(single_word=False, lstrip=False, rstrip=False, normalized=False, special=True)
    backend = recipe["tokenizerBackend"]
    backend["model"]["vocab"] = vocab
    backend["added_tokens"] = [dict(id=i, content=t, **token) for i, t in specials]
    tokenizer = Tokenizer.from_str(json.dumps(backend, ensure_ascii=False))
    tokenizer.save(str(folder / "tokenizer.json"), pretty=True)
    write_json(folder / "special_tokens_map.json", dict(additional_special_tokens=sentinels, **recipe["specialTokensMap"]))
    decoder = {i: dict(content=t, **token) for i, t in specials}
    write_json(folder / "tokenizer_config.json", dict(added_tokens_decoder=decoder, additional_special_tokens=sentinels, **config))


def source_stamp(path):
    info = path.stat()
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def convert(args):
    recipe = json.loads((HERE / "wan22-import.json").read_bytes())
    model_id = recipe["modelId"]
    source_root = args.comfy_models.resolve(strict=True)
    model_root = args.models_root.resolve()
    target = model_root / model_id
    if target.exists() or target.is_symlink():
        raise FileExistsError(f"模型目录已存在，请保留或移开后重试：{target}")
    paths = {name: source_root / item["path"] for name, item in recipe["sources"].items()}
    for name, path in paths.items():
        if not path.is_file() or path.stat().st_size != recipe["sources"][name]["bytes"]:
            raise ValueError(f"源权重缺失或大小不符：{path}")
    if not args.apply:
        return dict(ok=True, modelId=model_id, modelDir=str(target), requiredBytes=25_000_000_000,
                    sources=list(recipe["sources"].values()))

    import torch
    torch.set_num_threads(min(8, torch.get_num_threads()))
    model_root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(model_root).free < 25_000_000_000:
        raise ValueError("Wan 本地转换需要目标盘至少 25 GB 可用空间。")
    with tempfile.TemporaryDirectory(dir=model_root, prefix=".wan-import-") as temporary:
        stage = Path(temporary) / model_id
        stage.mkdir()
        for relative, config in recipe["configs"].items():
            path = stage / relative
            path.parent.mkdir(exist_ok=True)
            write_json(path, config)
        files = {}
        for component, path in paths.items():
            progress(f"核对 Wan {component} 源文件")
            stamp = source_stamp(path)
            if file_sha256(path) != recipe["sources"][component]["sha256"]:
                raise ValueError(f"源文件 SHA-256 与已注册的 Wan 2.2 TI2V 5B 版本不符：{path}")
            progress(f"转换 Wan {component}")
            with ReadOnlyWeights(path) as reader:
                layout = weight_layout(component, reader, recipe["configs"][f"{component}/config.json"])
                if component == "text_encoder":
                    write_tokenizer(stage / "tokenizer", reader, recipe)
                basename = "model" if component == "text_encoder" else "diffusion_pytorch_model"
                relative = f"{component}/{basename}.safetensors"
                files[relative] = write_weights(stage / relative, reader, layout)
            if source_stamp(path) != stamp:
                raise ValueError(f"转换期间源文件发生变化：{path}")
        for path in sorted(stage.rglob("*")):
            relative = path.relative_to(stage).as_posix()
            if path.is_file() and relative not in files:
                files[relative] = {"bytes": path.stat().st_size, "sha256": file_sha256(path)}
        write_json(stage / "huiyu-model.json", dict(schemaVersion=1, modelId=model_id,
            revision=recipe["revision"], scope="converted-local-weights-sha256",
            sources=list(recipe["sources"].values()), files=[dict(path=p, **v) for p, v in sorted(files.items())]))
        if target.exists() or target.is_symlink():
            raise FileExistsError(f"目标目录在转换期间已被创建：{target}")
        stage.rename(target)
    return dict(ok=True, preparedModel=model_id, modelDir=str(target))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy-models", required=True, type=Path)
    parser.add_argument("--models-root", required=True, type=Path)
    parser.add_argument("--apply", action="store_true", help="Write a new native model directory")
    args = parser.parse_args()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = convert(args)
    except (OSError, ValueError, ImportError, KeyError, RuntimeError) as exc:
        print(json.dumps(dict(ok=False, message=str(exc)), ensure_ascii=False), flush=True)
        return 1
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
