"""One resident base and adapter group; fresh scheduling and denoiser state per job."""
from __future__ import annotations

import gc
import copy
import sys
import time
from concurrent.futures import ThreadPoolExecutor


def load_weights(name, cls, path, **kwargs):
    component, info = cls.from_pretrained(path, output_loading_info=True, **kwargs)
    # Use upstream's final tied/ignored-key report; unexpected export heads are allowed.
    issues = [key for key in ("missing_keys", "mismatched_keys", "error_msgs") if info.get(key)]
    if issues:
        raise ValueError(f"Anima {name} weights incomplete ({', '.join(issues)}); prepare a matching local export")
    return component


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
        self.file_identity = None
        self.fusion = None
        self.memory = None
        self.reused_components = ()

    def prepare(self, check):
        if not self.runtime_ready:
            check()
            self.runtime_ready = True

    def fingerprint(self, root, loras, tools):
        if self.file_identity is None:
            self.file_identity = tools("locked_identity").IdentityLease()
        profile = tools("teacache_profile")
        return self.file_identity.acquire(root, loras, profile.model_identity, profile.adapter_identity)

    def prepare_and_fingerprint(self, check, root, loras, tools):
        # Capture the stdlib-only hash helpers before dependencies refreshes its
        # module cache. This work and ML imports are independent within the job.
        helpers = {name: tools(name) for name in ("locked_identity", "teacache_profile")}
        def identify():
            started = time.perf_counter()
            identity = self.fingerprint(root, loras, helpers.__getitem__)
            return identity, time.perf_counter() - started
        if self.runtime_ready:
            return identify()
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                # Keep identity handles and notifications on the single resident
                # caller that owns them. Only dependency imports run in the pool.
                future = pool.submit(self.prepare, check)
                result = identify()
                future.result()
                return result
        except BaseException:
            # The executor has joined before handles can be retired.
            self.clear()
            raise

    def clear(self, *, keep_mask=False, keep_fingerprint=False, keep_text=False):
        if not keep_fingerprint and self.file_identity is not None:
            self.file_identity.close()
        had_resources = (self.components is not None or
                         (self.text_cache is not None and self.text_cache.bytes > 0) or
                         (not keep_mask and self.mask_cache is not None and self.mask_cache.components is not None))
        self.identity = self.components = None
        self.weights_loaded = False
        self.reused_components = ()
        if self.memory is not None:
            self.memory.close()
            self.memory = None
        if self.fusion is not None:
            self.fusion.clear()
            self.fusion = None
        if not keep_text and self.text_cache is not None:
            self.text_cache.clear()
        if not keep_mask and self.mask_cache is not None:
            self.mask_cache.clear()
        if not had_resources:
            return
        gc.collect()
        cuda = getattr(sys.modules.get("torch"), "cuda", None)
        if cuda is not None and cuda.is_available():
            cuda.empty_cache()

    def acquire(self, identity, root, cfg, blocks, loras, load, load_loras, try_hotswap=None, *, memory_tools):
        from diffusers import AnimaModularPipeline, FlowMatchEulerDiscreteScheduler, ClassifierFreeGuidance
        base_key = {key: value for key, value in identity.items() if key != "loras"}
        previous_base = ({key: value for key, value in self.identity.items() if key != "loras"}
                         if self.identity is not None else None)
        adapters_changed = (self.identity is None or
            [row["sha256"] for row in identity["loras"]] != [row["sha256"] for row in self.identity["loras"]])
        reused = base_key == previous_base and self.components is not None
        self.weights_loaded = False
        self.reused_components = ()
        try:
            if (reused and self.fusion is not None and self.fusion.source_bytes
                    and not self.file_identity.base_is_valid(root, identity["modelSha256"])):
                reused = False
            if reused and adapters_changed:
                reused = _can_unload_adapters(self.components)
            if self.memory is not None and (not reused or identity != self.identity):
                self.memory.close()
                self.memory = None
            if not reused:
                previous = self.identity.get("componentSha256", {}) if self.identity else {}
                current = identity.get("componentSha256", {})
                # LoRA can mutate transformer/conditioner; those always reload.
                shared = {name: self.components[name] for name in
                    ("text_encoder", "vae", "tokenizer", "t5_tokenizer")
                    if self.components is not None and name in current and previous.get(name) == current[name]}
                keep_text = all(name in shared for name in ("text_encoder", "tokenizer", "t5_tokenizer"))
                # The just-validated read lease must protect the ensuing load.
                self.clear(keep_mask=True, keep_fingerprint=True, keep_text=keep_text)
                pipeline = load(root, cfg, blocks=blocks, reusable=shared)
                self.reused_components = pipeline._huiyu_component_reuse
                if keep_text and not all(name in self.reused_components for name in
                        ("text_encoder", "tokenizer", "t5_tokenizer")) and self.text_cache is not None:
                    self.text_cache.clear()
                load_loras(pipeline, loras)
                self.components = {name: pipeline.components[name] for name in
                                   ("text_encoder", "text_conditioner", "transformer", "vae", "tokenizer", "t5_tokenizer")}
                self.scheduler_config = dict(pipeline.scheduler.config)
                self.weights_loaded = True
                self.fusion = getattr(self.components["transformer"], "_huiyu_lora_fusion", None)
            else:
                pipeline = AnimaModularPipeline(blocks=blocks)
                pipeline.update_components(**self.components,
                    scheduler=FlowMatchEulerDiscreteScheduler.from_config(self.scheduler_config),
                    guider=ClassifierFreeGuidance(guidance_scale=cfg))
                pipeline.set_progress_bar_config(disable=True)
            if reused and identity != self.identity and self.fusion is not None:
                # Restore before set_adapters/unload can replace scales/modules.
                self.fusion.restore()
            if reused and adapters_changed:
                # Anima's official mixin unloads BOTH transformer and conditioner,
                # removing PEFT wrappers/configs without merging into base weights.
                # https://github.com/huggingface/diffusers/blob/v0.41.0/src/diffusers/loaders/lora_base.py
                swapped = bool(self.identity["loras"] and loras and try_hotswap is not None
                               and try_hotswap(pipeline, loras))
                if not swapped:
                    if self.fusion is not None:
                        self.fusion.clear()
                    if self.identity["loras"]:
                        pipeline.unload_lora_weights()
                    load_loras(pipeline, loras)
                self.weights_loaded = bool(loras)
            elif reused and identity != self.identity and loras:
                pipeline.set_adapters([f"huiyu_{i}" for i in range(len(loras))],
                                      adapter_weights=[row["strength"] for row in loras])
            if self.fusion is not None and (not reused or identity != self.identity):
                if self.file_identity is not None and self.file_identity.base_is_valid(root, identity["modelSha256"]):
                    lease, model_sha256 = self.file_identity, identity["modelSha256"]
                    self.fusion.bind_source(root, model_sha256,
                        lambda: lease.base_is_valid(root, model_sha256))
                self.fusion.fuse(self.components,
                    stage_device="cuda:0" if memory_tools.POLICY == "offload" else None)
            if self.memory is None:
                self.memory = memory_tools.Residency(self.components)
            self.memory.bind(pipeline)
            self.identity = copy.deepcopy(identity)
        except Exception:
            # A failed unload/load/scale may have modified either shared component.
            self.clear()
            raise
        return pipeline, reused
