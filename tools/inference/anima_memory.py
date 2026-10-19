"""Anima placement through the shared budgeted native memory owner."""
import os
from functools import lru_cache

POLICY = os.environ.get("HUIYU_INFERENCE_MEMORY", "resident")
WEIGHTS = ("text_encoder", "text_conditioner", "transformer", "vae")


def validate():
    if POLICY not in ("resident", "offload"):
        raise ValueError("HUIYU_INFERENCE_MEMORY must be resident or offload")
    _memory_class()
    return POLICY


@lru_cache(maxsize=1)
def _memory_class():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("huiyu_native_memory", Path(__file__).with_name("native_memory.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Residency


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
        self.policy = validate()
        self.scheduler = _memory_class()({name: components[name] for name in WEIGHTS}, self.policy)

    def bind(self, pipeline):
        self.scheduler.bind(pipeline)
        pipeline._huiyu_memory = self

    def observation(self):
        return self.scheduler.observation()

    def offload_all(self):
        import torch
        self.scheduler.offload_all()
        torch.cuda.empty_cache()

    def close(self):
        self.scheduler.close()
