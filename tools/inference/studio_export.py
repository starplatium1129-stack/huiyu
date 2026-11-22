"""Local CPU assembly for frozen, ordered studio shot versions. Protocol uses one JSON object per line."""
import argparse
from fractions import Fraction
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading

# The desktop's isolated Python (-I) omits this script's directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio_export_assets import NAME
from studio_export_enhance import Enhancement, import_cpu_runtime
from studio_export_media import (audio_streams, can_copy_audio, can_copy_video, concat_list, fraction,
                                frame_filter, length, nearest, num_frames, rate, read_clip, video_streams)
from studio_export_process import MEDIA_FORMATS, ExportError, Session, binaries, probe

ENCODE = ["-c:v", "libx264", "-preset", "fast", "-crf", "17", "-pix_fmt", "yuv420p", "-threads", "4"]
PRIVATE_OUTPUT = ["-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart"]
LOCAL = ["-protocol_whitelist", "file,pipe"]
MEDIA = [*LOCAL, "-format_whitelist", MEDIA_FORMATS]


def local_path(value, exists=True):
    if not isinstance(value, str) or not value or "\0" in value or "\n" in value or "\r" in value:
        raise ExportError("STUDIO_EXPORT_INVALID_PATH", "导出需要本地绝对路径。")
    path = Path(value)
    if not path.is_absolute():
        raise ExportError("STUDIO_EXPORT_INVALID_PATH", "导出需要本地绝对路径。")
    if exists and not path.is_file():
        raise ExportError("STUDIO_EXPORT_MISSING_MEDIA", "冻结分镜的本地原件不可用。")
    return path.resolve(strict=exists)


def request(value):
    shots, options = value.get("shots"), value.get("options")
    if value.get("op") != "compose" or not isinstance(shots, list) or not 1 <= len(shots) <= 256:
        raise ExportError("STUDIO_EXPORT_INVALID_INPUT", "需要按时间线排序的分镜列表。")
    keys = {"upscale", "interpolate", "useShotAudio"}
    if not isinstance(options, dict) or options.keys() != keys or any(type(options[k]) is not bool for k in keys):
        raise ExportError("STUDIO_EXPORT_INVALID_INPUT", "导出选项必须明确指定超分、插帧和分镜配音。")
    paths = []
    for shot in shots:
        if not isinstance(shot, dict):
            raise ExportError("STUDIO_EXPORT_INVALID_INPUT", "分镜输入格式无效。")
        audio = shot.get("audioPath") if options["useShotAudio"] else None
        paths.append((local_path(shot.get("videoPath")), local_path(audio) if audio is not None else None))
    target = local_path(value.get("outputPath"), False)
    if (Path(value["outputPath"]).is_symlink() or target.suffix.lower() != ".mp4"
            or not target.parent.is_dir() or target.exists()):
        raise ExportError("STUDIO_EXPORT_INVALID_OUTPUT", "导出目标需要是私有目录内尚未使用的 MP4 路径。")
    models = local_path(value["modelsRoot"], False) / NAME if value.get("modelsRoot") else None
    return paths, options, target, models


def staged_video(session, tools, work, clip, i, canvas, fps, count, copy, audio_copy, enhance, interpolate, update):
    output = work / f"video-{i:04d}.mp4"
    source = [tools[0], *MEDIA, "-i", str(clip["path"]), "-map", f"0:{clip['video']['index']}"]
    if copy:
        tracks = ["-map", f"0:{clip['audio']['index']}", "-c:a", "copy"] if audio_copy else ["-an"]
        session.run([*source, *tracks, "-c:v", "copy", *PRIVATE_OUTPUT, str(output)], work,
                    ffmpeg=True, progress=lambda sec: update("copy", min(1, sec / float(clip["duration"]))))
        return output
    vf = frame_filter(clip, canvas, fps, count)
    if enhance.net is None and not interpolate:
        session.run([*source, "-an", "-filter_threads", "2", "-vf", vf, "-frames:v", str(count),
                     *ENCODE, *PRIVATE_OUTPUT, str(output)], work, ffmpeg=True,
                    progress=lambda sec: update("normalize", min(1, sec / float(clip["duration"]))))
        return output
    # Only one shot's frame sequence exists at a time; every subprocess is CPU-only.
    with tempfile.TemporaryDirectory(prefix="frames-", dir=work) as directory:
        temporary = Path(directory)
        frames = temporary / "source"
        frames.mkdir()
        session.run([*source, "-an", "-filter_threads", "2", "-vf", vf, "-frames:v", str(count),
                     "-pix_fmt", "rgb24", "-threads", "2", "-compression_level", "1",
                     str(frames / "%08d.png")], work, ffmpeg=True,
                    progress=lambda sec: update("decode", min(.1, .1 * sec / float(clip["duration"]))))
        pictures = enhance.sequence(frames, count)
        if interpolate:
            next_frames = temporary / "interpolated"
            share = .4 if enhance.net is not None else .8
            enhance.interpolate(session, tools, frames, next_frames, count, fps, work,
                                lambda x: update("interpolate", .1 + share * x))
            count *= 2
            fps *= 2
            frames = next_frames
            pictures = enhance.sequence(frames, count)
        if enhance.net is not None:
            next_frames = temporary / "enlarged"
            start = .5 if interpolate else .1
            enhance.upscale(pictures, next_frames, session, lambda x: update("upscale", start + (.9-start)*x))
            frames = next_frames
        session.run([tools[0], "-framerate", str(fps), "-i", str(frames / "%08d.png"),
                     "-an", "-frames:v", str(count), *ENCODE, *PRIVATE_OUTPUT, str(output)],
                    work, ffmpeg=True, progress=lambda sec: update("encode", min(1, .9 + .1*sec/float(clip["duration"]))))
    return output


def staged_audio(session, tools, work, clip, i, samples):
    target = work / f"audio-{i:04d}.wav"
    offset = 0
    if clip["audio"]:
        input_args = [*MEDIA, "-i", str(clip["audioPath"]), "-map", f"0:{clip['audio']['index']}"]
        if not clip["override"]:
            offset = nearest((fraction(clip["audio"].get("start_time")) - fraction(clip["video"].get("start_time"))) * 48000)
    else:
        input_args = ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    sync = f"adelay={min(samples, offset)}S:all=1," if offset > 0 else (
        f"atrim=start_sample={-offset},asetpts=PTS-STARTPTS," if offset < 0 else "")
    vf = ("asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo," + sync +
          f"apad,atrim=end_sample={samples},asetpts=N/SR/TB")
    session.run([tools[0], *input_args, "-vn", "-af", vf, "-c:a", "pcm_s16le", str(target)], work, ffmpeg=True)
    return target


def verify(session, tools, work, output, size, fps, frames, duration, audio, on_progress):
    # ffprobe counts decoded pictures; FFmpeg also rejects damaged audio/video
    # packets and decoder errors, including failures at the very end of a file.
    tracks = probe(session, tools, output, work, count=True)
    videos, audios = video_streams(tracks), audio_streams(tracks)
    if len(videos) != 1 or len(audios) != int(audio):
        raise ExportError("STUDIO_EXPORT_VERIFY_FAILED", "导出视频或音轨数量与分镜清单不一致。")
    v = videos[0]
    measured = length(v)
    if ((v.get("width"), v.get("height")) != size or str(v.get("nb_read_frames")) != str(frames)
            or abs(float(rate(v) - fps)) > .05 or abs(measured-duration) > 1/fps):
        raise ExportError("STUDIO_EXPORT_VERIFY_FAILED", "成片的实际画幅、帧数、帧率或时长与冻结时间线不一致。")
    if audios and abs(length(audios[0]) - duration) > max(Fraction(1024, 48000), 1/fps):
        raise ExportError("STUDIO_EXPORT_VERIFY_FAILED", "成片的音轨时长与视频时间线不一致。")
    session.run([tools[0], *MEDIA, "-err_detect", "explode", "-i", str(output), "-map", "0:v:0",
                 "-map", "0:a:0?", "-f", "null", "-"], work, ffmpeg=True,
                progress=lambda sec: on_progress(min(1, sec / float(duration))))
    return {"width": size[0], "height": size[1], "frames": frames, "fps": float(fps),
            "frameRate": str(fps), "duration": float(measured), "hasAudio": bool(audios),
            "videoCodec": v["codec_name"], "audioCodec": audios[0]["codec_name"] if audios else None}


def compose(session, data):
    paths, options, target, models = request(data)
    tools = binaries()
    total = len(paths)
    with tempfile.TemporaryDirectory(prefix=".huiyu-export-", dir=target.parent) as temporary:
        work = Path(temporary)
        clips = []
        for n, (video, audio) in enumerate(paths, 1):
            session.progress("probe", n, total, .05*(n-1)/total)
            clips.append(read_clip(session, tools, work, video, audio))
        enhance = Enhancement(models, options["upscale"], options["interpolate"])
        copy = not options["upscale"] and not options["interpolate"] and can_copy_video(clips)
        wanted_audio = any(clip["audio"] for clip in clips)
        direct_audio = bool(copy and wanted_audio and can_copy_audio(clips))
        base_fps, canvas = rate(clips[0]["video"]), clips[0]["display"]
        final_fps = base_fps * (2 if options["interpolate"] else 1)
        size = (clips[0]["video"]["width"], clips[0]["video"]["height"]) if copy else tuple(
            x * (2 if options["upscale"] else 1) for x in canvas)
        if size[0]*size[1] > 8192**2:
            raise ExportError("STUDIO_EXPORT_INVALID_MEDIA", "整片画布超过可编码尺寸。")
        lengths, videos, audio, frames, elapsed, samples = [], [], [], 0, Fraction(0), 0
        for i, clip in enumerate(clips, 1):
            def progress(stage, relative):
                session.progress(stage, i, total, .05 + .80*(i-1 + .95*relative)/total)
            progress("copy" if copy else "normalize", 0)
            count = num_frames(clip["video"]) if copy else max(1, nearest(clip["duration"] * base_fps))
            duration = clip["duration"] if copy else Fraction(count, 1)/base_fps
            videos.append(staged_video(session, tools, work, clip, i, canvas, base_fps, count, copy, direct_audio,
                                       enhance, options["interpolate"], progress))
            lengths.append(duration)
            elapsed += duration
            frames += count * (2 if options["interpolate"] else 1)
            if wanted_audio and not direct_audio:
                progress("audio", 1)
                cumulative_samples = nearest(elapsed * 48000)
                audio.append(staged_audio(session, tools, work, clip, i, cumulative_samples-samples))
                samples = cumulative_samples
        session.progress("concat", total, total, .85)
        video_list = concat_list(work, "video.ffconcat", videos, lengths)
        inputs = [*LOCAL, "-f", "concat", "-safe", "1", "-i", str(video_list)]
        if audio:
            audio_list = concat_list(work, "audio.ffconcat", audio)
            inputs += [*LOCAL, "-f", "concat", "-safe", "1", "-i", str(audio_list)]
            sound = ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
        else:
            sound = ["-map", "0:a:0", "-c:a", "copy"] if direct_audio else ["-an"]
        output = work / "movie.mp4"
        session.run([tools[0], *inputs, "-map", "0:v:0", "-c:v", "copy", *sound, *PRIVATE_OUTPUT, str(output)],
                    work, ffmpeg=True, progress=lambda sec: session.progress("concat", total, total, .85+.06*min(1, sec/float(elapsed))))
        session.progress("verify", total, total, .92)
        meta = verify(session, tools, work, output, size, final_fps, frames, elapsed, wanted_audio,
                      lambda x: session.progress("verify", total, total, .93+.06*x))
        digest = hashlib.sha256()
        with output.open("rb") as media:
            for block in iter(lambda: media.read(1024*1024), b""):
                session.check()
                digest.update(block)
        meta.update(sha256=digest.hexdigest(), bytes=output.stat().st_size, shotCount=total,
                    videoMode="stream-copy" if copy else "encode", audioMode="stream-copy" if direct_audio else
                    ("aligned-aac" if wanted_audio else "none"), upscaler=enhance.upscaler, interpolator=enhance.interpolator,
                    device="cpu")
        session.check()
        # Both paths are on the same volume. Publication never replaces a file,
        # even when two host operations accidentally name the same destination.
        if os.name == "nt":
            os.rename(output, target)
        else:
            os.link(output, target)
        # Echo the host's spelling after writing the resolved path. Windows can
        # represent the same private TEMP directory with either an 8.3 or long name.
        return {"outputPath": data["outputPath"], "metadata": meta}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true", required=True)
    parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    # This private duplicate avoids holding Python's standard buffered stdin during interpreter shutdown.
    channel = io.BufferedReader(io.FileIO(os.dup(sys.stdin.fileno()), "rb"))
    task_id = ""
    def emit(event, **payload):
        print(json.dumps({"id":task_id, "event":event, **payload}, ensure_ascii=False, separators=(",", ":")), flush=True)
    try:
        line = channel.readline(2*1024*1024+1)
        if len(line) > 2*1024*1024:
            raise ExportError("STUDIO_EXPORT_INVALID_INPUT", "导出清单过大。")
        data = json.loads(line)
        if not isinstance(data, dict) or not isinstance(data.get("id"), str) or not 1<=len(data["id"])<=200:
            raise ExportError("STUDIO_EXPORT_INVALID_INPUT", "导出编号无效。")
        task_id = data["id"]
        session = Session(task_id, emit)
        # Blocking on a Windows CRT pipe during the first NumPy/Torch DLL load
        # can deadlock the loader. A pending cancel stays queued in the pipe.
        if isinstance(data.get("options"), dict) and data["options"].get("upscale") is True:
            session.progress("dependencies", 1, len(data.get("shots") or []), 0.)
            import_cpu_runtime()
        def controls():
            while True:
                cmd = channel.readline(4097)
                if not cmd:
                    session.cancelled.set()
                    return
                try:
                    value = json.loads(cmd)
                except (UnicodeError, ValueError):
                    continue
                if isinstance(value, dict) and value.get("id") == task_id and value.get("op") == "cancel":
                    session.cancelled.set()
                    return
        threading.Thread(target=controls, daemon=True).start()
        result = compose(session, data)
        emit("result", **result)
        return 0
    except Exception as error:
        code = getattr(error, "code", "STUDIO_EXPORT_FAILED")
        emit("cancelled" if code == "STUDIO_EXPORT_CANCELLED" else "error", code=code, message=str(error)[:2000])
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
