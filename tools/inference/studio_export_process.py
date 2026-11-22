"""Cancellation, bounded diagnostics and measured progress for the CPU export worker."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time

# Frozen media must be self-contained; playlist demuxers can request other files.
MEDIA_FORMATS = "mov,matroska,webm,avi,mpegts,mpeg,m4v,asf,wav,w64,mp3,flac,ogg,aac,aiff"


class ExportError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Session:
    def __init__(self, task_id, emit):
        self.id = task_id
        self.emit = emit
        self.cancelled = threading.Event()
        self.deadline = time.monotonic() + 4 * 60 * 60
        self.value = 0.0
        self.last = None

    def check(self):
        if self.cancelled.is_set():
            raise ExportError("STUDIO_EXPORT_CANCELLED", "整片导出已取消。")
        if time.monotonic() > self.deadline:
            raise ExportError("STUDIO_EXPORT_TIMEOUT", "整片导出已超过四小时。")

    def progress(self, stage, index, total, value):
        self.check()
        self.value = max(self.value, min(.999, max(0., value)))
        update = (stage, index, total, round(self.value, 4))
        if update != self.last:
            self.emit("progress", stage=stage, index=index, total=total, value=update[-1])
            self.last = update

    def run(self, args, cwd, progress=None, ffmpeg=False, tick=None):
        self.check()
        if ffmpeg:
            args = [*args[:1], "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror",
                    "-progress", "pipe:1", "-nostats", *args[1:]]
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        # A file-backed pipe cannot stall an encoder that writes diagnostics or
        # frame progress faster than its supervisor. No shell interprets user paths.
        with tempfile.TemporaryFile() as errors, tempfile.NamedTemporaryFile(dir=cwd, delete=False) as out:
            output = Path(out.name)
            process = None
            try:
                process = subprocess.Popen(args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=out,
                                           stderr=errors, creationflags=flags)
                with output.open("rb") as observed:
                    line_buffer = b""
                    next_tick = 0.0
                    while process.poll() is None:
                        self.check()
                        if tick is not None and time.monotonic() >= next_tick:
                            tick()
                            next_tick = time.monotonic() + .7
                        if progress is not None:
                            chunk = observed.read(64 * 1024)
                            if chunk:
                                lines = (line_buffer + chunk).split(b"\n")
                                line_buffer = lines.pop()
                                for line in lines:
                                    key, _, raw = line.strip().partition(b"=")
                                    if key == b"out_time_us" and raw.isdigit():
                                        progress(int(raw) / 1_000_000)
                        self.cancelled.wait(.12)
                self.check()
                if process.returncode:
                    end = errors.seek(0, 2)
                    errors.seek(max(0, end - 2400))
                    reason = errors.read().decode("utf-8", "replace").strip()
                    raise ExportError("STUDIO_EXPORT_TOOL_FAILED", f"{Path(args[0]).name} 退出（{process.returncode}）。{reason}")
                if ffmpeg:
                    return b""
                if output.stat().st_size > 4 * 1024 * 1024:
                    raise ExportError("STUDIO_EXPORT_INVALID_MEDIA", "媒体探针结果过大。")
                return output.read_bytes()
            finally:
                if process is not None and process.poll() is None:
                    process.kill()
                    process.wait()
                out.close()
                output.unlink(missing_ok=True)


def binaries():
    ffmpeg = shutil.which(os.environ.get("HUIYU_NATIVE_FFMPEG") or "ffmpeg")
    if not ffmpeg:
        raise ExportError("STUDIO_EXPORT_FFMPEG_MISSING", "找不到 FFmpeg，请安装本机 FFmpeg 或设置 HUIYU_NATIVE_FFMPEG。")
    explicit = os.environ.get("HUIYU_NATIVE_FFPROBE")
    sibling = Path(ffmpeg).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    ffprobe = shutil.which(explicit) if explicit else (str(sibling) if sibling.is_file() else shutil.which("ffprobe"))
    if not ffprobe:
        raise ExportError("STUDIO_EXPORT_FFPROBE_MISSING", "找不到 ffprobe，请安装同套 FFmpeg 工具。")
    return ffmpeg, ffprobe


def probe(session, tools, path, work, count=False):
    argv = [tools[1], "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS]
    if count:
        argv += ["-count_frames"]
    argv += ["-show_streams", "-show_format", "-show_data_hash", "sha256", "-of", "json", str(path)]
    document = json.loads(session.run(argv, work))
    return document
