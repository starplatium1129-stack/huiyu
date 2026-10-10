"""Maintenance-only warm-session measurements using the product weight cache."""
import contextlib
import json
import math
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time


def capture_schedule(scheduler, completed_steps):
    """Observe the completed Euler scheduler after benchmark timers stop.

    No timestep setup or sampling is performed. Active ranges use the caller's
    observed step count and are checked against the scheduler's final index.
    This is schedule-state evidence, never cross-backend or image-quality parity.
    """
    started = time.perf_counter()
    result = {"schemaVersion": 1, "status": "unverified", "source": "scheduler-post-run",
              "schedulerClass": f"{type(scheduler).__module__}.{type(scheduler).__qualname__}",
              "config": None, "configStatus": "unverified", "beginIndex": None,
              "finalStepIndex": None, "order": None, "completedSteps": None,
              "fullTimesteps": None, "fullSigmas": None,
              "activeTimesteps": None, "activeSigmas": None, "issues": []}
    issues = result["issues"]
    try:
        # FrozenDict and tuple-valued Diffusers configs become ordinary JSON data.
        # Reject nonfinite/unserializable configs instead of leaking NaN into reports.
        config = dict(scheduler.config)
        if not all(isinstance(key, str) for key in config):
            raise ValueError("scheduler config keys must be strings")
        result["config"] = json.loads(json.dumps(config, allow_nan=False))
        result["configStatus"] = "captured"
    except (AttributeError, TypeError, ValueError, OverflowError):
        issues.append("Scheduler config is unavailable or not finite JSON data")
    try:
        begin, end, order = scheduler.begin_index, scheduler.step_index, scheduler.order
        for name, value in (("beginIndex", begin), ("finalStepIndex", end), ("order", order),
                            ("completedSteps", completed_steps)):
            if type(value) is int and value >= 0:
                result[name] = value
            else:
                issues.append(f"{name} is not a nonnegative integer")
        if order != 1 or type(order) is not int:
            issues.append("Only an order-1 completed scheduler has an established active range")
        if type(completed_steps) is not int or completed_steps <= 0:
            issues.append("No positive observed scheduler step count")

        import torch  # maintenance capture only; importing this module stays stdlib-only
        tensors = [scheduler.timesteps, scheduler.sigmas]
        if any(not torch.is_tensor(value) or value.ndim != 1 or not value.is_floating_point() for value in tensors):
            raise ValueError("Scheduler timesteps and sigmas must be one-dimensional floating tensors")
        sizes = [value.numel() for value in tensors]
        if not sizes[0] or sizes[1] != sizes[0] + 1:
            raise ValueError("Euler sigma schedule must include exactly one terminal endpoint")
        host_values = [None, None]
        accelerator = [index for index, value in enumerate(tensors) if value.device.type != "cpu"]
        if len({str(tensors[index].device) for index in accelerator}) > 1:
            raise ValueError("Schedule tensors span multiple accelerator devices")
        # Keep existing CPU sigmas on CPU. Combine accelerator tensors for one D2H
        # transfer, rather than extracting a scalar and synchronizing every step.
        if accelerator:
            detached = [tensors[index].detach() for index in accelerator]
            packed = detached[0] if len(detached) == 1 else torch.cat(detached)
            packed_values = packed.cpu().tolist()
            offset = 0
            for index in accelerator:
                host_values[index] = packed_values[offset:offset + sizes[index]]
                offset += sizes[index]
        for index in range(2):
            if index not in accelerator:
                host_values[index] = tensors[index].detach().tolist()
        for field, tensor, values in zip(("fullTimesteps", "fullSigmas"), tensors, host_values):
            if not isinstance(values, list) or any(type(value) not in (int, float) or not math.isfinite(value) for value in values):
                raise ValueError("Schedule contains unavailable or nonfinite values")
            result[field] = {"dtype": str(tensor.dtype), "device": str(tensor.device), "values": values}
        if all(result[key] is not None for key in ("beginIndex", "finalStepIndex", "completedSteps")):
            if end != begin + completed_steps or end != sizes[0]:
                issues.append("Final scheduler index and observed steps do not establish a completed active range")
            elif order == 1 and completed_steps > 0:
                result["activeTimesteps"] = host_values[0][begin:end]
                result["activeSigmas"] = host_values[1][begin:end + 1]
        if not issues:
            result["status"] = "actual-captured"
    except Exception as error:
        # Observation failures must not discard a successfully generated image or
        # make the caller's strict JSON report invalid. Never retry device work.
        issues.append(f"Schedule capture unavailable: {type(error).__name__}: {error}")
    result["evidenceSeconds"] = time.perf_counter() - started
    return result


def child_session(api):
    worker = api.load("worker")
    resident = worker.load_mask_tools("resident_anima").PipelineCache()
    try:
        for line in sys.stdin:
            path = Path(json.loads(line))
            request = api.read(path)
            try:
                with path.with_name("stdout.jsonl").open("x") as events, contextlib.redirect_stdout(sys.stderr):
                    report = worker.generate(request["job"], events, resident=resident, cache_text=False, cache_mask=False,
                        collect_teacache=request["collect"], teacache_profile=request.get("profile"),
                        measure_teacache=not request["collect"] and request.get("profile") is None)
                api.write(path.with_name("worker-report.json"), report)
                print(json.dumps({"request": str(path), "done": True}), flush=True)
            except Exception as error:
                print(json.dumps({"request": str(path), "error": str(error)}), flush=True)
                return 1
    finally:
        resident.clear()
    return 0


class Session:
    def __init__(self, api, target):
        self.api = api
        self.errors = (target / "resident-stderr.log").open("x")
        started = time.perf_counter()
        kwargs = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == "win32" else {"start_new_session": True}
        try:
            self.process = subprocess.Popen([sys.executable, "-I", str(Path(api.__file__).resolve()), "--_worker-session"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors, text=True, encoding="utf-8", **kwargs)
        except BaseException:
            self.errors.close()
            raise
        self.events = queue.Queue(maxsize=2)
        def read():
            while True:
                line = self.process.stdout.readline(65537)
                if not line:
                    self.events.put(None)
                    return
                self.events.put(line)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        self.startup_seconds = time.perf_counter() - started

    def execute(self, job, folder, collect, profile, timeout):
        folder.mkdir()
        job = json.loads(json.dumps(job))
        job["outputPath"] = str(folder / "output.png")
        job["input"].pop("teacache", None)
        job["input"]["teaCache"] = profile is not None
        request = folder / "request.json"
        self.api.write(request, {"job": job, "collect": collect, "profile": profile})
        started = time.perf_counter()
        try:
            self.process.stdin.write(json.dumps(str(request)) + "\n")
            self.process.stdin.flush()
            try:
                line = self.events.get(timeout=timeout)
            except queue.Empty as error:
                raise subprocess.TimeoutExpired("resident Anima", timeout) from error
            if line is None or len(line) > 65536:
                raise ValueError("Resident measurement worker exited or returned an oversized event")
            event = json.loads(line)
            if event.get("request") != str(request) or event.get("done") is not True:
                raise ValueError(f"Resident measurement failed: {event.get('error', 'protocol mismatch')}")
        except BaseException:
            self.close()
            raise
        seconds = time.perf_counter() - started
        output = folder / "output.png"
        return {"wallSeconds": seconds, "output": str(output), "outputSha256": self.api.digest(output),
                "report": self.api.read(folder / "worker-report.json")}

    def close(self):
        if self.errors.closed:
            return
        try:
            try:
                if self.process.stdin and not self.process.stdin.closed:
                    self.process.stdin.close()
            finally:
                self.api.stop(self.process)
        finally:
            self.process.stdout.close()
            self.reader.join(timeout=1)
            self.errors.close()
