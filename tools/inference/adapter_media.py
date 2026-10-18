"""Bounded native media encoding using Pillow and an installed ffmpeg."""
import os
import shutil
import subprocess
import tempfile
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


def pixels(value, data, channels, error):
    import numpy as np
    value = np.asarray(value)
    if value.ndim != 3 or value.shape[:2] != (data["height"], data["width"]) or value.shape[2] not in channels or not np.isfinite(value).all():
        raise error("INVALID_MODEL_OUTPUT", "Model returned invalid dimensions/channels/non-finite pixels")
    return np.ascontiguousarray((value.clip(0, 1) * 255).round().astype(np.uint8))


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
    if value.ndim != 2 or value.shape[0] not in (1, 2) or sample_rate not in (32000, 48000):
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


def video(frames, path, data, control, error, soundtrack=None, sample_rate=None):
    if len(frames) != data["frames"]:
        raise error("INVALID_MODEL_OUTPUT", "Unexpected video frame count")
    args = [encoder(error), "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s:v", f"{data['width']}x{data['height']}",
            "-r", str(data["fps"]), "-i", "pipe:0"]
    with tempfile.TemporaryDirectory(prefix="native-audio-", dir=os.path.dirname(path)) as work, tempfile.TemporaryFile() as log:
        if soundtrack is not None:
            audio_path = os.path.join(work, "soundtrack.wav")
            write_audio(soundtrack, audio_path, sample_rate, data, control, error)
            args += ["-i", audio_path, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
        else:
            args += ["-an"]
        args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", str(data["frames"] / data["fps"]),
                 "-movflags", "+faststart", path]
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            for frame in frames:
                control.check()
                process.stdin.write(pixels(frame, data, (3,), error).tobytes())
            process.stdin.close()
            deadline = time.monotonic() + 60
            while process.poll() is None:
                control.check()
                if time.monotonic() > deadline:
                    raise error("NATIVE_VIDEO_ENCODE_TIMEOUT", "ffmpeg encode did not finish within 60 seconds")
                time.sleep(0.05)
            if process.returncode:
                log.seek(0)
                raise error("NATIVE_VIDEO_ENCODE_FAILED", log.read(4096).decode("utf-8", errors="replace"))
        except BrokenPipeError as exc:
            log.seek(0)
            raise error("NATIVE_VIDEO_ENCODE_FAILED", log.read(4096).decode("utf-8", errors="replace")) from exc
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
