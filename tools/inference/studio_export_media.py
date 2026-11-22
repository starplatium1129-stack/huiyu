"""Stream compatibility, per-shot timing and display geometry for studio export."""
from fractions import Fraction
import math
from pathlib import Path

from studio_export_process import ExportError, probe


def fraction(value):
    try:
        return Fraction(str(value).replace(":", "/"))
    except (ValueError, ZeroDivisionError):
        return Fraction(0)


def nearest(value):
    return math.floor(value + Fraction(1, 2))


def length(stream):
    ticks = fraction(stream.get("duration_ts"))
    timebase = fraction(stream.get("time_base"))
    return ticks * timebase if ticks > 0 and timebase > 0 else fraction(stream.get("duration"))


def video_streams(document):
    return [s for s in document.get("streams", []) if s.get("codec_type") == "video"
            and not s.get("disposition", {}).get("attached_pic")]


def audio_streams(document):
    return [s for s in document.get("streams", []) if s.get("codec_type") == "audio"]


def rate(stream):
    value = fraction(stream.get("avg_frame_rate")) or fraction(stream.get("r_frame_rate"))
    if not (0 < value <= 240):
        raise ExportError("STUDIO_EXPORT_INVALID_MEDIA", "视频帧率无法用于时间线。")
    return value


def rotation(stream):
    side = next((entry.get("rotation") for entry in stream.get("side_data_list", []) if "rotation" in entry), 0)
    return nearest(fraction(side)) % 360


def display_size(stream):
    w, h = int(stream.get("width") or 0), int(stream.get("height") or 0)
    if not w or not h or w * h > 8192 ** 2:
        raise ExportError("STUDIO_EXPORT_INVALID_MEDIA", "视频画幅无效或超过可解码尺寸。")
    sar = fraction(stream.get("sample_aspect_ratio")) or Fraction(1)
    w = max(2, 2 * nearest(Fraction(w, 2) * sar))
    h = max(2, 2 * nearest(Fraction(h, 2)))
    return (h, w) if rotation(stream) in (90, 270) else (w, h)


VIDEO_FIELDS = ("codec_name", "profile", "level", "codec_tag_string", "width", "height", "pix_fmt",
                "sample_aspect_ratio", "time_base", "avg_frame_rate", "r_frame_rate", "field_order",
                "color_range", "color_space", "color_transfer", "color_primaries", "chroma_location",
                "extradata_size", "extradata_hash")
AUDIO_FIELDS = ("codec_name", "codec_tag_string", "profile", "sample_rate", "channels", "channel_layout",
                "sample_fmt", "time_base", "extradata_hash")


def signature(stream, fields):
    return tuple(stream.get(k) for k in fields)


def num_frames(stream):
    n = stream.get("nb_frames")
    return int(n) if n and str(n).isdigit() else 0


def can_copy_video(clips):
    first = clips[0]["video"]
    if first.get("codec_name") not in ("h264", "hevc", "mpeg4", "av1"):
        return False
    if not first.get("extradata_hash"):
        return False
    expected = signature(first, VIDEO_FIELDS)
    for clip in clips:
        stream = clip["video"]
        n = num_frames(stream)
        if (signature(stream, VIDEO_FIELDS) != expected or rotation(stream) != rotation(first)
                or n < 1 or abs(Fraction(n, 1) / rate(stream) - clip["duration"]) > Fraction(1, 1000)
                or abs(fraction(stream.get("start_time"))) > Fraction(1, 1000)):
            return False
    return True


def can_copy_audio(clips):
    first = clips[0]["audio"]
    if not first or first.get("codec_name") not in ("aac", "alac", "mp3", "ac3", "eac3"):
        return False
    expected = signature(first, AUDIO_FIELDS)
    return all(not clip["override"] and clip["audio"] and signature(clip["audio"], AUDIO_FIELDS) == expected
               and abs(length(clip["audio"]) - clip["duration"]) <= Fraction(1, 1000)
               and abs(fraction(clip["audio"].get("start_time"))) < Fraction(1, 1000) for clip in clips)


def read_clip(session, tools, work, video_path, audio_path):
    document = probe(session, tools, video_path, work)
    streams = video_streams(document)
    if len(streams) != 1:
        raise ExportError("STUDIO_EXPORT_INVALID_MEDIA", "每个分镜需有一条可播放的视频流。")
    video = streams[0]
    duration = length(video) or fraction(document.get("format", {}).get("duration"))
    if duration <= 0 or duration > 24 * 60 * 60:
        raise ExportError("STUDIO_EXPORT_INVALID_MEDIA", "视频缺少可用时长。")
    pictures = display_size(video)
    tracks = audio_streams(probe(session, tools, audio_path, work)) if audio_path else audio_streams(document)
    if audio_path and not tracks:
        raise ExportError("STUDIO_EXPORT_INVALID_AUDIO", "所绑定配音没有可播放的音频流。")
    return {"path": video_path, "audioPath": audio_path or video_path, "override": bool(audio_path),
            "video": video, "audio": tracks[0] if tracks else None, "duration": duration, "display": pictures}


def frame_filter(clip, canvas, fps, target_frames):
    w, h = canvas
    source_w, source_h = clip["display"]
    factor = min(Fraction(w, source_w), Fraction(h, source_h))
    fit_w = min(w, max(2, 2 * nearest(source_w * factor / 2)))
    fit_h = min(h, max(2, 2 * nearest(source_h * factor / 2)))
    filters = []
    if clip["video"].get("color_transfer") in ("smpte2084", "arib-std-b67"):
        filters += ["zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709",
                    "tonemap=hable", "zscale=t=bt709:m=bt709:r=tv"]
    if clip["video"].get("field_order") not in (None, "unknown", "progressive"):
        filters.append("bwdif=mode=send_frame")
    filters += ["setpts=PTS-STARTPTS", f"fps=fps={fps}:round=near",
                f"scale={fit_w}:{fit_h}:flags=lanczos", "setsar=1", f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2",
                "tpad=stop_mode=clone:stop_duration=1", f"trim=end_frame={target_frames}"]
    return ",".join(filters)


def concat_list(work, name, files, durations=None):
    # Only host-generated relative names enter a concat script. Original aliases
    # and user path characters never become directives or protocols.
    lines = ["ffconcat version 1.0"]
    for index, file in enumerate(files):
        relative = Path(file).relative_to(work).as_posix()
        if any(not (c.isascii() and (c.isalnum() or c in "-_./")) for c in relative):
            raise ExportError("STUDIO_EXPORT_INVALID_PATH", "导出暂存文件名无效。")
        lines.append(f"file '{relative}'")
        if durations:
            lines.append(f"duration {float(durations[index]):.9f}")
    target = work / name
    target.write_text("\n".join(lines) + "\n", encoding="ascii")
    return target
