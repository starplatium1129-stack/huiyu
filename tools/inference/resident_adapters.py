"""One protected weight set; fresh pipeline, scheduler and guider per task.

Unsupported filesystems keep the original full-read, per-task release behavior.
Cancellation/failure discards the set; no partially executed state is reused.
Immutable file views and their protected identity stay resident between requests.
"""
import copy
from collections import OrderedDict
import hashlib
import inspect
import json
from huiyu_worker_lifecycle import load_sibling, settle_resources


def _copy_condition(value, device):
    import torch
    if isinstance(value, torch.Tensor):
        return value.detach().to(device=device, copy=True)
    if isinstance(value, tuple):
        return tuple(_copy_condition(item, device) for item in value)
    return value


def _condition_bytes(value):
    if isinstance(value, tuple):
        return sum(_condition_bytes(item) for item in value)
    return getattr(value, "nbytes", 0)


class PipelineCache:
    def __init__(self):
        self.lease = load_sibling("locked_identity").AssetIdentityLease(tree=True)
        self.style_lease = load_sibling("locked_identity").AssetIdentityLease(tree=False)
        self.style_identity = self.style_protection = None
        self.components = self.parameters = self.scope = self.identity = self.pipeline_class = None
        self.configs = {}
        self.memory = None
        self.protection = None
        self.conditioning = OrderedDict()
        self.upscale_cache = None
        self.sd_server = None

    def release_components(self):
        if self.memory is not None:
            self.memory.close()
            self.memory = None
        self.components = self.parameters = self.identity = self.pipeline_class = None
        self.configs.clear()
        self.conditioning.clear()

    def clear(self):
        if self.sd_server is not None:
            self.sd_server.close()
            self.sd_server = None
        if self.upscale_cache is not None:
            self.upscale_cache.clear()
            self.upscale_cache = None
        had_resources = self.components is not None or self.memory is not None
        self.release_components()
        self.lease.close()
        self.scope = None
        self.style_lease.close()
        self.style_identity = self.style_protection = None
        self.protection = None
        if had_resources:
            # Hook registries can form cycles. Retire the old set and allocator
            # reserves before loading a different model, not after its first image.
            settle_resources(False)

    @staticmethod
    def weight_scope(root, data, policy, style_path):
        return (str(root), data["modelId"], policy, data.get("mossTextPrecision", "bf16"), data.get("mossWeightPrecision", "auto"),
                str(style_path) if style_path else None, data.get("_h3TurboSteps"),
                data.get("h3Decoder", "original"), data.get("_h3AccelerationPath"), data.get("_h3DwdPath"),
                bool(data.get("_h3DwdPath") and data.get("_videoImage")))

    def acquire(self, root, spec, data, policy, control, fingerprint, load, error, *, style_path=None, prepared_identity=None):
        scope = self.weight_scope(root, data, policy, style_path)
        # Retire weights before attempting a new protection interval.
        if self.scope != scope or not self.lease.valid() or (style_path is not None and not self.style_lease.valid()):
            self.clear()
        control.stage("fingerprint")
        identity = self.lease.acquire(root, lambda path: fingerprint(path, control),
            prepared_identity=(lambda path: prepared_identity(path, control)) if prepared_identity else None)
        reused = (self.components is not None and self.identity == identity and self.protection is not None
                  and self.lease.protection_token() is self.protection)
        try:
            if not reused:
                if self.components is not None:
                    # acquire() can replace an interval lost after the initial
                    # valid() check. Equal bytes do not protect old mapped weights.
                    self.clear()
                    identity = self.lease.acquire(root, lambda path: fingerprint(path, control))
                protection = self.lease.protection_token()
                style = load_sibling("krea_style") if style_path is not None else None
                if style is not None:
                    self.style_identity = self.style_lease.acquire(style_path, lambda path: style.fingerprint(path, control))
                    self.style_protection = self.style_lease.protection_token()
                control.stage("loading")
                template, self.memory = load(identity, protection)
                if style is not None:
                    # Style changes reload the weight set before attaching hooks;
                    # ordinary jobs never inherit a previous style's PEFT layers.
                    style.apply(template, style_path, control)
                    if ((self.style_protection is not None and self.style_lease.protection_token() is not self.style_protection)
                            or (self.style_protection is None and style.fingerprint(style_path, control) != self.style_identity)):
                        raise error("MODEL_CHANGED", "Krea style changed during loading; generation rejected")
                control.stage("fingerprint")
                if ((protection is not None and self.lease.protection_token() is not protection)
                        or (protection is None and fingerprint(root, control) != identity)):
                    raise error("MODEL_CHANGED", "Model assets changed during loading; generation rejected")
                self.components = dict(template.components)
                self.parameters = ({} if spec.get("blocks") or spec["pipeline"] == "MOSSImagePipeline"
                                   else copy.deepcopy(template.parameters))
                self.pipeline_class = type(template)
                self.configs = {name: copy.deepcopy(dict(value.config)) for name, value in self.components.items()
                                if value is not None and (name.endswith("scheduler") or name == "guider")}
                del template
                control.stage("uploading")
                if spec["family"] == "krea2" and policy == "offload":
                    # PEFT replaces target Linear modules. Attach placement
                    # after applying the style so both base and LoRA tensors
                    # are owned by the same group throughout its lifetime.
                    pixels = data["width"] * data["height"]
                    self.memory = load_sibling("krea_adapter").Residency(self.components, pixels)
                elif self.memory is None:
                    self.memory = load_sibling("native_memory").Residency(self.components, policy)
                self.scope, self.identity = scope, identity
                self.protection = protection
            control.check()
            # Weight/tokenizer components are shared; mutable solver/guidance
            # state is always constructed from the pre-inference configuration.
            components = {name: (type(value).from_config(copy.deepcopy(self.configs[name]))
                                if name in self.configs else value) for name, value in self.components.items()}
            if spec["media"] == "video":
                pipeline = load_sibling("adapter_video").task_pipeline(self.pipeline_class, components,
                    copy.deepcopy(self.parameters), spec, data.get("_videoImage", False),
                    dwd=data.get("h3Decoder") == "dwd")
            else:
                pipeline = self.pipeline_class(**components, **copy.deepcopy(self.parameters))
            for component in self.memory.modules.values():
                registry = getattr(component, "_diffusers_hook", None)
                if registry is not None:
                    registry.reset_stateful_hooks(recurse=True)
            self.memory.bind(pipeline)
            if spec["family"] == "krea2":
                counts = dict(conditioningHits=0, conditioningMisses=0)
                pipeline._huiyu_krea_conditioning = counts
                self.bind_conditioning(pipeline, "get_text_hidden_states", counts=counts)
            elif spec["pipeline"] == "WanPipeline":
                # Both Wan pipelines call the same T5 recipe independently for
                # positive and negative text. Keep reusable negatives by prompt.
                self.bind_conditioning(pipeline, "_get_t5_prompt_embeds", data.get("videoAttention"))
            elif spec["pipeline"] == "MiniMaxH3ModularPipeline":
                load_sibling("h3_text").bind_conditioning(pipeline, self.conditioning, control)
            elif spec.get("packedManga"):
                self.bind_conditioning(pipeline, "_get_qwen_prompt_embeds")
            elif spec["family"] in ("qwen-image", "moss-image", "hunyuan-video-1.5", "kandinsky-6"):
                self.bind_conditioning(pipeline, attention=data.get("videoAttention"))
                if spec["family"] == "qwen-image":
                    self.bind_reference_latents(pipeline)
            if self.protection is not None and self.lease.protection_token() is not self.protection:
                raise error("MODEL_CHANGED", "Model protection was lost before inference; generation rejected")
            if self.style_protection is not None and self.style_lease.protection_token() is not self.style_protection:
                raise error("MODEL_CHANGED", "Krea style protection was lost before inference; generation rejected")
            return pipeline, identity, reused
        except BaseException:
            self.clear()
            raise

    def finish(self, success):
        if (not success or self.protection is None or self.lease.protection_token() is not self.protection
                or self.style_identity is not None and (self.style_protection is None or self.style_lease.protection_token() is not self.style_protection)):
            self.clear()
        elif self.memory is not None:
            self.memory.finish()

    def offload_idle_images(self):
        if (self.memory is not None and self.scope is not None and self.scope[2] == "offload"
                and load_sibling("adapter_contract").model(self.scope[1])["family"] in ("qwen-image", "moss-image", "krea2")):
            self.memory.offload_all()
            settle_resources(False)

    def store_condition(self, key, value):
        size = _condition_bytes(value)
        if size <= 64 * 1024**2:
            while self.conditioning and (len(self.conditioning) >= 8
                    or sum(entry[1] for entry in self.conditioning.values()) + size > 64 * 1024**2):
                self.conditioning.popitem(last=False)
            self.conditioning[key] = (_copy_condition(value, "cpu"), size)

    def bind_reference_latents(self, pipeline):
        import torch
        prepare_latents, encode_image = pipeline.prepare_latents, pipeline._encode_vae_image
        pipeline._huiyu_reference_hits = 0
        sources = iter(())

        def prepare(images, *args, **kwargs):
            nonlocal sources
            sources = iter(images) if images is not None else iter(())
            try:
                # Upstream packs each result in request order and draws fresh
                # target noise even when every reference is already encoded.
                return prepare_latents(images, *args, **kwargs)
            finally:
                sources = iter(())

        def encode(image, generator):
            # The BF16 VAE uses the posterior mode. Hash its preprocessed CPU
            # pixels before the device cast, independently for each reference.
            source = next(sources, None)
            if source is None or source.device.type != "cpu":
                return encode_image(image, generator)
            digest = hashlib.sha256(memoryview(source.contiguous().view(torch.uint8).numpy())).digest()
            key = ("qwen-reference", tuple(source.shape), source.dtype, digest, image.dtype, image.device,
                   pipeline.vae.use_tiling, pipeline.vae.use_slicing, isinstance(generator, list))
            if key in self.conditioning:
                self.conditioning.move_to_end(key)
                pipeline._huiyu_reference_hits += 1
                return _copy_condition(self.conditioning[key][0], image.device)
            encoded = encode_image(image, generator)
            self.store_condition(key, encoded)
            return encoded

        pipeline.prepare_latents = prepare
        pipeline._encode_vae_image = encode

    def bind_conditioning(self, pipeline, method="encode_prompt", attention=None, *, counts=None):
        import torch
        original = getattr(pipeline, method)
        signature = inspect.signature(original)

        def encode(*args, **kwargs):
            bound = signature.bind(*args, **kwargs)
            bound.apply_defaults()
            values = dict(bound.arguments)
            device = values.pop("device", None) or pipeline._execution_device
            if values.get("prompt_embeds") is not None or any(isinstance(value, torch.Tensor) for value in values.values()):
                return original(*args, **kwargs)
            if isinstance(values.get("dtype"), torch.dtype):
                values["dtype"] = str(values["dtype"])
            images = values.pop("image", None) or []
            digest = hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False).encode())
            for image in images:
                digest.update(f"{image.mode}:{image.size}".encode())
                digest.update(image.tobytes())
            key = (type(pipeline).__name__, attention, digest.digest())
            if key in self.conditioning:
                if counts is not None:
                    counts["conditioningHits"] += 1
                self.conditioning.move_to_end(key)
                return _copy_condition(self.conditioning[key][0], device)
            if counts is not None:
                counts["conditioningMisses"] += 1
            output = original(*args, **kwargs)
            self.store_condition(key, output)
            return output

        setattr(pipeline, method, encode)
