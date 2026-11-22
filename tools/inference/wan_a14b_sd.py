"""Resident, serial Wan 2.2 A14B video generation on the pinned sd.cpp CUDA server."""
from base64 import b64decode, b64encode
from contextlib import ExitStack
from http.client import HTTPConnection, HTTPException
from io import BytesIO
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import uuid

from huiyu_worker_lifecycle import load_sibling

contract = load_sibling("adapter_contract")
media = load_sibling("adapter_media")
Error = contract.AdapterError
OOM = re.compile(r"out of (?:device |host )?memory|cudaErrorMemoryAllocation|failed to allocate|"
                 r"ctx->mem_buffer != NULL|std::bad_alloc|not enough (?:memory|space).*allocat|"
                 r"paging file is too small|cudaMalloc[^\r\n]*failed[^\r\n]*(?:memory|allocat)|"
                 r"graph allocation failed|execution engine cannot make enough memory available|"
                 r"available under current VRAM limits", re.I)
WINDOW_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
PASS_TIME = re.compile(rb"sampling(\(high noise\))? completed, taking (\d+(?:\.\d+)?)s")
LOG_ERROR = re.compile(r"\[E\]|assert|error|fatal|exception|failed|insufficient|exceed|cannot allocat", re.I)


def frame(path, width, height):
    from PIL import Image, ImageOps
    with media.input_image(path, Error) as source, BytesIO() as encoded:
        # Apply one aspect-preserving center crop to both conditioning slots.
        with ImageOps.fit(source, (width, height), method=Image.Resampling.LANCZOS).convert("RGB") as view:
            view.save(encoded, format="PNG")
        return b64encode(encoded.getvalue()).decode("ascii")


def preview_image(encoded):
    from PIL import Image
    with Image.open(BytesIO(b64decode(encoded, validate=True))) as preview, BytesIO() as output:
        preview.thumbnail((384, 384))
        preview.convert("RGB").save(output, format="JPEG", quality=74)
        if output.tell() <= 96 * 1024:
            return "data:image/jpeg;base64," + b64encode(output.getvalue()).decode("ascii")


def graph_budget(data, spec, tier):
    # The 720p 33-frame graph needs 6207 MiB for its first transformer
    # block. Longer 480p shots can have the same temporal/spatial token count.
    pixels = data["width"] * data["height"]
    tokens = (data["width"] // 16) * (data["height"] // 16) * ((data["frames"] + 3) // 4)
    budgets = spec["graphBudgetGiB"]
    if pixels >= 1280 * 720 or tokens >= 30_000:
        return budgets["highTokenCount"]
    if tier == "conservative" and tokens <= 16_384:
        return budgets["conservative480"]
    return budgets["balanced480"]


def encode_clip(result, output, data, control):
    if (result.get("frame_count") != data["frames"] or result.get("fps") != data["fps"]
            or result.get("output_format") != "avi" or output.exists()):
        raise Error("INVALID_MODEL_OUTPUT", "Wan 视频帧数、帧率、容器或输出位置与请求不符。")
    with tempfile.TemporaryDirectory(dir=output.parent, prefix="wan-video-") as work:
        source, encoded = Path(work) / "frames.avi", Path(work) / "clip.mp4"
        source.write_bytes(b64decode(result["b64_json"], validate=True))
        command = [media.encoder(Error), "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-n",
                   "-i", str(source), "-map", "0:v:0", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                   "-crf", "17", "-preset", "fast", "-movflags", "+faststart", str(encoded)]
        with tempfile.TemporaryFile() as log:
            proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log,
                                    creationflags=WINDOW_FLAGS)
            deadline = time.monotonic() + 150
            try:
                while proc.poll() is None:
                    control.check()
                    if time.monotonic() >= deadline:
                        raise Error("NATIVE_VIDEO_ENCODE_TIMEOUT", "MP4 编码超时。")
                    control.cancelled.wait(0.1)
                if proc.returncode:
                    log.seek(0)
                    raise Error("NATIVE_VIDEO_ENCODE_FAILED", log.read(2048).decode("utf-8", "replace"))
                control.check()
                encoded.rename(output)
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.wait()


class WanServer:
    def __init__(self):
        self.process = None
        self.directory = None
        self.log = None
        self.guards = ExitStack()
        self.leases = []
        self.identity = None
        self.context_id = None
        self.port = None
        self.loads = 0
        self.completed = 0
        self.low_commit = None
        self.diagnostic_file = None
        self.job_log_offset = 0
        self.job_stage = "loading"
        self.min_commit = None
        self.last_commit = None

    def close(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait()
            self.process = None
        if self.log is not None:
            self.log.close()
            self.log = None
        if self.directory is not None:
            self.directory.cleanup()
            self.directory = None
        self.guards.close()
        self.leases.clear()
        self.context_id = self.identity = None
        self.completed = 0
        self.low_commit = None

    def request(self, method, path, body=None, timeout=4):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            payload = None if body is None else json.dumps(body).encode()
            connection.request(method, path, payload, {"Content-Type": "application/json"})
            response = connection.getresponse()
            content = response.read(128 * 1024 * 1024 + 1)
            if len(content) > 128 * 1024 * 1024:
                raise Error("INVALID_MODEL_OUTPUT", "原生视频响应超过允许大小。")
            record = json.loads(content)
            if not 200 <= response.status < 300:
                raise Error("NATIVE_VIDEO_FAILED", f"Wan HTTP {response.status}: {str(record)[:350]}")
            return record
        finally:
            connection.close()

    def observe_commit(self, commit):
        if commit is None:
            return
        self.last_commit = commit
        self.min_commit = commit if self.min_commit is None else min(self.min_commit, commit)
        if commit <= 512 * 1024**2:
            self.low_commit = (time.monotonic(), commit)

    def failure(self, message):
        self.log.flush()
        with (Path(self.directory.name) / "sd.log").open("rb") as handle:
            handle.seek(max(self.job_log_offset, handle.seek(0, 2) - 64 * 1024))
            logs = handle.read().decode("utf-8", "replace")
        status = self.process.poll() if self.process is not None else None
        low_commit = self.low_commit is not None and time.monotonic() - self.low_commit[0] <= 10
        if status is None and low_commit and self.process is not None:
            try:
                status = self.process.wait(timeout=0.3)
            except subprocess.TimeoutExpired:
                pass
        nt_oom = status is not None and (status & 0xffffffff) in (0xc0000017, 0xc000009a, 0xc000012d)
        exhausted = status not in (None, 0) and low_commit
        code = "OUT_OF_MEMORY" if nt_oom or exhausted or OOM.search(message + "\n" + logs) else "NATIVE_VIDEO_FAILED"
        facts = [f"阶段 {self.job_stage}", f"进程状态 {status if status is not None else '仍在运行'}"]
        if self.min_commit is not None:
            facts.append(f"系统提交余量最低 {self.min_commit // 1048576} MiB，最近 {self.last_commit // 1048576} MiB")
        if self.diagnostic_file is not None:
            output = self.diagnostic_file
            try:
                output.parent.mkdir(parents=True, exist_ok=True)
                with output.open("x", encoding="utf-8") as report:
                    report.write(f"{code} | {message} | {' / '.join(facts)}\n{logs}")
                facts.append(f"日志 jobs/video/{output.name}")
            except OSError:
                pass
        lines = [line.strip() for line in re.split(r"[\r\n]", logs) if line.strip()]
        memory_errors = [line for line in lines if OOM.search(line)]
        errors = [line for line in lines if LOG_ERROR.search(line)]
        reason = " | ".join(dict.fromkeys(memory_errors[-1:] + errors[-3:]))[:420]
        return Error(code, "；".join([message, *facts, reason]).rstrip("；"))

    def server_args(self, components, identity):
        args = ["--backend", "cuda0", "--max-vram", f"cuda0={identity[-1]}",
                "--params-backend", "disk", "--mmap", "--disable-prefetch", "--flash-attn", "on",
                "--rng", "cpu"]
        for name in ("diffusion-model", "high-noise-diffusion-model", "t5xxl", "vae"):
            args.extend(("--" + name, str(components[name][0])))
        return args

    def start(self, runner, components, identity, control, *, disable_cuda_graphs=False):
        native = load_sibling("keyframe_sd")
        self.close()
        control.stage("fingerprint")
        runtime = contract.MANIFEST["keyframeRuntime"]
        binaries = [(contract.safe_file(runner.parent, runner.parent / name), sha)
                    for name, sha in runtime["serverFiles"].items()]
        for path, expected in (*binaries, *components.values()):
            lease = load_sibling("locked_identity").AssetIdentityLease(tree=False)
            self.guards.callback(lease.close)
            try:
                actual = lease.acquire(path, lambda source: native.digest(source, control))
            except OSError:
                lease.close()
                actual = native.digest(path, control)
            if actual != expected:
                raise Error("MODEL_INVALID", f"原生模型或 CUDA 引擎 SHA-256 不符：{path.name}")
            self.leases.append((lease, path, expected))
        control.stage("loading")
        self.directory = tempfile.TemporaryDirectory(prefix="huiyu-sdcpp-")
        directory = Path(self.directory.name)
        self.log = (directory / "sd.log").open("wb")
        with socket.socket() as port:
            port.bind(("127.0.0.1", 0))
            self.port = port.getsockname()[1]
        command = [str(runner), "--listen-ip", "127.0.0.1", "--listen-port", str(self.port),
                   "--max-pending-jobs", "1", "--completed-ttl-seconds", "15", *self.server_args(components, identity)]
        env = os.environ.copy()
        if disable_cuda_graphs or "high-noise-diffusion-model" in components:
            # Graph capture starts after warm-up and can exhaust Windows commit.
            env["GGML_CUDA_DISABLE_GRAPHS"] = "1"
        self.process = subprocess.Popen(command, cwd=directory, stdin=subprocess.DEVNULL, stdout=self.log,
                                        stderr=subprocess.STDOUT, creationflags=WINDOW_FLAGS, env=env)
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            control.check()
            if self.process.poll() is not None:
                raise self.failure(f"原生 CUDA 执行器启动退出（{self.process.returncode}）。")
            try:
                status = self.request("GET", "/sdcpp/v1/models/status", timeout=2)
            except OSError:
                control.cancelled.wait(0.3)
                continue
            if status.get("state") == "ready":
                self.loads += 1
                self.completed = 0
                self.identity = identity
                self.context_id = uuid.uuid4().hex
                return
            if status.get("state") == "error":
                raise self.failure(str(status.get("error", "原生模型加载失败。")))
            control.cancelled.wait(0.3)
        raise self.failure("原生执行器加载超过五分钟。")

    def generate(self, job, data, spec, control):
        native = load_sibling("keyframe_sd")
        runner, components = native.resources(Path(job["modelDir"]), spec)
        tier = data.get("wanMemoryTier", "balanced")
        output = Path(job["outputPath"])
        self.diagnostic_file = None
        if (re.fullmatch(r"[0-9a-f]{32}", job["id"]) and output.name in ("result.mp4", "result-retry.mp4")
                and re.fullmatch(r"native-[a-zA-Z0-9]{6}", output.parent.name)
                and output.parent.parent.name == "native" and output.parent.parent.parent.name == "outputs"):
            receipt = output.parents[3] / "jobs" / "video"
            self.diagnostic_file = receipt / f"{job['id']}.{tier}.sd.log"
        self.min_commit = self.last_commit = None
        self.job_log_offset = 0
        self.job_stage = "loading"
        weights = tuple((str(path), sha, path.stat().st_mtime_ns) for path, sha in components.values())
        group = (str(runner), weights)
        budget = graph_budget(data, spec, tier)
        if tier == "balanced" and self.identity and self.identity[:-1] == group:
            # A live 720p context can also render the next 480p shot.
            budget = max(budget, self.identity[-1])
        identity = (*group, budget)
        reused = (self.identity == identity and self.process is not None and self.process.poll() is None
                  and self.completed > 0 and all(lease.valid() for lease, _, _ in self.leases))
        if not reused:
            self.start(runner, components, identity, control)
        width, height, total = data["width"], data["height"], data["steps"]
        half = total // 2
        # LightX2V's WanStepDistillScheduler shifts [1, .75, .5, .25]
        # and ends at zero. Keep both experts on that same Euler trajectory.
        times = [i / total for i in range(total, -1, -1)]
        sigmas = [5 * t / (1 + 4 * t) for t in times]
        sampling = {"scheduler": "discrete", "sample_method": "euler", "sample_steps": half,
                    "flow_shift": 5.0, "custom_sigmas": sigmas, "guidance": {"txt_cfg": 1.0}}
        tile = 96 if tier == "conservative" else 128
        control.stage("preparing_image")
        params = {"prompt": data["prompt"], "width": width, "height": height, "seed": data["seed"],
                  "video_frames": data["frames"], "fps": data["fps"], "moe_boundary": spec["boundaryRatio"],
                  "init_image": frame(job["inputImagePath"], width, height), "sample_params": sampling,
                  "high_noise_sample_params": {"sample_method": "euler", "sample_steps": half,
                                               "guidance": {"txt_cfg": 1.0}},
                  "vae_tiling_params": {"enabled": True, "temporal_tiling": True, "tile_size_w": tile,
                                        "tile_size_h": tile, "target_overlap": 0.25},
                  "preview": "proj", "preview_interval": 1, "output_format": "avi", "output_compression": 100}
        if job.get("lastFramePath"):
            params["end_image"] = frame(job["lastFramePath"], width, height)
        control.check()
        log_path = Path(self.directory.name) / "sd.log"
        log_offset = log_path.stat().st_size
        self.job_log_offset = log_offset
        self.job_stage = "submitting"
        self.low_commit = None
        try:
            submitted = self.request("POST", "/sdcpp/v1/vid_gen", params, timeout=30)
        except (HTTPException, OSError, Error) as exc:
            raise self.failure(str(exc)) from exc
        path = "/sdcpp/v1/jobs/" + submitted["id"]
        step, last_preview, stage = 0, None, None
        available_commit = load_sibling("video_memory").available_commit
        deadline = time.monotonic() + 2 * 60 * 60
        last_contact = time.monotonic()
        while time.monotonic() < deadline:
            control.check()
            self.observe_commit(available_commit())
            if self.process.poll() is not None:
                raise self.failure(f"Wan CUDA 执行器退出（{self.process.returncode}）。")
            try:
                status = self.request("GET", path, timeout=15)
            except (HTTPException, OSError, Error) as exc:
                # A read-only status poll is safe to repeat after a transient
                # transport interruption. Never resubmit a generation request.
                if (isinstance(exc, (HTTPException, OSError)) and self.process.poll() is None
                        and time.monotonic() - last_contact < 45):
                    control.cancelled.wait(0.4)
                    continue
                raise self.failure(f"Wan CUDA 执行器连接中断：{exc}") from exc
            last_contact = time.monotonic()
            progress = status.get("progress") or {}
            if progress.get("stage") != stage:
                stage = progress.get("stage")
                if stage:
                    self.job_stage = str(stage)[:32]
                    control.stage({"sampling":"sampling", "conditioning":"encoding", "vae_decode":"decoding",
                                   "encoding":"saving"}.get(stage, "preparing_image"))
            info = status.get("preview") or {}
            key = (info.get("pass"), info.get("step"))
            details = {}
            if info.get("b64_json") and key != last_preview:
                last_preview = key
                image = preview_image(info["b64_json"])
                if image:
                    details["previewDataUrl"] = image
            if progress.get("unit") == "steps" and isinstance(progress.get("completed"), int):
                new_step = min(total, max(step, (half if progress.get("detail") == "low_noise" else 0) + progress["completed"]))
            else:
                new_step = step
            if key[0] in (1, 2) and isinstance(key[1], int) and 0 < key[1] <= half:
                new_step = max(new_step, (key[0] - 1) * half + key[1])
            # The REST snapshot may have advanced directly from the penultimate
            # sample to decode before the next poll.
            if (step and stage in ("vae_decode", "encoding")) or status["status"] == "completed":
                new_step = total
            if new_step > step or details:
                step = new_step
                control.progress(step, total, **details)
            if status["status"] == "completed":
                break
            if status["status"] in ("failed", "cancelled"):
                raise self.failure("Wan 推理失败。" + str(status.get("error") or "")[:350])
            control.cancelled.wait(0.4)
        else:
            raise self.failure("Wan 单镜头超过两小时。")
        for lease, source, sha in self.leases:
            if not lease.valid() and native.digest(source, control) != sha:
                raise Error("MODEL_CHANGED", f"Wan 权重在推理期间变化：{source.name}")
        control.stage("saving")
        encode_clip(status["result"], output, data, control)
        tensor_loads, expert_times = 0, {}
        with log_path.open("rb") as log:
            log.seek(log_offset)
            # Count actual transfers reported by sd.cpp; a retained context on a
            # 16 GiB device can still reload weight segments within either shot.
            for line in log:
                tensor_loads += line.count(b"loading tensors completed")
                timing = PASS_TIME.search(line)
                if timing:
                    expert_times["high" if timing.group(1) else "low"] = float(timing.group(2))
        self.completed += 1
        return {"adapter": data["modelId"], "modelSha256": components["diffusion-model"][1],
                "modelIdentityScope": "full-byte-chunk-sha256", "weightReuse": reused, "modelReused": reused,
                "memoryPolicy": "offload", "wanMemoryTier": tier, "contextId": self.context_id,
                "workerPid": self.process.pid, "loadCount": self.loads, "contextJobs": self.completed,
                "firstLastFrame": bool(job.get("lastFramePath")), "tiledVae": True, "vaeTilePixels": tile,
                "attentionPolicy": "cuda-flash-requested", "parameterBackend": "disk-mmap",
                "vramBudgetGiB": budget, "minCommitBytes": self.min_commit,
                "distillation": "lightx2v-260412-dual-checkpoint", "expertPassSeconds": expert_times,
                "tensorLoadEvents": tensor_loads, "componentSha256": {k: sha for k, (_, sha) in components.items()},
                "highNoiseSteps": half, "lowNoiseSteps": half, "nativeRelease": contract.MANIFEST["keyframeRuntime"]["release"]}
