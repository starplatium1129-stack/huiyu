"""Validate registered Krea style matrices before installing the PEFT adapter."""
import hashlib
import importlib.metadata
import json
import re
from dataclasses import fields

from huiyu_worker_lifecycle import WorkerError


def require_dependency():
    try:
        version = importlib.metadata.version("peft")
    except importlib.metadata.PackageNotFoundError as exc:
        raise WorkerError("DEPENDENCY_MISSING", "Krea 风格 LoRA 需要独立 adapters 环境中的 peft==0.19.0") from exc
    if version != "0.19.0":
        raise WorkerError("DEPENDENCY_VERSION", f"Krea 风格 LoRA 需要 peft==0.19.0，当前为 {version}")


def fingerprint(path, control):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            control.check()
            digest.update(chunk)
    return digest.hexdigest()


def apply(pipeline, path, control):
    import torch
    from peft import LoraConfig, get_peft_model_state_dict
    from safetensors import safe_open

    control.stage("adapters")
    # Inspect before the upstream loader can filter unsupported DoRA tensors.
    with safe_open(str(path), framework="pt", device="cpu") as source:
        keys = set(source.keys())
        metadata = source.metadata() or {}
        if not keys or any(not re.search(r"\.lora_[AB]\.weight$", key) for key in keys):
            raise WorkerError("NATIVE_LORA_UNSUPPORTED", "Krea 风格仅支持完整的 LoRA A/B 权重，不支持 DoRA 或额外权重")
        state, original = {}, {}
        for key in keys:
            control.check()
            name = key.removeprefix("model.diffusion_model.").removeprefix("base_model.model.")
            name = name.removeprefix("diffusion_model.").removeprefix("transformer.")
            target = name.rsplit(".lora_", 1)[0]
            try:
                pipeline.transformer.get_submodule(target)
            except AttributeError:
                # The pinned Krea converter maps blocks.N.attn.wq and trainer
                # names such as txtmlp.1 to their Diffusers projection paths.
                dest, table = "diffusion_model." + name, original
            else:
                dest, table = "transformer." + name, state
            if dest in table:
                raise WorkerError("NATIVE_LORA_UNSUPPORTED", f"重复的 Krea LoRA 目标：{dest}")
            table[dest] = source.get_tensor(key)
    config = None
    if "lora_adapter_metadata" in metadata:
        config = json.loads(metadata["lora_adapter_metadata"])
        json.dumps(config, allow_nan=False)
        allowed = {field.name for field in fields(LoraConfig)}
        if not isinstance(config, dict):
            raise WorkerError("NATIVE_LORA_UNSUPPORTED", "LoRA 配置需为对象")
        for key, value in config.items():
            component, _, field = key.partition(".")
            if component != "transformer" or field not in allowed:
                raise WorkerError("NATIVE_LORA_UNSUPPORTED", f"未知 Krea LoRA 配置：{key}")
            if field in {"use_dora", "modules_to_save", "target_parameters", "layer_replication",
                         "trainable_token_indices", "alora_invocation_tokens", "lora_bias"} and value:
                raise WorkerError("NATIVE_LORA_UNSUPPORTED", f"不支持的 LoRA 配置：{key}")
            if (field == "bias" and value != "none") or (field == "init_lora_weights" and value not in (True, False, "gaussian")):
                raise WorkerError("NATIVE_LORA_UNSUPPORTED", "不支持修改底模的 LoRA 初始化或 bias")
    if original:
        state.update(pipeline.lora_state_dict(original))
        del original
    if len(state) != len(keys):
        raise WorkerError("NATIVE_LORA_UNSUPPORTED", "Krea LoRA 转换存在遗漏或重复目标")
    for key, weight in state.items():
        control.check()
        match = re.fullmatch(r"transformer\.(.+)\.lora_([AB])\.weight", key)
        if not match or not weight.is_floating_point() or not torch.isfinite(weight).all().item():
            raise WorkerError("NATIVE_LORA_UNSUPPORTED", f"无效的 Krea LoRA 权重：{key}")
        target, side = match.groups()
        other = state.get(f"transformer.{target}.lora_{'B' if side == 'A' else 'A'}.weight")
        if other is None or weight.ndim != 2 or other.ndim != 2:
            raise WorkerError("NATIVE_LORA_UNSUPPORTED", f"LoRA 缺少配对矩阵：{target}")
        module = pipeline.transformer.get_submodule(target)
        a, b = (weight, other) if side == "A" else (other, weight)
        if (not isinstance(module, torch.nn.Linear) or a.shape[0] < 1 or a.shape[0] != b.shape[1]
                or a.shape[1] != module.in_features or b.shape[0] != module.out_features):
            raise WorkerError("NATIVE_LORA_UNSUPPORTED", f"LoRA 与 Krea 模型尺寸不匹配：{target}")
    expected = {key.removeprefix("transformer.") for key in state}
    pipeline.load_lora_into_transformer(state, transformer=pipeline.transformer, adapter_name="huiyu_style",
                                        metadata=config, _pipeline=pipeline, low_cpu_mem_usage=True)
    del state
    actual = set(get_peft_model_state_dict(pipeline.transformer, adapter_name="huiyu_style", save_embedding_layers=False))
    if actual != expected:
        raise WorkerError("NATIVE_LORA_UNSUPPORTED", "已加载的 Krea 风格权重与文件不一致")
    pipeline.set_adapters(["huiyu_style"], adapter_weights=[1.0])
    pipeline.transformer.eval()
    control.check()
