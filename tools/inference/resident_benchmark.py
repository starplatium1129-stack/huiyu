"""Maintenance-only warm-session measurements using the product weight cache."""
import contextlib
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time


def child_session(api):
    worker = api.load("worker")
    resident = worker.load_mask_tools("resident_anima").PipelineCache()
    try:
        for line in sys.stdin:
            path = Path(json.loads(line))
            request = api.read(path)
            try:
                with path.with_name("stdout.jsonl").open("x") as events, contextlib.redirect_stdout(sys.stderr):
                    report = worker.generate(request["job"], events, resident=resident, cache_text=False,
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
