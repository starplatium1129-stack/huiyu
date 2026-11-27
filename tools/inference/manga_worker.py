"""Native MangaScreen with optional local Qwen/lineart stages; no ComfyUI."""
import argparse
import contextlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import sys
import time


# Direct -I entry and nested adapter imports must share this fixed owner.
_lifecycle_path = Path(__file__).with_name("worker_lifecycle.py").resolve()
lifecycle = sys.modules.get("huiyu_worker_lifecycle")
if lifecycle is None:
    _spec = importlib.util.spec_from_file_location("huiyu_worker_lifecycle", _lifecycle_path)
    lifecycle = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = lifecycle
    try:
        _spec.loader.exec_module(lifecycle)
    except BaseException:
        sys.modules.pop(_spec.name, None)
        raise
elif Path(getattr(lifecycle, "__file__", "")).resolve() != _lifecycle_path:
    raise ImportError("Bundled worker lifecycle belongs to another runtime")
sibling = lifecycle.load_sibling


contract = sibling("manga_contract")
Error = contract.MangaError


def emit(stream, job_id, event, **values):
    stream.write(json.dumps({"id": job_id, "event": event, **values}, ensure_ascii=False) + "\n")
    stream.flush()


def dependencies():
    versions = {}
    expected_versions = dict(contract.MANIFEST["dependencies"])
    try:
        if importlib.metadata.version("torch").split("+")[0] == "2.13.0":
            expected_versions.update(numpy="2.4.4", Pillow="12.2.0")
            expected_versions["opencv-python-headless"] = "5.0.0.93"
    except importlib.metadata.PackageNotFoundError:
        pass  # Pure CPU MangaScreen does not require Torch.
    for name, expected in expected_versions.items():
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError as exc:
            raise Error("MANGA_DEPENDENCY_MISSING", f"Missing {name}; prepare requirements-manga.txt in the separate adapter Python") from exc
        if versions[name] != expected:
            raise Error("MANGA_DEPENDENCY_VERSION", f"Expected {name}=={expected}, found {versions[name]}")
    try:
        import cv2
        import numpy
        from PIL import Image
        cv2.ocl.setUseOpenCL(False)
        cv2.setNumThreads(2)
    except Exception as exc:
        raise Error("MANGA_DEPENDENCY_IMPORT", f"Cannot import CPU image dependencies: {exc}") from exc
    return versions


def _rewrite_rgb(path, source):
    """Match the upstream still-image decoder and the uint8 input to its Lanczos filter."""
    import numpy as np
    from PIL import Image, ImageOps
    try:
        import av
    except ImportError:
        av = None
    if av is not None:
        # The upload has already passed Pillow's format, frame and dimension limits.
        demuxer = {"JPEG": "jpeg_pipe", "PNG": "png_pipe", "WEBP": "webp_pipe"}[source.format]
        try:
            with av.open(str(path), mode="r", format=demuxer) as container:
                stream = container.streams.video[0]
                if (stream.width, stream.height) != source.size:
                    raise Error("MANGA_INPUT_SIZE", "图片解码器返回的尺寸不一致")
                stream.thread_type = "AUTO"
                frame = next(container.decode(stream))
                if (frame.width, frame.height) != source.size:
                    raise Error("MANGA_INPUT_SIZE", "图片解码器返回的尺寸不一致")
                rotation = (getattr(frame, "rotation", 0) // 90) % 4
                alpha = frame.format.name == "pal8" or any(c.is_alpha for c in frame.format.components)
                if frame.format.name in ("yuvj420p", "yuvj422p", "yuvj444p", "rgb24", "rgba", "pal8"):
                    rgb = frame.to_ndarray(format="rgba" if alpha else "rgb24")[..., :3]
                else:
                    width, height = source.size
                    if width % 32:
                        # swscale's float conversion needs aligned rows. Smear the
                        # right/bottom edges before converting, then use the original area.
                        right, bottom = -width % 32, -height % 32
                        graph = av.filter.Graph()
                        graph.link_nodes(graph.add_buffer(template=frame),
                                         graph.add("pad", f"{width + right}:{height + bottom}:0:0"),
                                         graph.add("fillborders", f"right={right}:bottom={bottom}:mode=smear"),
                                         graph.add("buffersink"))
                        graph.configure()
                        graph.push(frame)
                        frame = graph.pull()
                    converted = frame.reformat(format="gbrapf32le" if alpha else "gbrpf32le")
                    rgb = np.empty((height, width, 3), dtype=np.uint8)
                    # FFmpeg stores planar G, B, R. Reuse each float plane to
                    # truncate into Lanczos' byte RGB without a second float image.
                    for i, plane_index in enumerate((2, 0, 1)):
                        plane = converted.planes[plane_index]
                        values = np.ndarray((height, width), "<f4", plane, strides=(plane.line_size, 4))
                        values *= 255.0
                        np.clip(values, 0, 255, out=values)
                        rgb[..., i] = values
                if rotation:
                    rgb = np.rot90(rgb, k=rotation)
                return Image.fromarray(rgb)
        except (av.error.FFmpegError, StopIteration):
            pass  # Pillow also handles still images unsupported by the optional decoder.
    ImageOps.exif_transpose(source, in_place=True)
    return source.convert("RGB")


def read_image(path, background_color="white", *, rewrite_size=None):
    import numpy as np
    from PIL import Image, ImageOps
    m = contract.MANIFEST
    max_side = m["rewrite"]["maxSourceSide"] if rewrite_size else m["maxInputSide"]
    max_pixels = m["rewrite"]["maxSourcePixels"] if rewrite_size else m["maxInputPixels"]
    try:
        if Path(path).stat().st_size > 16 * 1024**2:
            raise Error("MANGA_INPUT_SIZE", "漫画输入图片不能超过 16 MiB")
        with Image.open(path) as source:
            if (source.format not in ("PNG", "JPEG", "WEBP") or getattr(source, "n_frames", 1) != 1
                    or min(source.size) < m["minInputSide"] or max(source.size) > max_side
                    or source.width * source.height > max_pixels):
                raise Error("MANGA_INPUT_SIZE", f"请输入单帧 PNG/JPEG/WebP，边长 {m['minInputSide']}–{max_side}，最多 {max_pixels} 像素")
            if rewrite_size:
                # LoadImage supplies RGB independently of alpha. Scale directly
                # to the authored grid before caching or allocating a NumPy copy.
                with _rewrite_rgb(path, source) as rgb:
                    if rgb.size != rewrite_size:
                        with rgb.resize(rewrite_size, Image.Resampling.LANCZOS) as resized:
                            return np.array(resized)
                    return np.array(rgb)
            # Apply EXIF once; transparent pixels use paper or the selected line-map background.
            with ImageOps.exif_transpose(source).convert("RGBA") as oriented:
                with Image.new("RGBA", oriented.size, background_color) as background:
                    background.alpha_composite(oriented)
                    with background.convert("RGB") as rgb:
                        return np.asarray(rgb).copy()
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise Error("INVALID_IMAGE", f"Cannot decode MangaScreen input: {exc}") from exc


def generate(job, control, _prepared, *, resident=None):
    started = control.started
    data = contract.validate(job)
    import cv2
    import numpy as np
    from PIL import Image
    line_only = data["operation"] == "lineart"
    core = None if line_only else sibling("manga_screen")
    control.stage("preparing_image")
    rewrite = data.get("rewrite", {})
    upstream = rewrite.get("modelId") == "qwen-image-2.1-manga-int8"
    rewrite_size = (rewrite["width"], rewrite["height"]) if upstream else None
    rgb = read_image(job["inputImagePath"], rewrite_size=rewrite_size)
    observation = {}
    models = None
    if data.get("rewrite") or data["autoLines"]:
        models = sibling("manga_models")
        control.stage("dependencies")
        if not _prepared:
            models.prepare(data)
    if data.get("rewrite"):
        redraw_started = time.perf_counter()
        rgb, observation["rewrite"] = models.rewrite(job, data, rgb, control, resident=resident)
        observation["timings"] = {"rewriteWallSeconds": time.perf_counter() - redraw_started}
    finish_started = time.perf_counter()
    k = rgb.shape[1] / 1024
    if "panel" in data:
        p = data["panel"]
        h, w = rgb.shape[:2]
        ratio = core.FRAMES[p["frame"]]
        cw, ch = (w, h) if ratio is None else ((w, round(w / ratio)) if w / h <= ratio else (round(h * ratio), h))
        margin = round(p["margin"] * k)
        ow, oh = min(cw, w) + 2 * margin, min(ch, h) + 2 * margin
        if max(ow, oh) > contract.MANIFEST["maxOutputSide"] or ow * oh > contract.MANIFEST["maxOutputPixels"]:
            raise Error("MANGA_OUTPUT_SIZE", "Panel/margin exceeds output budget; reduce margin or source dimensions")
    pen = None
    if job.get("penLinesPath"):
        black_lines = data.get("penLinesPolarity", "white-on-black") == "black-on-white"
        pen_rgb = read_image(job["penLinesPath"], "white" if black_lines else "black")
        if data.get("penLinesFit", "stretch") == "exact" and pen_rgb.shape[:2] != rgb.shape[:2]:
            raise Error("MANGA_LINE_SIZE", "外部线稿与处理图尺寸不同，请明确允许缩放对齐或导入同尺寸线稿")
        pen = pen_rgb.astype(np.float32).mean(-1) / 255
        if black_lines:
            pen = 1 - pen
        pen = cv2.resize(pen, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_AREA)
        del pen_rgb
    if "levels" in data:
        control.stage("manga_levels")
        p = data["levels"]
        grey = (rgb.astype(np.float32) / 255 * np.float32([0.299, 0.587, 0.114])).sum(-1)
        grey = np.clip((grey - p["black"]) / max(p["white"] - p["black"], 1e-3), 0, 1) ** (1 / p["gamma"])
        rgb = np.repeat(grey[..., None], 3, axis=2)
        # MangaFinish's upstream tensor wrapper truncates into uint8 before processing.
        if "finish" in data:
            rgb = (rgb * 255).clip(0, 255).astype(np.uint8)
    if data["autoLines"]:
        pen, observation["lineart"] = models.extract(rgb, job["lineartPath"], control, resident=resident, upstream=upstream)
    if pen is not None:
        control.stage("manga_line_saving")
        if not np.isfinite(pen).all():
            raise Error("MANGA_LINE_OUTPUT_INVALID", "线稿包含无效像素")
        # Preview/export uses ordinary black ink on white, before panel cropping.
        # Quantize the pen map used by MangaFinish to 8-bit PNG, before its thresholding.
        with Image.fromarray(((1 - pen.clip(0, 1)) * 255).round().astype(np.uint8)) as line_image:
            line_image.save(job["lineartOutputPath"], format="PNG")
    if "finish" in data:
        p = data["finish"]
        page = core.finish(rgb[..., :3], p["screen_lines"], p["white_point"], p["black_point"],
                           p["light_tone"], p["dark_tone"], p["gradation"], pen,
                           p["pen_threshold"], p["white_lines"], control)
        if "panel" not in data:
            rgb = np.repeat(page[..., None], 3, axis=2).astype(np.float32)
    if "panel" in data:
        control.stage("manga_panel")
        p = data["panel"]
        # MangaFinish already returns a binary page (white=True). Cropping
        # needs only its ink mask, so keep it single-channel until printing.
        ink = ~page if "finish" in data else rgb.mean(-1) < 127.5
        framed = core.cut_panel(ink, core.FRAMES[p["frame"]], p["crop_x"], p["crop_y"], round(p["border"] * k), round(p["margin"] * k))
        rgb = core.print_look(framed, p["paper"], p["ink"], k) / 255
    control.stage("saving")
    if not line_only:
        if not np.isfinite(rgb).all():
            raise Error("MANGA_OUTPUT_INVALID", "MangaScreen returned non-finite pixels")
        scaled = rgb.clip(0, 1) * 255
        with Image.fromarray((scaled if upstream else scaled.round()).astype(np.uint8)) as output:
            output.save(job["outputPath"], format="PNG")
    control.check()
    observation.setdefault("timings", {}).update(postprocessWallSeconds=time.perf_counter() - finish_started,
                                                workerWallSeconds=time.perf_counter() - started)
    emit(control.stream, job["id"], "result", outputPath=job["outputPath"], nativeRuntime={
        "processor": "manga-screen", "sourceRevision": contract.MANIFEST["revision"],
        "device": "cuda+cpu" if data.get("rewrite") or observation.get("lineart", {}).get("device") == "cuda" else "cpu", "validation": "处理完成",
        "generationVerified": True, **observation})


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--serve", action="store_true")
    mode.add_argument("--catalog", action="store_true")
    mode.add_argument("--diagnose", action="store_true")
    args = parser.parse_args()
    stream = sys.stdout
    try:
        with contextlib.redirect_stdout(sys.stderr):
            if args.catalog:
                emit(stream, None, "catalog", **contract.MANIFEST)
            elif args.diagnose:
                emit(stream, None, "diagnostic", dependencies=dependencies(), scope="imports-only; no image processing", validation="依赖检查完成")
            else:
                resident = sibling("manga_cache").Cache()
                def initialize(job, ready, _control):
                    data = contract.validate(job)
                    dependencies()
                    if data.get("rewrite") or data["autoLines"]:
                        sibling("manga_models").prepare(data)
                    ready()
                    return True
                try:
                    return lifecycle.serve(lambda job, control, prepared: generate(job, control, prepared, resident=resident),
                        input_stream=sys.stdin, stream=stream, emit=emit, error=Error, initialize=initialize,
                        cancel_cleanup=resident.clear, idle_cleanup=resident.offload_idle_images)
                finally:
                    resident.clear()
        return 0
    except Exception as exc:
        code = exc.code if isinstance(exc, lifecycle.WorkerError) else "MANGA_PROCESSING_FAILED"
        emit(stream, None, "error", code=code, message=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
