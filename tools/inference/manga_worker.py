"""Native MangaScreen with optional local Qwen/lineart stages; no ComfyUI."""
import argparse
import contextlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import sys


def sibling(name):
    spec = importlib.util.spec_from_file_location(f"huiyu_{name}", Path(__file__).with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


contract = sibling("manga_contract")
lifecycle = sibling("worker_lifecycle")
Error = contract.MangaError


def emit(stream, job_id, event, **values):
    stream.write(json.dumps({"id": job_id, "event": event, **values}, ensure_ascii=False) + "\n")
    stream.flush()


def dependencies():
    versions = {}
    for name, expected in contract.MANIFEST["dependencies"].items():
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


def read_image(path, background_color="white"):
    import numpy as np
    from PIL import Image, ImageOps
    m = contract.MANIFEST
    try:
        with Image.open(path) as source:
            if (source.format not in ("PNG", "JPEG", "WEBP") or getattr(source, "n_frames", 1) != 1
                    or min(source.size) < m["minInputSide"] or max(source.size) > m["maxInputSide"]
                    or source.width * source.height > m["maxInputPixels"]):
                raise Error("MANGA_INPUT_SIZE", "Use a still PNG/JPEG/WebP: sides 128–4096, at most 2097152 pixels; no implicit resize")
            # Apply EXIF once; transparent pixels use paper or the selected line-map background.
            with ImageOps.exif_transpose(source).convert("RGBA") as oriented:
                with Image.new("RGBA", oriented.size, background_color) as background:
                    background.alpha_composite(oriented)
                    with background.convert("RGB") as rgb:
                        return np.asarray(rgb).copy()
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise Error("INVALID_IMAGE", f"Cannot decode MangaScreen input: {exc}") from exc


def generate(job, control, _prepared):
    data = contract.validate(job)
    import cv2
    import numpy as np
    from PIL import Image
    line_only = data["operation"] == "lineart"
    core = None if line_only else sibling("manga_screen")
    control.stage("preparing_image")
    rgb = read_image(job["inputImagePath"])
    observation = {}
    models = None
    if data.get("rewrite") or data["autoLines"]:
        models = sibling("manga_models")
        control.stage("dependencies")
        if not _prepared:
            models.prepare(data)
    if data.get("rewrite"):
        rgb, observation["rewrite"] = models.rewrite(job, data, rgb, control, read_image)
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
        pen, observation["lineart"] = models.extract(rgb, job["lineartPath"], control)
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
        page = core.finish(rgb, p["screen_lines"], p["white_point"], p["black_point"],
                           p["light_tone"], p["dark_tone"], p["gradation"], pen,
                           p["pen_threshold"], p["white_lines"], control)
        rgb = np.repeat(page[..., None], 3, axis=2).astype(np.float32)
    if "panel" in data:
        control.stage("manga_panel")
        p = data["panel"]
        threshold = 127.5 if rgb.dtype == np.uint8 else 0.5
        ink = rgb.mean(-1) < threshold
        framed = core.cut_panel(ink, core.FRAMES[p["frame"]], p["crop_x"], p["crop_y"], round(p["border"] * k), round(p["margin"] * k))
        rgb = core.print_look(framed, p["paper"], p["ink"], k) / 255
    control.stage("saving")
    if not line_only:
        if not np.isfinite(rgb).all():
            raise Error("MANGA_OUTPUT_INVALID", "MangaScreen returned non-finite pixels")
        with Image.fromarray((rgb.clip(0, 1) * 255).round().astype(np.uint8)) as output:
            output.save(job["outputPath"], format="PNG")
    control.check()
    emit(control.stream, job["id"], "result", outputPath=job["outputPath"], nativeRuntime={
        "processor": "manga-screen", "sourceRevision": contract.MANIFEST["revision"],
        "device": "cuda+cpu" if data.get("rewrite") else "cpu", "validation": "待主力机验证",
        "generationVerified": False, **observation})


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
                emit(stream, None, "diagnostic", dependencies=dependencies(), scope="imports-only; no image processing", validation="待主力机验证")
            else:
                def initialize(job, ready):
                    data = contract.validate(job)
                    dependencies()
                    if data.get("rewrite") or data["autoLines"]:
                        sibling("manga_models").prepare(data)
                    ready()
                    return True
                return lifecycle.serve(generate, input_stream=sys.stdin, stream=stream, emit=emit, error=Error, initialize=initialize)
        return 0
    except Exception as exc:
        emit(stream, None, "error", code=getattr(exc, "code", "MANGA_PROCESSING_FAILED"), message=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
