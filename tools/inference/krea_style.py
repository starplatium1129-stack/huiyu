"""Validate local Krea LoRA matrices before attaching them to the native transformer."""
from dataclasses import fields
import hashlib
import importlib.metadata
import json
import math
import re

from huiyu_worker_lifecycle import WorkerError, load_sibling


ADAPTER_NAMES = ("huiyu_style_1", "huiyu_style_2")
KEY = re.compile(r"(.+)\.(?:lora_(A|B|down|up)\.weight|(alpha))")


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


def invalid(message):
    return WorkerError("NATIVE_LORA_UNSUPPORTED", message)


def projections(transformer):
    from torch.nn import Linear

    targets = {}
    for name, module in transformer.named_modules():
        # A second adapter may hit the first one's wrapped Linear. Its private
        # A/B, dropout and base_layer are not independent checkpoint targets.
        if any(part == "base_layer" or part.startswith("lora_") for part in name.split(".")):
            continue
        base = module.get_base_layer() if hasattr(module, "get_base_layer") else module
        if isinstance(base, Linear):
            targets[name] = base
    return targets


def target_name(raw, targets, flattened, marker):
    from diffusers import Krea2Pipeline

    name = raw.removeprefix("model.diffusion_model.").removeprefix("base_model.model.")
    name = name.removeprefix("diffusion_model.").removeprefix("transformer.")
    if name.startswith("lora_unet_"):
        flat = name.removeprefix("lora_unet_")
        if flat in flattened:
            return flattened[flat]
        # The reference trainer has just two underscored path components.
        name = flat.replace("_", ".").replace("layerwise.blocks.", "layerwise_blocks.")
        name = name.replace("refiner.blocks.", "refiner_blocks.")
    if name in targets:
        return name
    # Resolve the reference trainer and AI-Toolkit spellings with the pinned
    # Diffusers Krea converter. No checkpoint tensors are allocated here.
    suffix = ".lora_A.weight"
    try:
        converted = Krea2Pipeline.lora_state_dict({f"diffusion_model.{name}{suffix}": marker})
    except (KeyError, ValueError) as exc:
        raise invalid(f"Krea 模型没有这个 LoRA 投影：{raw}") from exc
    if len(converted) == 1:
        target = next(iter(converted)).removeprefix("transformer.").removesuffix(suffix)
        if target in targets:
            return target
    raise invalid(f"Krea 模型没有这个 LoRA 投影：{raw}")


def scalar(value, name):
    if type(value) not in (int, float, str):
        raise invalid(f"无效的 LoRA 标量：{name}")
    try:
        value = float(value)
    except (OverflowError, ValueError) as exc:
        raise invalid(f"无效的 LoRA 标量：{name}") from exc
    if not math.isfinite(value):
        raise invalid(f"无效的 LoRA 标量：{name}")
    return value


def scaling_metadata(metadata):
    from peft import LoraConfig

    config = {}
    if "lora_adapter_metadata" in metadata:
        try:
            saved = json.loads(metadata["lora_adapter_metadata"])
            json.dumps(saved, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise invalid("无效的 Krea LoRA 配置") from exc
        if not isinstance(saved, dict):
            raise invalid("LoRA 配置需为对象")
        allowed = {field.name for field in fields(LoraConfig)}
        for key, value in saved.items():
            component, _, field = key.partition(".")
            if component != "transformer" or field not in allowed:
                raise invalid(f"未知 Krea LoRA 配置：{key}")
            if (field in {"use_dora", "use_bdlora", "use_qalora", "arrow_config", "modules_to_save", "target_parameters",
                          "layer_replication", "trainable_token_indices", "alora_invocation_tokens", "lora_bias",
                          "fan_in_fan_out", "ensure_weight_tying"} and value):
                raise invalid(f"不支持的 LoRA 配置：{key}")
            if (field == "bias" and value != "none") or (field == "init_lora_weights" and value not in (True, False, "gaussian")):
                raise invalid("不支持修改底模的 LoRA 初始化或 bias")
            config[field] = value
    for field in ("rank_pattern", "alpha_pattern"):
        if not isinstance(config.get(field, {}), dict):
            raise invalid(f"无效的 LoRA 配置：{field}")
    if type(config.get("use_rslora", False)) is not bool:
        raise invalid("无效的 LoRA 配置：use_rslora")
    global_alphas = {scalar(metadata[key], key) for key in ("lora_alpha", "ss_network_alpha")
                     if key in metadata and metadata[key] not in ("", "None", "null")}
    if len(global_alphas) > 1:
        raise invalid("LoRA 文件中有相互冲突的 alpha")
    return config, next(iter(global_alphas), None)


def configured_value(config, target, field, default_key):
    from peft.utils.other import get_pattern_key

    pattern = config.get(field, {})
    try:
        return pattern.get(get_pattern_key(pattern.keys(), target), config.get(default_key))
    except re.error as exc:
        raise invalid(f"无效的 LoRA 配置：{field}") from exc


def load_weights(transformer, source, control):
    import torch

    targets = projections(transformer)
    flattened = {name.replace(".", "_"): name for name in targets}
    if len(flattened) != len(targets):
        raise invalid("Krea 投影的缩写不唯一")
    names, pairs = {}, {}
    marker = torch.empty(0, device="cpu")
    for key in source.keys():
        control.check()
        match = KEY.fullmatch(key)
        if not match:
            raise invalid(f"Krea 仅支持普通 LoRA 的 A/B、down/up 与 alpha 权重：{key}")
        raw, side, alpha = match.groups()
        if raw not in names:
            names[raw] = target_name(raw, targets, flattened, marker)
        pair = pairs.setdefault(names[raw], {})
        side = {"down": "A", "up": "B"}.get(side, side) or alpha
        if side in pair:
            raise invalid(f"重复的 Krea LoRA 目标：{key}")
        pair[side] = key
    if not pairs:
        raise invalid("Krea LoRA 文件中没有投影权重")
    config, global_alpha = scaling_metadata(source.metadata() or {})
    state, ranks, alphas = {}, {}, {}
    for target, pair in pairs.items():
        control.check()
        if "A" not in pair or "B" not in pair:
            raise invalid(f"LoRA 缺少配对矩阵：{target}")
        a, b = (source.get_slice(pair[side]) for side in ("A", "B"))
        a_shape, b_shape = a.get_shape(), b.get_shape()
        base = targets[target]
        if (len(a_shape) != 2 or len(b_shape) != 2 or a_shape[0] < 1
                or a_shape != [b_shape[1], base.in_features] or b_shape[0] != base.out_features
                or any(weight.get_dtype() not in ("BF16", "F16", "F32", "F64") for weight in (a, b))):
            raise invalid(f"LoRA 与 Krea 模型尺寸或数据类型不匹配：{target}")
        rank = ranks[target] = a_shape[0]
        declared_rank = configured_value(config, target, "rank_pattern", "r")
        if declared_rank is not None and scalar(declared_rank, target) != rank:
            raise invalid(f"LoRA 配置与实际矩阵秩不符：{target}")
        # The optional scalar on this projection takes priority over the
        # file-wide alpha. Unscaled PEFT checkpoints default to alpha = rank.
        declared_alpha = configured_value(config, target, "alpha_pattern", "lora_alpha")
        alpha = scalar(declared_alpha, target) if declared_alpha is not None else global_alpha
        if "alpha" in pair:
            entry = source.get_slice(pair["alpha"])
            if entry.get_shape() not in ([], [1]) or entry.get_dtype() == "BOOL":
                raise invalid(f"LoRA alpha 需要单个数值：{target}")
            coefficient = scalar(source.get_tensor(pair["alpha"]).item(), target)
            if declared_alpha is not None and alpha != coefficient:
                raise invalid(f"LoRA 配置与权重中的 alpha 不符：{target}")
            alpha = coefficient
        alphas[target] = rank if alpha is None else alpha
        for side in ("A", "B"):
            weight = source.get_tensor(pair[side])
            if not torch.isfinite(weight).all().item():
                raise invalid(f"LoRA 权重含无效数值：{target}")
            state[f"transformer.{target}.lora_{side}.weight"] = weight
    # Derive PEFT targets and ranks only from the validated A/B matrices.
    # The two adapters can have different ranks and alphas at the same target.
    rank, alpha = next(iter(ranks.values())), next(iter(alphas.values()))
    peft_config = dict(r=rank, lora_alpha=alpha, target_modules=list(ranks), use_rslora=config.get("use_rslora", False),
                       rank_pattern={k: v for k, v in ranks.items() if v != rank},
                       alpha_pattern={k: v for k, v in alphas.items() if v != alpha})
    return state, {f"transformer.{key}": value for key, value in peft_config.items()}


def apply(pipeline, path, adapter_name, control):
    from peft import get_peft_model_state_dict

    control.stage("adapters")
    with load_sibling("mapped_weights").ReadOnlyWeights(path) as source:
        state, config = load_weights(pipeline.transformer, source, control)
    expected = {key.removeprefix("transformer.") for key in state}
    pipeline.load_lora_into_transformer(state, transformer=pipeline.transformer, adapter_name=adapter_name,
                                        metadata=config, _pipeline=pipeline, low_cpu_mem_usage=True)
    del state
    actual = set(get_peft_model_state_dict(pipeline.transformer, adapter_name=adapter_name, save_embedding_layers=False))
    if actual != expected:
        raise invalid("已加载的 Krea 风格权重与文件不一致")
    control.check()


def set_strengths(pipeline, strengths):
    import torch
    previous = getattr(pipeline.transformer, "_huiyu_style_strengths", None)
    if previous == tuple(strengths):
        return
    active = [(name, strength) for name, strength in zip(ADAPTER_NAMES, strengths) if strength != 0]
    # PEFT toggles requires_grad while selecting adapters. Weights restored by
    # offload hooks during sampling are inference tensors, including on reuse.
    with torch.inference_mode():
        if active:
            pipeline.enable_lora()
            pipeline.set_adapters([name for name, _ in active], adapter_weights=[strength for _, strength in active])
        else:
            pipeline.set_adapters(list(ADAPTER_NAMES[:len(strengths)]), adapter_weights=strengths)
            pipeline.disable_lora()
        pipeline.transformer.requires_grad_(False)
    pipeline.transformer._huiyu_style_strengths = tuple(strengths)
    pipeline.transformer.eval()
