"""Anima placement through the shared budgeted native memory owner."""
import os
from functools import lru_cache

POLICY = os.environ.get("HUIYU_INFERENCE_MEMORY", "auto")
WEIGHTS = ("text_encoder", "text_conditioner", "transformer", "vae")


def validate():
    if POLICY not in ("auto", "resident", "offload"):
        raise ValueError("HUIYU_INFERENCE_MEMORY must be auto, resident or offload")
    _memory()
    return POLICY


@lru_cache(maxsize=1)
def _memory():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("huiyu_native_memory", Path(__file__).with_name("native_memory.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def upload_component(component, tools, device):
    """Retire one loaded CPU component before materializing the next one."""
    if device.memory_policy == "offload":
        return {"strategy": "deferred"}
    observation = {}
    if device.backend != "cuda" or not tools("native_upload").try_packed_upload(
            [component], target_device=device.device, observation=observation):
        component.to(device.device)
        observation["strategy"] = "module-to"
    return observation


class Residency:
    def __init__(self, components, device):
        self.device = device
        self.policy = device.memory_policy
        self.scheduler = _memory().Residency({name: components[name] for name in WEIGHTS},
                                             self.policy, device=device.device)

    def free_bytes(self):
        return _memory().memory_info(self.device.device)[0]

    def bind(self, pipeline):
        self.scheduler.bind(pipeline)
        pipeline._huiyu_memory = self

    def observation(self):
        return self.scheduler.observation()

    def offload_all(self):
        self.scheduler.offload_all()
        self.device.api.empty_cache()

    def close(self):
        self.scheduler.close()
