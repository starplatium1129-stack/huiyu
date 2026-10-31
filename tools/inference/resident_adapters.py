"""One protected weight set; fresh pipeline, scheduler and guider per task.

Unsupported filesystems keep the original full-read, per-task release behavior.
Cancellation/failure discards the set; no partially executed state is reused.
Immutable file views and their protected identity stay resident between requests.
"""
import copy
import hashlib
import inspect
import json
from huiyu_worker_lifecycle import load_sibling, settle_resources


class PipelineCache:
    def __init__(self):
        self.lease = load_sibling("locked_identity").AssetIdentityLease(tree=True)
        self.style_lease = load_sibling("locked_identity").AssetIdentityLease(tree=False)
        self.style_identity = self.style_protection = None
        self.components = self.parameters = self.scope = self.identity = self.pipeline_class = None
        self.configs = {}
        self.memory = None
        self.protection = None
        self.conditioning = {}

    def release_components(self):
        if self.memory is not None:
            self.memory.close()
            self.memory = None
        self.components = self.parameters = self.identity = self.pipeline_class = None
        self.configs.clear()
        self.conditioning.clear()

    def clear(self):
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

    def acquire(self, root, spec, data, policy, control, fingerprint, load, error, *, style_path=None, prepared_identity=None):
        scope = (str(root), data["modelId"], policy, str(style_path) if style_path else None)
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
                template, self.memory = load()
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
                self.parameters = ({} if spec["pipeline"] in ("MiniMaxH3ModularPipeline", "MOSSImagePipeline")
                                   else copy.deepcopy(template.parameters))
                self.pipeline_class = type(template)
                self.configs = {name: copy.deepcopy(dict(value.config)) for name, value in self.components.items()
                                if value is not None and (name.endswith("scheduler") or name == "guider")}
                del template
                control.stage("uploading")
                if self.memory is None:
                    self.memory = load_sibling("native_memory").Residency(self.components, policy)
                self.scope, self.identity = scope, identity
                self.protection = protection
            control.check()
            # Weight/tokenizer components are shared; mutable solver/guidance
            # state is always constructed from the pre-inference configuration.
            components = {name: (type(value).from_config(copy.deepcopy(self.configs[name]))
                                if name in self.configs else value) for name, value in self.components.items()}
            if spec["pipeline"] == "MiniMaxH3ModularPipeline":
                pipeline = self.pipeline_class(workflow="t2va")
                pipeline.update_components(**components)
            else:
                pipeline = self.pipeline_class(**components, **copy.deepcopy(self.parameters))
            for component in self.memory.modules.values():
                registry = getattr(component, "_diffusers_hook", None)
                if registry is not None:
                    registry.reset_stateful_hooks(recurse=True)
            self.memory.bind(pipeline)
            if spec["family"] in ("qwen-image", "moss-image"):
                self.bind_conditioning(pipeline)
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

    def bind_conditioning(self, pipeline):
        import torch
        original = pipeline.encode_prompt
        signature = inspect.signature(original)

        def copy_tensors(value, device):
            if isinstance(value, torch.Tensor):
                return value.detach().to(device=device, copy=True)
            if isinstance(value, tuple):
                return tuple(copy_tensors(item, device) for item in value)
            return value

        def encode(*args, **kwargs):
            bound = signature.bind(*args, **kwargs)
            bound.apply_defaults()
            values = dict(bound.arguments)
            device = values.pop("device", None) or pipeline._execution_device
            if values.get("prompt_embeds") is not None:
                return original(*args, **kwargs)
            images = values.pop("image", None) or []
            digest = hashlib.sha256(json.dumps(values, sort_keys=True, ensure_ascii=False).encode())
            for image in images:
                digest.update(f"{image.mode}:{image.size}".encode())
                digest.update(image.tobytes())
            key = digest.digest()
            if key in self.conditioning:
                return copy_tensors(self.conditioning[key], device)
            output = original(*args, **kwargs)
            if len(self.conditioning) >= 2:
                self.conditioning.pop(next(iter(self.conditioning)))
            self.conditioning[key] = copy_tensors(output, "cpu")
            return output

        pipeline.encode_prompt = encode
