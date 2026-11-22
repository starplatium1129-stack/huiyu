"""MuseTalk 1.5 single-portrait speech animation with local, pinned weights."""
from contextlib import ExitStack
from base64 import b64encode
from importlib import metadata
from pathlib import Path
import gc
import math
import os
import subprocess
import tempfile
import uuid
import wave

from huiyu_worker_lifecycle import load_sibling

contract = load_sibling("adapter_contract")
media = load_sibling("adapter_media")
Error = contract.AdapterError
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def dependencies():
    media.encoder(Error)
    try:
        # Import native DLLs before the Windows worker opens its cancellation
        # reader. The lifecycle explicitly gates that first blocking stdin read.
        import cv2
        import torch
        from diffusers import AutoencoderKL, UNet2DConditionModel
        from transformers import WhisperFeatureExtractor, WhisperModel
        if not torch.cuda.is_available():
            raise Error("NATIVE_GPU_UNAVAILABLE", "MuseTalk 需要可用的 CUDA 显卡。")
        torch.cuda.init()
        return {name: metadata.version(name) for name in
                ("torch", "diffusers", "transformers", "Pillow", "opencv-python-headless", "safetensors")}
    except metadata.PackageNotFoundError as exc:
        raise Error("DEPENDENCY_MISSING", f"MuseTalk 原生运行库缺少组件 {exc.name}") from exc
    except (ImportError, OSError) as exc:
        raise Error("DEPENDENCY_IMPORT", f"MuseTalk 原生组件无法加载：{exc}") from exc


def resource_files(model_dir, spec):
    base = model_dir.resolve().parent
    assets = {}
    for key, asset_id in spec["components"].items():
        row = contract.MANIFEST["keyframeAssets"][asset_id]
        path = contract.safe_file(base, base / row["path"])
        if path.stat().st_size != row["bytes"] or (key == "unet" and path.parent != model_dir.resolve()):
            raise Error("MODEL_INCOMPLETE", f"MuseTalk 模型文件缺失或长度不符：{path.name}")
        assets[key] = (path, row["sha256"])
    return assets


def read_speech(path, data, control):
    import numpy as np
    try:
        with wave.open(str(path), "rb") as wav:
            rate, count = wav.getframerate(), wav.getnframes()
            if (wav.getcomptype() != "NONE" or not 8_000 <= rate <= 192_000 or not 1 <= wav.getnchannels() <= 2
                    or wav.getsampwidth() not in (1, 2, 3, 4) or not 0 < count <= 15 * rate):
                raise Error("INVALID_AUDIO", "配音需要不超过 15 秒的单声道或立体声 PCM WAV。")
            if len(wav.readframes(count)) != count * wav.getnchannels() * wav.getsampwidth():
                raise Error("INVALID_AUDIO", "配音 WAV 的采样数据不完整。")
    except (OSError, EOFError, wave.Error) as exc:
        raise Error("INVALID_AUDIO", "无法读取 PCM WAV 配音。") from exc
    actual_frames = (count * data["fps"] + rate - 1) // rate
    if actual_frames > data["frames"] or ("audioFrames" in data and actual_frames != data["audioFrames"]):
        raise Error("AUDIO_DURATION_MISMATCH", f"这段配音需要 {actual_frames} 帧，请使用完整音频并调整分镜时长。")
    command = [media.encoder(Error), "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a:0",
               "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"]
    control.check()
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=20, creationflags=FLAGS)
    if result.returncode or not result.stdout or len(result.stdout) % 4:
        reason = result.stderr.decode("utf8", "replace").strip()[-450:]
        raise Error("INVALID_AUDIO", f"转换 16 kHz 配音失败（{result.returncode}，{len(result.stdout)} 字节）。{reason}")
    speech = np.frombuffer(result.stdout, dtype="<f4")
    length = data["frames"] * (16_000 // data["fps"])
    return np.pad(speech[:length], (0, max(0, length - len(speech)))), count, rate


def portrait(path, canvas, cascade_path):
    import cv2
    import numpy as np
    from PIL import Image, ImageOps
    with media.input_image(path, Error) as image:
        source = np.asarray(ImageOps.fit(image.convert("RGB"), canvas, method=Image.Resampling.LANCZOS))
    gray = cv2.equalizeHist(cv2.cvtColor(source, cv2.COLOR_RGB2GRAY))
    for kind, detector in (("anime", cascade_path), ("frontal", Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml")):
        detector = cv2.CascadeClassifier(str(detector))
        if detector.empty():
            continue
        faces = detector.detectMultiScale(gray, scaleFactor=1.06, minNeighbors=4, minSize=(32, 32))
        if len(faces):
            break
    else:
        raise Error("PORTRAIT_FACE_MISSING", "没有识别到角色的脸，请使用正面或轻微侧脸的单人近景。")
    faces = sorted(faces, key=lambda b: int(b[2]) * int(b[3]), reverse=True)
    x, y, w, h = map(int, faces[0])
    if len(faces) > 1 and int(faces[1][2]) * int(faces[1][3]) > w * h * 0.6:
        raise Error("PORTRAIT_AMBIGUOUS", "画面中有多张大小相近的脸，请裁出要说话的角色。")
    # The anime cascade locates the whole illustrated head; MuseTalk was
    # trained on facial landmarks up to the chin, without hair or collars.
    if kind == "anime":
        left, top = x + round(w * .13), y + round(h * .12)
        right, bottom = x + round(w * .87), y + round(h * .85)
    else:
        left, top = x, y
        right, bottom = x + w, min(canvas[1], y + round(h * 1.04))
    crop = cv2.resize(source[top:bottom, left:right], (256, 256), interpolation=cv2.INTER_LANCZOS4)
    return source, crop, (left, top, right, bottom), kind


def whisper_windows(whisper, processor, speech, frames):
    import torch
    features = processor(speech, sampling_rate=16000, return_tensors="pt").input_features
    states = whisper(features.to("cuda", torch.float16), output_hidden_states=True).hidden_states
    hidden = torch.stack(states, dim=2)[:, :frames * 2]
    # The published 25 fps training recipe uses ten 50 Hz Whisper positions
    # around each frame, with all five encoder layers at each position.
    hidden = torch.nn.functional.pad(hidden, (0, 0, 0, 0, 4, 6))
    windows = torch.cat([hidden[:, i * 2:i * 2 + 10] for i in range(frames)]).flatten(1, 2)
    steps = torch.arange(windows.shape[1], device="cuda", dtype=torch.float32).unsqueeze(1)
    inv = torch.exp(torch.arange(0, 384, 2, device="cuda", dtype=torch.float32) * (-math.log(10000.0) / 384))
    positions = torch.stack(((steps * inv).sin(), (steps * inv).cos()), dim=-1).flatten(1)
    return (windows + positions.to(windows.dtype)).contiguous()


def replace_mouth(source, rendered, box, blend):
    import cv2
    import numpy as np
    x, y, right, bottom = box
    size = (right - x, bottom - y)
    region = source[y:bottom, x:right]
    rendered = cv2.resize(rendered, size, interpolation=cv2.INTER_LANCZOS4)
    mixed = rendered.astype(np.float32) * blend + region * (1.0 - blend)
    frame = source.copy()
    frame[y:bottom, x:right] = mixed.clip(0, 255).astype(np.uint8)
    return frame


def preview(frame):
    import cv2
    h, w = frame.shape[:2]
    scale = min(1, 320 / max(h, w))
    small = cv2.resize(frame, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", cv2.cvtColor(small, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 72])
    if ok and encoded.nbytes <= 96 * 1024:
        return {"previewDataUrl": "data:image/jpeg;base64," + b64encode(encoded).decode("ascii")}
    return {}


class MuseTalk:
    def __init__(self):
        self.guards = ExitStack()
        self.leases = []
        self.identity = self.context_id = None
        self.unet = self.vae = self.whisper = self.processor = None
        self.completed = self.loads = 0

    def close(self):
        self.unet = self.vae = self.whisper = self.processor = None
        self.guards.close()
        self.leases.clear()
        self.identity = self.context_id = None
        self.completed = 0
        gc.collect()
        import sys
        if "torch" in sys.modules and sys.modules["torch"].cuda.is_initialized():
            sys.modules["torch"].cuda.empty_cache()

    def acquire(self, model_dir, spec, control):
        import torch
        from diffusers import AutoencoderKL, UNet2DConditionModel
        from transformers import WhisperFeatureExtractor, WhisperModel
        assets = resource_files(model_dir, spec)
        identity = tuple((path, sha, path.stat().st_mtime_ns) for path, sha in assets.values())
        if self.identity == identity and all(lease.valid() for lease in self.leases):
            return assets, True
        self.close()
        control.stage("fingerprint")
        digest = load_sibling("keyframe_sd").digest
        for path, expected in assets.values():
            lease = load_sibling("locked_identity").AssetIdentityLease(tree=False)
            self.guards.callback(lease.close)
            try:
                measured = lease.acquire(path, lambda file: digest(file, control))
            except OSError:
                lease.close()
                measured = digest(path, control)
            if measured != expected:
                raise Error("MODEL_INVALID", f"MuseTalk 文件校验失败：{path.name}")
            self.leases.append(lease)
        control.stage("loading")
        with torch.device("meta"):
            unet = UNet2DConditionModel(**contract.document(assets["unet-config"][0]))
        unet.load_state_dict(torch.load(assets["unet"][0], map_location="cpu", mmap=True, weights_only=True), assign=True)
        self.unet = unet.eval().to(device="cuda", dtype=torch.float16)
        # Diffusers applies the original SD VAE's attention-name conversion.
        self.vae = AutoencoderKL.from_pretrained(str(assets["vae"][0].parent), use_safetensors=True,
                                                local_files_only=True, torch_dtype=torch.float16).eval().to("cuda")
        folder = assets["whisper"][0].parent
        self.processor = WhisperFeatureExtractor.from_pretrained(str(folder), local_files_only=True)
        self.whisper = WhisperModel.from_pretrained(str(folder), local_files_only=True, dtype=torch.float16).encoder.eval().to("cuda")
        self.context_id, self.identity = uuid.uuid4().hex, identity
        self.loads += 1
        return assets, False

    def generate(self, job, data, spec, control):
        import torch
        try:
            return self.render(job, data, spec, control)
        except torch.OutOfMemoryError as exc:
            raise Error("OUT_OF_MEMORY", "MuseTalk 的 CUDA 分配失败，显存不足。") from exc

    def render(self, job, data, spec, control):
        import cv2
        import numpy as np
        import torch
        output, audio = Path(job["outputPath"]), Path(job["drivingAudioPath"])
        if output.exists():
            raise Error("INVALID_OUTPUT", "配音镜头输出位置已被占用。")
        torch.cuda.reset_peak_memory_stats()
        speech, samples, rate = read_speech(audio, data, control)
        assets, reused = self.acquire(Path(job["modelDir"]), spec, control)
        control.stage("preparing_image")
        canvas = (data["width"], data["height"])
        source, crop, box, detector = portrait(job["inputImagePath"], canvas, assets["anime-face"][0])
        ink = load_sibling("musetalk_ink").InkMouth.from_portrait(crop) if detector == "anime" else None
        x, y, right, bottom = box
        mask = np.zeros((256, 256), np.uint8)
        cv2.ellipse(mask, (128, 187), (73, 36), 0, 0, 360, 255, -1, cv2.LINE_AA)
        mask = cv2.GaussianBlur(mask, (0, 0), 5)
        blend = cv2.resize(mask, (right - x, bottom - y)).astype(np.float32)[:, :, None] / 255
        length = data["frames"]
        with torch.inference_mode():
            control.stage("encoding")
            windows = whisper_windows(self.whisper, self.processor, speech, length)
            ref = torch.from_numpy(crop.copy()).permute(2, 0, 1).to(device="cuda", dtype=torch.float16) / 255
            masked = ref.clone()
            masked[:, 128:] = 0
            inputs = torch.stack((masked, ref)) * 2 - 1
            gen = torch.Generator(device="cuda").manual_seed(data["seed"])
            latents = self.vae.encode(inputs).latent_dist.sample(generator=gen) * self.vae.config.scaling_factor
            latents = torch.cat((latents[0], latents[1]), dim=0).unsqueeze(0)
            def frames():
                control.stage("sampling")
                for start in range(0, length, 4):
                    control.check()
                    conditioning = windows[start:start + 4]
                    predicted = self.unet(latents.expand(len(conditioning), -1, -1, -1), 0,
                                          encoder_hidden_states=conditioning).sample
                    decoded = self.vae.decode(predicted / self.vae.config.scaling_factor).sample
                    images = (decoded.float() * .5 + .5).clamp_(0, 1).mul_(255).round_().byte().permute(0, 2, 3, 1).cpu().numpy()
                    for i, image in enumerate(images, start + 1):
                        if ink is not None:
                            image = ink.apply(image)
                        frame = replace_mouth(source, image, box, blend)
                        yield frame
                        control.progress(i, length, **(preview(frame) if i == 1 or i % 12 == 0 else {}))
            self.mux(output, audio, canvas, length, data["fps"], frames(), control)
        self.completed += 1
        return {"adapter":data["modelId"], "modelSha256":assets["unet"][1], "memoryPolicy":"resident",
                "weightReuse":reused, "modelReused":reused, "modelIdentityScope":"full-byte-chunk-sha256",
                "contextId":self.context_id, "loadCount":self.loads, "contextJobs":self.completed, "workerPid":os.getpid(),
                "portraitDetector":detector, "speechSamples":samples, "speechSampleRate":rate,
                "speechFrames":(samples * data["fps"] + rate - 1) // rate, "outputFrames":length,
                "faceBox":list(box), "cudaPeakAllocatedBytes":torch.cuda.max_memory_allocated(),
                "componentSha256":{key:sha for key, (_, sha) in assets.items()}}

    @staticmethod
    def mux(output, audio, canvas, length, fps, frames, control):
        with tempfile.TemporaryDirectory(dir=output.parent) as tmp, tempfile.TemporaryFile() as log:
            encoded = Path(tmp) / "dialogue.mp4"
            command = [media.encoder(Error), "-nostdin", "-hide_banner", "-v", "error", "-n",
                       "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{canvas[0]}x{canvas[1]}",
                       "-framerate", str(fps), "-i", "pipe:0", "-i", str(audio),
                       "-map", "0:v:0", "-map", "1:a:0", "-af", "apad", "-t", str(length/fps),
                       "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-crf", "17", "-preset", "fast",
                       "-c:a", "aac", "-ar", "48000", "-b:a", "128k", "-movflags", "+faststart", str(encoded)]
            proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log, creationflags=FLAGS)
            try:
                for frame in frames:
                    control.check()
                    proc.stdin.write(frame.tobytes())
                proc.stdin.close()
                control.stage("saving")
                for _ in range(300):
                    control.check()
                    if proc.poll() is not None:
                        break
                    control.cancelled.wait(0.1)
                if proc.poll() != 0:
                    log.seek(0)
                    raise Error("NATIVE_VIDEO_ENCODE_FAILED", log.read(900).decode("utf8", "replace") or "配音视频编码超时。")
                control.check()
                encoded.rename(output)
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.wait()
                proc.stdin.close()
