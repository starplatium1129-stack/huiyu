"""Strict local Anima Kohya linear LoRA export reader; no file writes.

Original Anima module names are resolved by Diffusers 0.41.0's Apache-2.0
converter, then checked against the loaded model. Flattened names are matched
exactly, never reconstructed by guessing where underscores were dots.
https://github.com/huggingface/diffusers/blob/v0.41.0/src/diffusers/loaders/lora_conversion_utils.py
OneTrainer's format and alpha/rank convention were inspected; no AGPL code is
copied. Only plain linear LoRA down/up/alpha triples are supported.
"""
import json
from pathlib import Path
import math
import re


def _targets(pipeline):
    import torch
    from diffusers.loaders.lora_conversion_utils import _convert_non_diffusers_anima_lora_to_diffusers

    projections = [f"{kind}_attn.{projection}_proj" for kind in ("self", "cross")
                   for projection in ("q", "k", "v", "output")]
    projections += [f"adaln_modulation_{kind}.{index}" for kind in ("self_attn", "cross_attn", "mlp")
                    for index in (1, 2)] + ["mlp.layer1", "mlp.layer2"]
    sources = [f"blocks.{index}.{name}" for index in range(len(pipeline.transformer.transformer_blocks))
               for name in projections]
    sources += ["final_layer.adaln_modulation.1", "final_layer.adaln_modulation.2", "final_layer.linear",
                "t_embedder.1", "x_embedder.proj.1"]
    sources += [f"llm_adapter.{name}" for name, _ in pipeline.text_conditioner.named_modules() if name]
    result = {}
    for source in sources:
        raw = f"diffusion_model.{source}.lora_A.weight"
        mapped = _convert_non_diffusers_anima_lora_to_diffusers({raw: None})
        if len(mapped) != 1:
            raise ValueError("Anima LoRA converter returned an ambiguous target")
        target = next(iter(mapped)).removesuffix(".lora_A.weight")
        component, name = target.split(".", 1)
        if component not in ("transformer", "text_conditioner"):
            raise ValueError("Anima LoRA converter returned an unsupported component")
        try:
            module = getattr(pipeline, component).get_submodule(name)
        except (AttributeError, KeyError):
            continue
        # Existing ordinary PEFT adapters wrap the same base Linear.
        base = module.get_base_layer() if hasattr(module, "get_base_layer") else module
        if not isinstance(base, torch.nn.Linear):
            continue
        # PEFT implementation children are not independent original model targets.
        if any(part in {"base_layer", "lora_A", "lora_B"} for part in name.split(".")):
            continue
        alias = "lora_unet_" + source.replace(".", "_")
        if alias in result:
            raise ValueError(f"Ambiguous flattened Anima LoRA target: {alias}")
        result[alias] = (target, base.in_features, base.out_features)
    return result


def load_kohya(file, pipeline):
    """Read one already-open CPU safetensors file into checked native A/B weights."""
    import torch
    if "lora_adapter_metadata" in (file.metadata() or {}):
        raise ValueError("Kohya alpha triples cannot also override PEFT adapter metadata")
    targets = _targets(pipeline)
    groups = {}
    for key in file.keys():
        match = re.fullmatch(r"(lora_unet_.+)\.(alpha|lora_down\.weight|lora_up\.weight)", key)
        if not match or match[1] not in targets:
            raise ValueError(f"Unsupported or unknown Anima Kohya LoRA key: {key}")
        groups.setdefault(match[1], set()).add(match[2])
    if not groups:
        raise ValueError("Anima Kohya LoRA contains no linear adapters")
    converted = {}
    for alias, parts in groups.items():
        if parts != {"alpha", "lora_down.weight", "lora_up.weight"}:
            raise ValueError(f"Incomplete Anima Kohya LoRA triple: {alias}")
        target, inputs, outputs = targets[alias]
        down, up, alpha = [file.get_tensor(f"{alias}.{part}")
                           for part in ("lora_down.weight", "lora_up.weight", "alpha")]
        if any(value.dtype not in (torch.float16, torch.bfloat16, torch.float32)
               or value.device.type != "cpu" or not bool(torch.isfinite(value).all()) for value in (down, up, alpha)):
            raise ValueError(f"Anima Kohya LoRA requires finite CPU floating weights: {alias}")
        if (down.ndim != 2 or up.ndim != 2 or down.shape[0] <= 0 or
                tuple(down.shape) != (up.shape[1], inputs) or tuple(up.shape) != (outputs, down.shape[0]) or
                tuple(alpha.shape) not in ((), (1,))):
            raise ValueError(f"Anima Kohya LoRA rank/shape does not match the linear target: {alias}")
        scale = float(alpha.item()) / down.shape[0]
        if not math.isfinite(scale) or scale < 0:
            raise ValueError(f"Anima Kohya LoRA alpha/rank must be finite and nonnegative: {alias}")
        # PEFT defaults alpha to rank for native A/B dictionaries. Fold the
        # original multiplier into B in float32; do not mutate or round the file.
        scaled = up.float() * scale
        if not bool(torch.isfinite(scaled).all()):
            raise ValueError(f"Anima Kohya LoRA alpha scaling overflowed: {alias}")
        for side, value in (("A", down), ("B", scaled)):
            key = f"{target}.lora_{side}.weight"
            if key in converted:
                raise ValueError(f"Anima Kohya LoRA target collision: {key}")
            converted[key] = value
    return converted


class UnsupportedLora(ValueError):
    pass


def _inspect(pipeline, path, *, tensors=False):
    from safetensors import safe_open
    from peft import LoraConfig
    from dataclasses import fields
    config_fields = {field.name for field in fields(LoraConfig)}
    # Inspect before upstream can silently discard DoRA or unknown component keys.
    with safe_open(str(path), framework="pt", device="cpu") as file:
        keys = set(file.keys())
        metadata = file.metadata() or {}
        converted_weights = None
        if any(key.startswith("lora_unet_") for key in keys):
            try:
                converted_weights = load_kohya(file, pipeline)
            except ValueError as exc:
                raise UnsupportedLora(str(exc)) from exc
            keys = set(converted_weights)
        elif tensors:
            converted_weights = {key: file.get_tensor(key) for key in sorted(keys)}
    if any(key.startswith("diffusion_model.") for key in keys):
        from diffusers.loaders.lora_conversion_utils import _convert_non_diffusers_anima_lora_to_diffusers
        # This pinned upstream helper only renames Anima keys; inspect without loading tensors.
        converted = _convert_non_diffusers_anima_lora_to_diffusers(converted_weights if converted_weights is not None else dict.fromkeys(keys))
        if len(converted) != len(keys):
            raise UnsupportedLora("Anima LoRA conversion contains colliding target keys")
        keys = set(converted)
        if tensors:
            converted_weights = converted
    targets = {}
    for key in keys:
        match = re.fullmatch(r"(transformer|text_conditioner)\.(.+)\.lora_([AB])\.weight", key)
        if not match:
            raise UnsupportedLora(f"Expected native or diffusion_model-prefixed Anima LoRA A/B weights; unsupported key: {key}")
        component, target, side = match.groups()
        other = f"{component}.{target}.lora_{'B' if side == 'A' else 'A'}.weight"
        if other not in keys:
            raise UnsupportedLora(f"Unpaired LoRA weight: {key}")
        try:
            getattr(pipeline, component).get_submodule(target)
        except (AttributeError, KeyError) as exc:
            raise UnsupportedLora(f"Unknown Anima LoRA target: {component}.{target}") from exc
        targets.setdefault(component, set()).add(key.removeprefix(component + "."))
    if not targets:
        raise UnsupportedLora("LoRA contains no supported weights")
    if "lora_adapter_metadata" in metadata:
        try:
            config = json.loads(metadata["lora_adapter_metadata"])
            json.dumps(config, allow_nan=False)
        except (ValueError, TypeError) as exc:
            raise UnsupportedLora("Malformed LoRA adapter metadata") from exc
        if not isinstance(config, dict):
            raise UnsupportedLora("LoRA adapter metadata must be an object")
        for key, value in config.items():
            component, _, field = key.partition(".")
            if component not in targets or field not in config_fields:
                raise UnsupportedLora(f"Unsupported LoRA metadata: {key}")
            if field in {"use_dora", "modules_to_save", "target_parameters", "layer_replication", "trainable_token_indices", "alora_invocation_tokens", "lora_bias"} and value:
                raise UnsupportedLora(f"Unsupported LoRA option: {key}")
            if field == "bias" and value != "none":
                raise UnsupportedLora("LoRA bias weights are unsupported")
    return converted_weights, targets, "lora_adapter_metadata" in metadata


def _check_loaded(pipeline, name, targets):
    from peft import get_peft_model_state_dict
    for component, expected in targets.items():
        actual = set(get_peft_model_state_dict(getattr(pipeline, component), adapter_name=name, save_embedding_layers=False))
        if actual != expected:
            raise UnsupportedLora(f"Loaded {component} adapter keys do not match the checkpoint")


def _activate(pipeline, adapters):
    pipeline.set_adapters([f"huiyu_{index}" for index in range(len(adapters))],
                          adapter_weights=[row["strength"] for row in adapters])
    # Newly injected PEFT children must also be in inference mode.
    pipeline.transformer.eval()
    pipeline.text_conditioner.eval()


def load_loras(pipeline, adapters):
    if not adapters:
        return
    for index, adapter in enumerate(adapters):
        path, name = Path(adapter["path"]), f"huiyu_{index}"
        converted_weights, targets, _ = _inspect(pipeline, path)
        pipeline.load_lora_weights(converted_weights if converted_weights is not None else str(path.parent),
                                   **({} if converted_weights is not None else {"weight_name": path.name}),
                                   adapter_name=name, local_files_only=True, use_safetensors=True)
        _check_loaded(pipeline, name, targets)
    _activate(pipeline, adapters)


def try_hotswap(pipeline, adapters):
    """Replace a same-structure ordinary group in place, or return False untouched.

    The caller restores any fusion first. Every file/component is preflighted
    before the first mutation; execution failures propagate and require the
    resident owner to discard the whole model. No partial fallback is attempted.
    Explicit PEFT metadata/variants retain the ordinary reload path.
    """
    if not adapters:
        return False
    import torch
    from peft import get_peft_model_state_dict
    from peft.tuners.lora.layer import Linear
    from peft.utils.hotswap import check_hotswap_configs_compatible
    from diffusers.utils.peft_utils import _create_lora_config

    prepared = []
    for index, adapter in enumerate(adapters):
        strength = adapter["strength"]
        if isinstance(strength, bool) or not isinstance(strength, (int, float)) or not math.isfinite(strength):
            raise UnsupportedLora("LoRA strength must be finite")
        state, targets, metadata_override = _inspect(pipeline, Path(adapter["path"]), tensors=True)
        prepared.append((f"huiyu_{index}", state, targets, metadata_override))
    components = {name: getattr(pipeline, name) for name in ("transformer", "text_conditioner")}
    for component, model in components.items():
        expected_names = {name for name, _, targets, _ in prepared if component in targets}
        if set(getattr(model, "peft_config", {})) != expected_names:
            return False
    # Do not supply path-based loaders after this point: the prepared tensors
    # are precisely the bytes inspected below, not another read of a changed file.
    for name, state, targets, metadata_override in prepared:
        if metadata_override:
            return False
        for component, expected in targets.items():
            model = components[component]
            current = get_peft_model_state_dict(model, adapter_name=name, save_embedding_layers=False)
            if set(current) != expected:
                return False
            incoming = {key: state[f"{component}.{key}"] for key in sorted(expected)}
            ranks = {}
            for key, tensor in incoming.items():
                if (tensor.dtype not in (torch.float16, torch.bfloat16, torch.float32)
                        or tensor.device.type != "cpu" or not bool(torch.isfinite(tensor).all())):
                    raise UnsupportedLora(f"Hotswap requires finite CPU floating LoRA weights: {component}.{key}")
                if tensor.ndim != 2 or tensor.shape != current[key].shape:
                    return False
                target, side = key.rsplit(".lora_", 1)
                layer = model.get_submodule(target)
                if type(layer) is not Linear or layer.merged:
                    return False
                parameter = getattr(layer, "lora_" + side[0])[name].weight
                # PEFT swaps tensor storage without retaining the destination
                # dtype. In particular Kohya's alpha-folded FP32 B must not
                # turn an existing BF16 adapter into a mixed-dtype projection.
                normalized = tensor.to(dtype=parameter.dtype)
                if not bool(torch.isfinite(normalized).all()):
                    raise UnsupportedLora(f"Hotswap dtype conversion overflowed: {component}.{key}")
                state[f"{component}.{key}"] = normalized
                if side == "B.weight":
                    ranks[f"^{key}"] = tensor.shape[1]
            candidate = _create_lora_config(incoming, None, None, ranks,
                model_state_dict=model.state_dict(), adapter_name=name)
            current_config = model.peft_config[name]
            current_options, candidate_options = current_config.to_dict(), candidate.to_dict()
            # PEFT 0.19 condenses >=20 target paths into equivalent suffixes at
            # injection (tuners_utils.py:837-862). Compare the actual loaded
            # target paths already checked above, not those two spellings.
            # No runtime rank/alpha/variant or source metadata is ignored.
            current_options["target_modules"] = {key.rsplit(".lora_", 1)[0] for key in current}
            candidate_options["target_modules"] = {key.rsplit(".lora_", 1)[0] for key in expected}
            # Only the same ordinary default configuration can reach mutation.
            # PiSSA/OLoRA/DoRA, different alpha/rank patterns, dropout, and other
            # PEFT behavior changes remain on the checked unload/load path.
            if current_options != candidate_options:
                return False
            check_hotswap_configs_compatible(current_config, candidate)
    for name, state, targets, _ in prepared:
        pipeline.load_lora_weights(state, adapter_name=name, hotswap=True,
                                   local_files_only=True, use_safetensors=True)
        _check_loaded(pipeline, name, targets)
    _activate(pipeline, adapters)
    return True
