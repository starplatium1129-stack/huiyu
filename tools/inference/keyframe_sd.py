"""Ordered reference-image edits on the local stable-diffusion.cpp CUDA runner."""
from collections import deque
from contextlib import ExitStack
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from huiyu_worker_lifecycle import load_sibling

contract = load_sibling("adapter_contract")
Error = contract.AdapterError


def resources(model_dir, spec):
    model_dir = Path(model_dir)
    if not model_dir.is_absolute() or not model_dir.is_dir():
        raise Error("MODEL_INCOMPLETE", "缺少本地关键帧模型目录。")
    base = model_dir.resolve().parent
    manifest = contract.MANIFEST
    runtime = manifest["keyframeRuntime"]
    runner = contract.safe_file(base, base / runtime["directory"] / spec.get("executable", runtime["executable"]))
    components = {}
    for flag, asset_id in spec["components"].items():
        asset = manifest["keyframeAssets"][asset_id]
        path = contract.safe_file(base, base / asset["path"])
        if path.stat().st_size != asset["bytes"] or (flag == "diffusion-model" and path.parent != model_dir.resolve()):
            raise Error("MODEL_INCOMPLETE", f"关键帧权重的目录或文件长度不符：{path.name}")
        components[flag] = (path, asset["sha256"])
    return runner, components


def digest(path, control):
    return load_sibling("native_hash").file_sha256(path, check=control.check)


def run_cli(command, directory, steps, control, *, disable_cuda_graphs=False):
    # A normal file stays readable while CUDA blocks inside loading or sampling.
    # Checking the cancellation event never depends on a fresh line from the CLI.
    log_path = directory / "inference.log"
    tail = deque(maxlen=12)
    completed = 0
    pending_text = ""
    cuda_oom = re.compile(r"cuda.{0,90}(out of memory|failed to allocate)|cudaErrorMemoryAllocation", re.I)
    oom = False
    host_oom = False
    env = {**os.environ, "GGML_CUDA_DISABLE_GRAPHS": "1"} if disable_cuda_graphs else None
    with log_path.open("wb") as capture, log_path.open("rb") as reader:
        process = subprocess.Popen(command, cwd=directory, stdin=subprocess.DEVNULL,
                                   stdout=capture, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0, env=env)
        try:
            while True:
                control.check()
                status = process.poll()
                block = reader.read(64 * 1024)
                if block:
                    message = pending_text + block.decode("utf-8", errors="replace")
                    oom = oom or cuda_oom.search(message) is not None
                    host_oom = host_oom or "ctx->mem_buffer != NULL" in message or "std::bad_alloc" in message
                    lines = re.split(r"[\r\n]", message)
                    pending_text = lines.pop()[-1024:]
                    for line in lines:
                        if not line.strip():
                            continue
                        tail.append(line[-512:])
                        match = re.search(r"\b(\d+)/(\d+)\s*[-|]", line)
                        if match:
                            step, total = map(int, match.groups())
                            if total == steps and completed < step <= steps:
                                control.progress(step, total)
                                completed = step
                    continue
                if status is not None:
                    break
                control.cancelled.wait(0.15)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    if status:
        tail.append(pending_text)
        detail = "\n".join(tail)[-1800:].strip()
        if host_oom:
            raise Error("NATIVE_HOST_MEMORY_EXHAUSTED", "Windows 可提交内存不足，关键帧生成已停止。请释放系统内存后，按原种子再试。")
        code = "NATIVE_OUT_OF_MEMORY" if oom else "NATIVE_EXECUTION_FAILED"
        raise Error(code, f"关键帧推理退出（{status}）。{detail}")


def generate(job, data, spec, control):
    from PIL import Image, ImageOps

    model_dir = Path(job["modelDir"])
    runner, components = resources(model_dir, spec)
    output = Path(job["outputPath"])
    control.stage("fingerprint")
    with ExitStack() as locks, tempfile.TemporaryDirectory(dir=output.parent, prefix="keyframe-") as temp:
        # Keep each verified NTFS weight protected until the native child exits.
        # Filesystems without read leases get a second digest before publication.
        guards = []
        for path, expected in components.values():
            lease = load_sibling("locked_identity").AssetIdentityLease(tree=False)
            locks.callback(lease.close)
            try:
                identity = lease.acquire(path, lambda item: digest(item, control))
            except OSError:
                # A neighboring installation can invalidate a directory watch.
                # Verify this file on both sides of execution in that case.
                lease.close()
                identity = digest(path, control)
            if identity != expected:
                raise Error("MODEL_INVALID", f"关键帧权重校验不符：{path.name}")
            guards.append((lease, path, expected))

        directory = Path(temp)
        prompt = directory / "instruction.txt"
        prompt.write_text(data["prompt"], encoding="utf-8")
        rendered = directory / "frame.png"
        # Leave VRAM for the desktop, VAE and temporary attention buffers. Disk-backed
        # weights let Windows reclaim mapped pages between the encoder and denoiser.
        h3_image = data["modelId"] == "minimax-h3-image-q4"
        budget = "cuda0=5" if h3_image else "cuda0=8"
        command = [str(runner), "--backend", "cuda0", "--max-vram", budget,
                   "--params-backend", "disk", "--mmap", "--disable-prefetch",
                   "--flash-attn", "on", "--vae-tiling", "--rng", "cpu",
                   "--sampling-method", "euler", "--steps", str(data["steps"]),
                   "--cfg-scale", str(data["cfg"]), "-s", str(data["seed"]),
                   "-W", str(data["width"]), "-H", str(data["height"]),
                   "--prompt-file", str(prompt), "-o", str(rendered)]
        for flag, (path, _) in components.items():
            command.extend(["--" + flag, str(path)])
        if "distilledGuidance" in spec:
            command.extend(["--guidance", str(spec["distilledGuidance"])])
        if "sigmas" in spec:
            command.extend(["--sigmas", spec["sigmas"]])
        control.stage("preparing_image")
        for index, source in enumerate([job["inputImagePath"], *job.get("referenceImagePaths", [])], 1):
            control.check()
            target = directory / f"reference-{index}.png"
            with load_sibling("adapter_media").input_image(source, Error) as image:
                if h3_image:
                    # H3 expands the short edge to 1024 for both vision and VAE. Letterbox
                    # each full frame to bound their joint token count on a 16 GiB card.
                    with ImageOps.pad(image, (1024, 1024), method=Image.Resampling.LANCZOS,
                                      color=(127, 127, 127)) as reference:
                        reference.save(target, format="PNG")
                else:
                    image.save(target, format="PNG")
            command.extend(["--ref-image", str(target)])
        control.stage("loading")
        run_cli(command, directory, data["steps"], control, disable_cuda_graphs=h3_image)
        control.stage("saving")
        for lease, path, expected in guards:
            if not lease.valid() and digest(path, control) != expected:
                raise Error("MODEL_CHANGED", f"关键帧权重在推理中发生变化：{path.name}")
        if not rendered.is_file():
            raise Error("INVALID_MODEL_OUTPUT", "原生执行器没有写出关键帧 PNG。")
        with Image.open(rendered) as frame:
            if frame.format != "PNG" or frame.size != (data["width"], data["height"]):
                raise Error("INVALID_MODEL_OUTPUT", "关键帧文件格式或画布尺寸与任务不符。")
            frame.verify()
        control.check()
        rendered.replace(output)
    return {"adapter": data["modelId"], "modelSha256": components["diffusion-model"][1],
            "memoryPolicy": "offload", "weightReuse": False,
            "runner": "sd-cpp", "referenceCount": 1 + len(job.get("referenceImagePaths", []))}
