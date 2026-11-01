"""MOSS task-owned invariants and resident, optional PyTorch compilation.

Block compilation follows ComfyUI's per-block execution boundary. Placement
hooks remain outside compiled forwards; no CUDA graphs, weight copies or
ComfyUI imports. Task caches never survive cancellation, completion or failure.
"""
import time


class Compiler:
    def __init__(self, transformer, encoder):
        self.control = None
        self.enabled = False
        self.failures = {}
        self.calls = {"dit": 0, "text": 0}
        self.allow_dit = True
        self.native_text = False
        for layer in transformer.layers:
            # Install before group offload wraps forward, so file transfers and
            # mutable placement hooks are never traced into the compute graph.
            layer.forward = self._wrap(layer.forward, "dit")
        shared = {}
        for module in encoder.modules():
            function = getattr(module, "chunk_gated_delta_rule", None)
            origin = getattr(function, "__module__", "")
            if origin.startswith("transformers."):
                if function not in shared:
                    shared[function] = self._wrap(function, "text")
                module.chunk_gated_delta_rule = shared[function]
            elif origin.startswith("fla."):
                self.native_text = True

    def begin(self, control, enabled, placement):
        self.control, self.enabled = control, enabled
        self.calls = {"dit": 0, "text": 0}
        self.announced = False
        rows = placement.observation()["components"]
        self.allow_dit = not any(row["name"] == "transformer" and row["mode"] == "leaf_level" for row in rows)

    def _wrap(self, original, kind):
        compiled = None

        def forward(*args, **kwargs):
            nonlocal compiled
            if not self.enabled or kind in self.failures or kind == "dit" and not self.allow_dit:
                return original(*args, **kwargs)
            import torch
            from torch._dynamo.exc import TorchDynamoException
            from torch.fx.experimental.symbolic_shapes import ConstraintViolationError
            self.control.check()
            try:
                if compiled is None:
                    if not self.announced:
                        self.control.stage("compiling")
                        self.announced = True
                    compiled = torch.compile(original, fullgraph=False, mode="default")
                if kind == "dit":
                    # Only image/text sequence lengths vary. Keep head, channel
                    # and modulation sizes static instead of dynamic=True on all.
                    for value in args[:2]:
                        torch._dynamo.mark_dynamic(value, 1)
                output = compiled(*args, **kwargs)
            except (TorchDynamoException, ConstraintViolationError) as error:
                device_error = self._device_failure(error, torch)
                if device_error is not None:
                    raise device_error
                self.failures[kind] = type(error).__name__
                self.control.stage("sampling" if kind == "dit" else "encoding")
                return original(*args, **kwargs)
            self.calls[kind] += 1
            self.control.check()
            return output

        return forward

    @staticmethod
    def _device_failure(error, torch):
        seen = set()
        failure = None
        while error is not None and id(error) not in seen:
            seen.add(id(error))
            if isinstance(error, torch.cuda.OutOfMemoryError):
                return error
            if any(message in str(error).lower() for message in ("cuda error:", "device-side assert", "out of memory")):
                failure = error
            error = error.__cause__ or error.__context__ or getattr(error, "inner_exception", None)
        return failure

    def finish(self):
        result = dict(requested=self.enabled, compiledBlockCalls=self.calls["dit"],
            compiledTextCalls=self.calls["text"], nativeTextKernel=self.native_text,
            ditFallback=(self.failures.get("dit") or ("leaf-offload" if not self.allow_dit else None)) if self.enabled else None,
            textFallback=self.failures.get("text") if self.enabled else None)
        self.control, self.enabled = None, False
        return result


class Execution:
    def __init__(self, control):
        self.control = control
        self.contexts = {}
        self.time_key = self.time_value = None
        self.cache_bytes = self.hits = self.misses = self.time_hits = 0
        self.timings = {}
        self.phase_name = None
        self.phase_started = time.perf_counter()

    def phase(self, name):
        self._settle_phase()
        self.phase_name = name
        self.control.stage(name)

    def _settle_phase(self):
        now = time.perf_counter()
        if self.phase_name is not None:
            self.timings[self.phase_name] = self.timings.get(self.phase_name, 0) + now - self.phase_started
        self.phase_started = now

    def modulation(self, timestep, batch, build):
        if self.time_key is not None and self.time_key[0] is timestep and self.time_key[1] == batch:
            self.time_hits += 1
            return self.time_value
        self.time_key, self.time_value = (timestep, batch), build()
        return self.time_value

    def context(self, key, source, mask, build):
        cached = self.contexts.get(key)
        if cached is not None and cached[0] is source and cached[1] is mask:
            self.hits += 1
            return cached[2]
        self.control.check()
        self.misses += 1
        output = build()
        size = sum(value.numel() * value.element_size() for value in output)
        if self.cache_bytes + size <= 64 * 1024**2:
            import torch
            free, _ = torch.cuda.mem_get_info(output[0].device)
            if free >= size + 512 * 1024**2:
                self.contexts[key] = (source, mask, output)
                self.cache_bytes += size
        return output

    def finish(self):
        self._settle_phase()
        result = dict(schemaVersion=1, timingMode="cpu-wall-no-extra-sync", timingsAreAdditive=False,
            timings=dict(self.timings), contextCache=dict(hits=self.hits, misses=self.misses,
                bytes=self.cache_bytes, modulationHits=self.time_hits), performanceVerified=False)
        self.contexts.clear()
        self.time_key = self.time_value = None
        return result
