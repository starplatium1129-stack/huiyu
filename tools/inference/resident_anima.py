"""One resident base and adapter group; fresh scheduling and denoiser state per job."""
from __future__ import annotations

import gc
import copy
import sys


def _can_unload_adapters(components):
    # PEFT 0.19 PiSSA/OLoRA/CorDA/LoftQ/LoRA-GA initialization can mutate
    # base weights. Preserve their existing reload behavior, and only reuse
    # ordinary LoRA configurations whose base layer survives unload unchanged.
    # https://github.com/huggingface/peft/blob/v0.19.0/src/peft/tuners/lora/layer.py
    for name in ("transformer", "text_conditioner"):
        for config in getattr(components[name], "peft_config", {}).values():
            if (config.init_lora_weights not in (True, False, "gaussian", "eva", "orthogonal")
                    or any(getattr(config, option, None) for option in
                           ("use_qalora", "use_bdlora", "arrow_config", "ensure_weight_tying", "megatron_config"))):
                return False
    return True


class PipelineCache:
    def __init__(self):
        self.identity = None
        self.components = None
        self.runtime_ready = False
        self.text_cache = None
        self.mask_cache = None
        self.weights_loaded = False

    def prepare(self, check):
        if not self.runtime_ready:
            check()
            self.runtime_ready = True

    def clear(self, *, keep_mask=False):
        had_resources = (self.components is not None or
                         (self.text_cache is not None and self.text_cache.bytes > 0) or
                         (not keep_mask and self.mask_cache is not None and self.mask_cache.components is not None))
        self.identity = self.components = None
        self.weights_loaded = False
        if self.text_cache is not None:
            self.text_cache.clear()
        if not keep_mask and self.mask_cache is not None:
            self.mask_cache.clear()
        if not had_resources:
            return
        gc.collect()
        cuda = getattr(sys.modules.get("torch"), "cuda", None)
        if cuda is not None and cuda.is_available():
            cuda.empty_cache()

    def acquire(self, identity, root, cfg, blocks, loras, load, load_loras):
        from diffusers import AnimaModularPipeline, FlowMatchEulerDiscreteScheduler, ClassifierFreeGuidance
        base_key = {key: value for key, value in identity.items() if key != "loras"}
        previous_base = ({key: value for key, value in self.identity.items() if key != "loras"}
                         if self.identity is not None else None)
        adapters_changed = (self.identity is None or
            [row["sha256"] for row in identity["loras"]] != [row["sha256"] for row in self.identity["loras"]])
        reused = base_key == previous_base and self.components is not None
        self.weights_loaded = False
        try:
            if reused and adapters_changed:
                reused = _can_unload_adapters(self.components)
            if not reused:
                self.clear(keep_mask=True)
                pipeline = load(root, cfg, blocks=blocks)
                load_loras(pipeline, loras)
                self.components = {name: pipeline.components[name] for name in
                                   ("text_encoder", "text_conditioner", "transformer", "vae", "tokenizer", "t5_tokenizer")}
                self.scheduler_config = dict(pipeline.scheduler.config)
                self.weights_loaded = True
            else:
                pipeline = AnimaModularPipeline(blocks=blocks)
                pipeline.update_components(**self.components,
                    scheduler=FlowMatchEulerDiscreteScheduler.from_config(self.scheduler_config),
                    guider=ClassifierFreeGuidance(guidance_scale=cfg))
                pipeline.set_progress_bar_config(disable=True)
            if reused and adapters_changed:
                # Anima's official mixin unloads BOTH transformer and conditioner,
                # removing PEFT wrappers/configs without merging into base weights.
                # https://github.com/huggingface/diffusers/blob/v0.41.0/src/diffusers/loaders/lora_base.py
                if self.identity["loras"]:
                    pipeline.unload_lora_weights()
                load_loras(pipeline, loras)
                self.weights_loaded = bool(loras)
            elif reused and identity != self.identity and loras:
                pipeline.set_adapters([f"huiyu_{i}" for i in range(len(loras))],
                                      adapter_weights=[row["strength"] for row in loras])
            self.identity = copy.deepcopy(identity)
        except Exception:
            # A failed unload/load/scale may have modified either shared component.
            self.clear()
            raise
        return pipeline, reused
