"""Serial generation with an independent JSONL cancellation reader.

Only the generation thread emits protocol events or touches model state. The
reader sets a per-request event; CUDA operations finish at explicit safe points.
"""
import gc
import importlib.util
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time

if sys.platform == "win32" and os.environ.get("HUIYU_INFERENCE_MEMORY") == "offload":
    # PyTorch's Windows mimalloc must return freed weight pages between stages,
    # rather than retaining commit while the next component is being loaded.
    os.environ.setdefault("MIMALLOC_PURGE_DELAY", "0")
    os.environ.setdefault("MIMALLOC_ARENA_EAGER_COMMIT", "0")


class WorkerError(Exception):
    """Known failures shared by native adapters and optional manga stages."""
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def load_sibling(name):
    """Reuse one bundled module instance without adding an import search path."""
    if not isinstance(name, str) or not name.isidentifier():
        raise WorkerError("RUNTIME_INCOMPLETE", "Invalid bundled module name")
    path = Path(__file__).with_name(f"{name}.py").resolve()
    module_name = f"huiyu_{name}"
    module = sys.modules.get(module_name)
    if module is not None:
        if Path(getattr(module, "__file__", "")).resolve() != path:
            raise WorkerError("RUNTIME_INCOMPLETE", f"Bundled module belongs to another runtime: {name}")
        return module
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    # Register before execution so contracts and nested stages share real types.
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(module_name, None)
        raise
    return module


class GenerationCancelled(Exception):
    code = "ABORT_ERR"


class JobControl:
    def __init__(self, job_id, stream, emit):
        self.id, self.stream, self.emit = job_id, stream, emit
        self.cancelled = threading.Event()
        self.started = time.perf_counter()

    def check(self):
        if self.cancelled.is_set():
            raise GenerationCancelled("Native generation cancelled")

    def stage(self, name, component=None):
        self.check()
        values = {"stage": name}
        if component is not None:
            values["component"] = component
        self.emit(self.stream, self.id, "stage", **values)

    def progress(self, step, total):
        self.check()
        self.emit(self.stream, self.id, "progress", step=step, total=total)


class Requests:
    def __init__(self, input_stream, stream, emit, error):
        self.input_stream, self.stream, self.emit, self.error = input_stream, stream, emit, error
        self.pending = queue.Queue()
        self.lock = threading.Lock()
        self.active = None
        self.failure = None
        self.imports_ready = threading.Event()
        threading.Thread(target=self.read, name="native-requests", daemon=True).start()

    def read(self):
        try:
            while True:
                line = self.input_stream.readline(2 * 1024 * 1024 + 1)
                if not line:
                    with self.lock:
                        if self.active is not None:
                            self.active.cancelled.set()
                    self.pending.put(None)
                    return
                if len(line) > 2 * 1024 * 1024:
                    raise self.error("INVALID_REQUEST", "JSONL request exceeds 2 MiB")
                try:
                    job = json.loads(line)
                except ValueError as exc:
                    raise self.error("INVALID_REQUEST", "Expected a JSONL generation request") from exc
                if not isinstance(job, dict) or not isinstance(job.get("id"), str) or not job["id"]:
                    raise self.error("INVALID_REQUEST", "Each generation or cancellation needs a request id")
                with self.lock:
                    if job.get("op") == "cancel":
                        if set(job) != {"id", "op"}:
                            raise self.error("INVALID_REQUEST", "Cancellation accepts only id and op")
                        # Late cancellation of a completed job must not cancel
                        # the next request or leave an extra protocol event.
                        if self.active is not None and self.active.id == job["id"]:
                            self.active.cancelled.set()
                        continue
                    if job.get("op") != "generate" or self.active is not None:
                        raise self.error("INVALID_REQUEST", "Generate requests must wait for the previous ready event")
                    control = JobControl(job["id"], self.stream, self.emit)
                    self.active = control
                self.pending.put((job, control))
                # Do not enter another blocking stdin read during the first
                # NumPy/Torch DLL initialization. The main thread releases this
                # gate after imports; pending cancellation stays in the pipe.
                self.imports_ready.wait()
        except Exception as exc:
            with self.lock:
                self.failure = exc
                if self.active is not None:
                    self.active.cancelled.set()
            self.pending.put(exc)

    def finish(self, control):
        with self.lock:
            if self.failure is not None:
                raise self.failure
            if self.active is control:
                self.active = None


def settle_resources(cancelled):
    # Called after generate and outside the exception handler: its traceback must first release
    # the fresh pipeline, latent state and temporary wrappers. Keep the resident
    # components/adapters/text cache; no weight or model-state mutation occurs.
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_initialized():
        if cancelled:
            torch.cuda.synchronize()
        # Keep live resident weights; return completed-job allocator reserves,
        # particularly large hires activations, instead of holding them idle.
        torch.cuda.empty_cache()


def serve(generate, *, input_stream, stream, emit, error, initialize, cancel_cleanup=None):
    """Run generate(job, control, prepared); return a process exit code.

    initialize(job, imports_ready) releases the reader after imports and returns
    first-job preparation directly to generate, avoiding
    duplicate full-byte reads on filesystems without a reusable identity lease.
    generate owns its existing finally cleanup (TeaCache and temporary model
    wrappers). It must use control at load/inference boundaries and for each
    sampling step, and must never check cancellation after emitting result.
    Unexpected failures remain fatal: only cooperative cancellation reuses the
    model, and ready is emitted after all cancellation cleanup has completed.
    """
    requests = Requests(input_stream, stream, emit, error)
    job_id = None
    initialized = False
    try:
        while True:
            item = requests.pending.get()
            if item is None:
                return 0
            if isinstance(item, Exception):
                raise item
            job, control = item
            job_id = control.id
            prepared = None
            if not initialized:
                try:
                    control.stage("dependencies")
                    prepared = initialize(job, requests.imports_ready.set)
                    initialized = True
                finally:
                    requests.imports_ready.set()
            was_cancelled = False
            try:
                control.check()
                generate(job, control, prepared)
            except GenerationCancelled:
                was_cancelled = True
                if cancel_cleanup is not None:
                    cancel_cleanup()
            settle_resources(was_cancelled)
            requests.finish(control)
            if was_cancelled:
                emit(stream, job_id, "cancelled")
            emit(stream, job_id, "ready")
    except Exception as exc:
        code = exc.code if isinstance(exc, (error, WorkerError)) else "GENERATION_FAILED"
        message = str(exc) if isinstance(exc, (error, WorkerError)) else f"{type(exc).__name__}: {exc}"
        emit(stream, job_id, "error", code=code, message=message)
        return 1
