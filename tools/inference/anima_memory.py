"""Anima component residency using pinned Diffusers Modular offload hooks.

Follow Comfy's stage-based ownership: encoding, denoising and VAE execution do
not require all weights on CUDA together. No Comfy implementation is copied.
The existing resident mode retains the complete GPU model for warm throughput.
"""
import os

POLICY = os.environ.get("HUIYU_INFERENCE_MEMORY", "resident")
WEIGHTS = ("text_encoder", "text_conditioner", "transformer", "vae")


def validate():
    if POLICY not in ("resident", "offload"):
        raise ValueError("HUIYU_INFERENCE_MEMORY must be resident or offload")
    return POLICY


def upload_component(component, tools):
    """Retire one loaded CPU component before materializing the next one."""
    if validate() == "offload":
        return {"strategy": "deferred"}
    observation = {}
    if not tools("native_upload").try_packed_upload([component], observation=observation):
        component.to("cuda")
        observation["strategy"] = "module-to"
    return observation


class Residency:
    def __init__(self, components):
        self.policy, self.manager = validate(), None
        if self.policy == "offload":
            import torch
            from diffusers import ComponentsManager
            manager = ComponentsManager()
            try:
                for name in WEIGHTS:
                    manager.add(name, components[name])
                # Whole components switch at actual forwards, not each denoising
                # step. VAE encode/decode are both covered by upstream hooks.
                manager.enable_auto_cpu_offload(device=torch.device("cuda:0"),
                    offload_strategy=lambda hooks, model_id, model, execution_device: hooks)
            except BaseException:
                manager.disable_auto_cpu_offload()
                raise
            self.manager = manager

    def bind(self, pipeline):
        pipeline._huiyu_memory = self

    def offload_all(self):
        if self.manager is not None:
            import torch
            for hook in self.manager.model_hooks:
                hook.offload()
            # Returned tensors belong to the caller; only model weights retire.
            torch.cuda.empty_cache()

    def close(self):
        if self.manager is not None:
            self.manager.disable_auto_cpu_offload()
            self.manager.components.clear()
            self.manager = None
