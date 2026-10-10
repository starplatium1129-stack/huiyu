"""One resident weight set; every request gets fresh scheduling and denoiser state."""
from __future__ import annotations

import gc
import copy


class PipelineCache:
    def __init__(self):
        self.identity = None
        self.components = None
        self.runtime_ready = False
        self.text_cache = None

    def prepare(self, check):
        if not self.runtime_ready:
            check()
            self.runtime_ready = True

    def clear(self):
        self.identity = self.components = None
        if self.text_cache is not None:
            self.text_cache.clear()
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def acquire(self, identity, root, cfg, blocks, loras, load, load_loras):
        from diffusers import AnimaModularPipeline, FlowMatchEulerDiscreteScheduler, ClassifierFreeGuidance
        weight_key = {**identity, "loras": [row["sha256"] for row in identity["loras"]]}
        previous_key = ({**self.identity, "loras": [row["sha256"] for row in self.identity["loras"]]}
                        if self.identity is not None else None)
        reused = weight_key == previous_key and self.components is not None
        if not reused:
            self.clear()
            pipeline = load(root, cfg, blocks=blocks)
            load_loras(pipeline, loras)
            self.components = {name: pipeline.components[name] for name in
                               ("text_encoder", "text_conditioner", "transformer", "vae", "tokenizer", "t5_tokenizer")}
            self.scheduler_config = dict(pipeline.scheduler.config)
        else:
            pipeline = AnimaModularPipeline(blocks=blocks)
            pipeline.update_components(**self.components,
                scheduler=FlowMatchEulerDiscreteScheduler.from_config(self.scheduler_config),
                guider=ClassifierFreeGuidance(guidance_scale=cfg))
            pipeline.set_progress_bar_config(disable=True)
            if identity != self.identity and loras:
                pipeline.set_adapters([f"huiyu_{i}" for i in range(len(loras))],
                                      adapter_weights=[row["strength"] for row in loras])
        self.identity = copy.deepcopy(identity)
        return pipeline, reused
