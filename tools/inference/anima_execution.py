"""Task-owned exact RoPE reuse and guarded Cosmos block compilation.

The pinned PyTorch 2.8 compiler keeps its guards. A warm graph miss uses eager
execution for that block for the rest of the task; CUDA failures still escape.
No conditioning/LoRA outputs or sampling approximations are cached here.
"""
from contextlib import contextmanager
import time


class Execution:
    def __init__(self, transformer):
        self.active = False
        self.kernel_backend = "pytorch"
        self.task = 0
        self.failures = set()
        self.rope = {}
        self.check = lambda: None
        original = transformer.rope.forward

        def rope(hidden_states, fps=None):
            if not self.active:
                return original(hidden_states, fps=fps)
            self.check()
            key = (tuple(hidden_states.shape[-3:]), hidden_states.device, fps)
            if key in self.rope:
                self.rope_hits += 1
                return self.rope[key]
            self.rope_misses += 1
            result = original(hidden_states, fps=fps)
            size = sum(value.numel() * value.element_size() for value in result)
            if self.rope_bytes + size <= 16 * 1024**2:
                self.rope[key] = result
                self.rope_bytes += size
            return result

        transformer.rope.forward = rope

    def compile_block(self, original):
        import torch
        compiled, warmed, failure, eager_task = None, False, None, -1

        def forward(*args, **kwargs):
            nonlocal compiled, warmed, failure, eager_task
            if not self.active or failure or eager_task == self.task or not self.allow_compile:
                return original(*args, **kwargs)
            from torch._dynamo.exc import RecompileError, TorchDynamoException
            from torch.fx.experimental.symbolic_shapes import ConstraintViolationError
            self.check()
            try:
                if compiled is None:
                    compiled = torch.compile(original, fullgraph=False, mode="default")
                # Only the sample and condition sequence axes vary. Keep channel,
                # head and modulation dimensions static, as in the MOSS path.
                for value in args[:2]:
                    if isinstance(value, torch.Tensor) and value.ndim == 3:
                        torch._dynamo.maybe_mark_dynamic(value, 1)
                with torch.compiler.set_stance("fail_on_recompile" if warmed else "default"):
                    output = compiled(*args, **kwargs)
                warmed = True
            except (TorchDynamoException, ConstraintViolationError, RuntimeError) as error:
                device_error = self._device_failure(error, torch)
                if device_error is not None:
                    raise device_error
                # PyTorch 2.8 omits the period present in 2.9's stance error.
                if isinstance(error, RecompileError) or str(error).startswith(
                    "Detected recompile when torch.compile stance is 'fail_on_recompile'"
                ):
                    eager_task = self.task
                    self.recompile_skips += 1
                elif isinstance(error, (TorchDynamoException, ConstraintViolationError)):
                    failure = type(error).__name__
                    self.failures.add(failure if failure in ("TorchDynamoException", "BackendCompilerFailed",
                        "ConstraintViolationError", "Unsupported", "InternalTorchDynamoError", "UserError",
                        "RecompileLimitExceeded") else "CompilerError")
                else:
                    raise
                return original(*args, **kwargs)
            self.compiled_calls += 1
            self.check()
            return output

        return forward

    @staticmethod
    def _device_failure(error, torch):
        seen, failure = set(), None
        while error is not None and id(error) not in seen:
            seen.add(id(error))
            if isinstance(error, torch.cuda.OutOfMemoryError):
                return error
            if any(message in str(error).lower() for message in ("cuda error:", "device-side assert", "out of memory")):
                failure = error
            error = error.__cause__ or error.__context__ or getattr(error, "inner_exception", None)
        return failure

    def phase(self, name):
        if not self.active or name == self.phase_name:
            return
        now = time.perf_counter()
        if self.phase_name is not None:
            self.timings[self.phase_name] = self.timings.get(self.phase_name, 0) + now - self.phase_started
        self.phase_name = name if name in ("encoding", "sampling", "decoding") else None
        self.phase_started = now

    @contextmanager
    def track(self, pipeline, stage, check):
        self.task += 1
        self.active, self.check = True, check
        self.rope_hits = self.rope_misses = self.rope_bytes = 0
        self.compiled_calls = self.recompile_skips = 0
        self.timings, self.phase_name, self.phase_started = {}, None, time.perf_counter()
        self.allow_compile = not any(row["name"] == "transformer" and row["mode"] == "leaf_level"
                                     for row in pipeline._huiyu_memory.observation()["components"])
        handles = []
        def enter(name):
            if self.phase_name != name:
                stage(name)
        try:
            for component, name in ((pipeline.text_encoder, "encoding"), (pipeline.text_conditioner, "encoding"),
                                    (pipeline.transformer, "sampling")):
                handles.append(component.register_forward_pre_hook(lambda *_args, name=name: enter(name)))
            yield
        finally:
            self.phase(None)
            for handle in handles:
                handle.remove()
            self.result = dict(schemaVersion=1, timingMode="cpu-wall-no-extra-sync", timingsAreAdditive=False,
                kernelBackend=self.kernel_backend, kernelScope="configured",
                timings=dict(self.timings), ropeCache=dict(hits=self.rope_hits, misses=self.rope_misses, bytes=self.rope_bytes),
                compile=dict(compiledBlockCalls=self.compiled_calls, recompileSkips=self.recompile_skips,
                             failures=sorted(self.failures), leafOffload=not self.allow_compile), performanceVerified=False)
            self.rope.clear()
            self.active, self.check = False, lambda: None
