"""Ordered edits on the same pinned native CUDA context across a keyframe batch."""
from base64 import b64decode, b64encode
from http.client import HTTPException
from io import BytesIO
from pathlib import Path
import time

from huiyu_worker_lifecycle import load_sibling

native = load_sibling("keyframe_sd")
server = load_sibling("wan_a14b_sd")
Error = native.Error
# The fixed sd.cpp release expands --sigmas minimax-h3-image to these seven values.
H3_PDD = [1.0, 0.9675236940383911, 0.8875485062599182, 0.75, 0.5327739119529724, 0.23200887441635132, 0.0]


class KeyframeServer(server.WanServer):
    def server_args(self, components, identity):
        model_id = identity[1]
        args = ["--backend", "cuda0", "--max-vram", "cuda0=5" if model_id == "minimax-h3-image-q4" else "cuda0=8",
                "--params-backend", "disk", "--mmap", "--disable-prefetch", "--flash-attn", "on", "--rng", "cpu"]
        for option, (path, _) in components.items():
            args.extend(("--" + option, str(path)))
        return args

    def generate(self, job, data, spec, control):
        from PIL import Image, ImageOps

        model_id = data["modelId"]
        h3_image = model_id == "minimax-h3-image-q4"
        runner, components = native.resources(Path(job["modelDir"]), {**spec, "executable": "sd-server.exe"})
        identity = (str(runner), model_id, tuple((str(path), sha, path.stat().st_mtime_ns) for path, sha in components.values()))
        reused = (self.identity == identity and self.process is not None and self.process.poll() is None
                  and self.completed > 0 and all(lease.valid() for lease, _, _ in self.leases))
        if not reused:
            self.start(runner, components, identity, control, disable_cuda_graphs=h3_image)
        self.min_commit = self.last_commit = self.low_commit = None
        self.job_log_offset = self.log.tell()
        self.job_stage = "sampling"
        control.stage("preparing_image")
        refs = []
        for source in [job["inputImagePath"], *job.get("referenceImagePaths", [])]:
            control.check()
            with load_sibling("adapter_media").input_image(source, Error) as image, BytesIO() as encoded:
                if h3_image:
                    with ImageOps.pad(image, (1024, 1024), method=Image.Resampling.LANCZOS, color=(127, 127, 127)) as ref:
                        ref.save(encoded, format="PNG")
                else:
                    image.save(encoded, format="PNG")
                refs.append(b64encode(encoded.getvalue()).decode("ascii"))
        guidance = {"txt_cfg": data["cfg"]}
        if "distilledGuidance" in spec:
            guidance["distilled_guidance"] = spec["distilledGuidance"]
        sampling = {"sample_method": "euler", "sample_steps": data["steps"], "guidance": guidance}
        if spec.get("sigmas") == "minimax-h3-image":
            sampling["custom_sigmas"] = H3_PDD
        request = {"prompt": data["prompt"], "seed": data["seed"], "width": data["width"], "height": data["height"],
                   "batch_count": 1, "ref_images": refs, "sample_params": sampling, "output_format": "png",
                   "vae_tiling_params": {"enabled": True}, "preview": "proj", "preview_interval": 2}
        control.stage("sampling")
        available_commit = load_sibling("video_memory").available_commit
        self.observe_commit(available_commit())
        try:
            accepted = self.request("POST", "/sdcpp/v1/img_gen", request, timeout=40)
        except (OSError, HTTPException) as cause:
            raise self.failure("关键帧 CUDA 进程在接收任务时中断。") from cause
        path = "/sdcpp/v1/jobs/" + accepted["id"]
        deadline = time.monotonic() + 40 * 60
        last_step = -1
        while time.monotonic() < deadline:
            control.check()
            self.observe_commit(available_commit())
            if self.process.poll() is not None:
                raise self.failure("关键帧 CUDA 进程已退出。")
            try:
                state = self.request("GET", path, timeout=20)
            except (OSError, HTTPException) as cause:
                raise self.failure("关键帧 CUDA 进程在出图时中断。") from cause
            progress = state.get("progress") or {}
            step = progress.get("completed")
            if progress.get("unit") == "steps" and isinstance(step, int) and step > last_step:
                last_step = step
                preview = (state.get("preview") or {}).get("b64_json")
                details = {}
                if preview:
                    image = server.preview_image(preview)
                    if image:
                        details["previewDataUrl"] = image
                control.progress(min(step, data["steps"]), data["steps"], **details)
            if state["status"] == "completed":
                break
            if state["status"] in ("failed", "cancelled"):
                raise self.failure("关键帧生成失败。" + str(state.get("error") or "")[:400])
            control.cancelled.wait(0.4)
        else:
            raise self.failure("关键帧任务超过 40 分钟。")
        control.stage("saving")
        for lease, file, sha in self.leases:
            if not lease.valid() and native.digest(file, control) != sha:
                raise Error("MODEL_CHANGED", f"关键帧模型在推理中变化：{file.name}")
        payload = b64decode(state["result"]["images"][0]["b64_json"], validate=True)
        with Image.open(BytesIO(payload)) as image:
            if image.format != "PNG" or image.size != (data["width"], data["height"]):
                raise Error("INVALID_MODEL_OUTPUT", "关键帧画布或文件格式与任务不一致。")
            image.verify()
        control.check()
        with Path(job["outputPath"]).open("xb") as output:
            output.write(payload)
        self.completed += 1
        return {"adapter": model_id, "modelSha256": components["diffusion-model"][1], "memoryPolicy": "offload",
                "modelIdentityScope": "full-byte-chunk-sha256",
                "weightReuse": reused, "modelReused": reused, "contextId": self.context_id, "loadCount": self.loads,
                "workerPid": self.process.pid, "contextJobs": self.completed, "referenceCount": len(refs), "runner": "sd-cpp"}
