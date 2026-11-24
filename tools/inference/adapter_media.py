"""Bounded native media encoding using Pillow and an installed ffmpeg."""
import os
import shutil
import subprocess
import tempfile
import threading
import time
import wave


def input_image(path, error):
    from PIL import Image, ImageOps
    try:
        with Image.open(path) as image:
            if image.format not in ("PNG", "JPEG", "WEBP") or getattr(image, "n_frames", 1) != 1 or image.width * image.height > 4096**2:
                raise error("INVALID_IMAGE", "Expected a still PNG/JPEG/WebP of at most 16 megapixels")
            return ImageOps.exif_transpose(image).convert("RGBA")
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise error("INVALID_IMAGE", f"Cannot decode edit input: {exc}") from exc


def pixels(value, data, channels, error, *, truncate=False):
    import numpy as np
    value = np.asarray(value)
    if value.ndim != 3 or value.shape[:2] != (data["height"], data["width"]) or value.shape[2] not in channels:
        raise error("INVALID_MODEL_OUTPUT", "Model returned invalid dimensions/channels")
    if data.get("h3Decoder") == "dwd" and value.dtype == np.uint8:
        return np.ascontiguousarray(value)
    if not np.isfinite(value).all():
        raise error("INVALID_MODEL_OUTPUT", "Model returned invalid dimensions/channels/non-finite pixels")
    scaled = value.clip(0, 1) * 255
    return np.ascontiguousarray((scaled if truncate else scaled.round()).astype(np.uint8))


def png(value, path, data, error):
    from PIL import Image
    Image.fromarray(pixels(value, data, (3, 4), error)).save(path, format="PNG")


def encoder(error):
    path = shutil.which(os.environ.get("HUIYU_NATIVE_FFMPEG", "ffmpeg"))
    if path is None:
        raise error("NATIVE_VIDEO_ENCODER_MISSING", "Install ffmpeg with libx264 or set HUIYU_NATIVE_FFMPEG to its executable; no automatic download")
    return path


def write_audio(value, path, sample_rate, data, control, error):
    import numpy as np
    control.check()
    value = value.detach().float().cpu().numpy()
    if value.ndim != 2 or value.shape[0] not in (1, 2) or sample_rate not in (32000, 44100, 48000):
        raise error("INVALID_MODEL_OUTPUT", "Expected channel-first mono/stereo audio at the model sample rate")
    expected = data["frames"] / data["fps"] * sample_rate
    if not np.isfinite(value).all() or abs(value.shape[1] - expected) > sample_rate / 4:
        raise error("INVALID_MODEL_OUTPUT", "Generated audio is non-finite or does not match video duration")
    with wave.open(path, "wb") as target:
        target.setnchannels(value.shape[0])
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        for start in range(0, value.shape[1], sample_rate):
            control.check()
            chunk = value[:, start:start + sample_rate].T
            target.writeframes((chunk.clip(-1, 1) * 32767).round().astype("<i2").tobytes())


def encode_h264(args, frames, data, control, error):
    # A full pipe can block the generation thread inside write/close. Killing
    # its reader unblocks the write on Windows as well as on POSIX.
    timeout = 60 + len(frames) // 2
    deadline = time.monotonic() + timeout
    stopped = threading.Event()
    interrupted = None
    timed_out = False
    pipe_error = None
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)

        def watch():
            nonlocal interrupted, timed_out
            while not stopped.wait(0.1) and process.poll() is None:
                try:
                    control.check()
                except Exception as exc:
                    interrupted = exc
                else:
                    if time.monotonic() < deadline:
                        continue
                    timed_out = True
                process.kill()
                return

        watcher = threading.Thread(target=watch, name="native-video-encoder")
        try:
            watcher.start()
            try:
                with process.stdin:
                    for frame in frames:
                        control.check()
                        process.stdin.write(pixels(frame, data, (3,), error))
            except OSError as exc:
                pipe_error = exc
            status = process.wait()
        finally:
            if process.poll() is None:
                process.kill()
            stopped.set()
            if watcher.ident is not None:
                watcher.join()
            process.wait()
            if not process.stdin.closed:
                process.stdin.close()
        control.check()
        if interrupted is not None:
            raise interrupted
        if timed_out:
            return error("NATIVE_VIDEO_ENCODE_TIMEOUT", f"ffmpeg encode exceeded {timeout} seconds")
        if status or pipe_error is not None:
            log.seek(0)
            detail = log.read(4096).decode("utf-8", errors="replace").strip()
            return error("NATIVE_VIDEO_ENCODE_FAILED", detail or str(pipe_error or f"ffmpeg exited {status}"))
    return None


def video(frames, path, data, control, error, soundtrack=None, sample_rate=None, *, device_backend=None):
    if len(frames) != data["frames"]:
        raise error("INVALID_MODEL_OUTPUT", "Unexpected video frame count")
    args = [encoder(error), "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-n",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s:v", f"{data['width']}x{data['height']}",
            "-r", str(data["fps"]), "-i", "pipe:0"]
    if os.path.lexists(path):
        raise error("NATIVE_VIDEO_ENCODE_FAILED", "Video output already exists")
    with tempfile.TemporaryDirectory(prefix="native-video-", dir=os.path.dirname(path)) as work:
        if soundtrack is not None:
            audio_path = os.path.join(work, "soundtrack.wav")
            write_audio(soundtrack, audio_path, sample_rate, data, control, error)
            args += ["-i", audio_path, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
        else:
            args += ["-an"]
        codecs = []
        if device_backend == "cuda":
            codecs.append(("h264_nvenc", ["-pix_fmt", "nv12", "-rc", "vbr", "-cq", "23", "-b:v", "0"]))
        elif device_backend == "rocm" and os.name == "nt":
            codecs.append(("h264_amf", ["-pix_fmt", "nv12", "-rc", "cqp", "-qp_i", "21", "-qp_p", "23"]))
        elif device_backend == "xpu":
            codecs.append(("h264_qsv", ["-pix_fmt", "nv12", "-global_quality", "23"]))
        codecs.append(("libx264", ["-pix_fmt", "yuv420p"]))
        failures = []
        for codec, options in codecs:
            control.check()
            target = os.path.join(work, f"{codec}.mp4")
            command = [*args, "-c:v", codec, *options, "-t", str(data["frames"] / data["fps"]),
                       "-movflags", "+faststart", target]
            failure = encode_h264(command, frames, data, control, error)
            if failure is not None:
                failures.append(f"{codec}: {failure}")
                continue
            control.check()
            # Publish a completed MP4 without replacing an existing job output.
            if os.name == "nt":
                os.rename(target, path)
            else:
                os.link(target, path)
            return codec
        raise error(failure.code, "\n".join(failures))
