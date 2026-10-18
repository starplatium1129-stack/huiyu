"""MangaScreen request/schema validation; importing this module never processes images."""
import json
import math
from pathlib import Path

MANIFEST = json.loads(Path(__file__).with_name("manga-screen.json").read_text(encoding="utf-8"))


class MangaError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def invalid(message):
    return MangaError("INVALID_MANGA_PARAMETER", message)


def parameters(data):
    if not isinstance(data, dict) or set(data) - {"operation", "levels", "finish", "panel", "rewrite", "autoLines", "penLinesPolarity", "penLinesFit"}:
        raise invalid("Only operation, rewrite, autoLines and active levels/finish/panel parameters are accepted")
    operation = data.get("operation", "lite")
    if not isinstance(operation, str) or operation not in MANIFEST["operations"]:
        raise invalid("Unknown MangaScreen operation")
    result = {"operation": operation}
    active = MANIFEST["operations"][operation]
    line_only = operation == "lineart"
    auto = data.get("autoLines", line_only)
    if line_only and auto is not True:
        raise invalid("lineart always extracts lines from the input image")
    if type(auto) is not bool or auto and not line_only and "finish" not in active:
        raise invalid("autoLines requires an operation containing finish")
    result["autoLines"] = auto
    for key, choices in {"penLinesPolarity": ("white-on-black", "black-on-white"), "penLinesFit": ("stretch", "exact")}.items():
        if key in data:
            if data[key] not in choices:
                raise invalid(f"Unsupported {key}")
            result[key] = data[key]
    rewrite = data.get("rewrite")
    if rewrite is not None:
        rules = MANIFEST["rewrite"]
        if (not isinstance(rewrite, dict) or set(rewrite) != {"modelId", "prompt", "width", "height", "seed"}
                or rewrite.get("modelId") not in rules["models"] or "finish" not in active or "levels" in active):
            raise invalid("Qwen rewrite requires comic/finish and modelId, prompt, width, height, seed")
        if not isinstance(rewrite["prompt"], str) or not rewrite["prompt"].strip() or len(rewrite["prompt"]) > 12000:
            raise invalid("Qwen prompt must be nonempty and at most 12000 characters")
        for key in ("width", "height"):
            value = rewrite[key]
            if type(value) is not int or not rules["minSize"] <= value <= rules["maxSize"] or value % rules["alignment"]:
                raise invalid("Qwen sides must be 512–2816 in multiples of 32")
        if rewrite["width"] * rewrite["height"] > MANIFEST["maxInputPixels"]:
            raise invalid("Qwen output must fit the MangaScreen 2097152 pixel budget")
        if type(rewrite["seed"]) is not int or not 0 <= rewrite["seed"] <= 2147483647:
            raise invalid("seed must be an integer in [0,2147483647]")
        result["rewrite"] = dict(rewrite)
    for group, schema in MANIFEST["parameters"].items():
        if group not in active:
            if group in data:
                raise invalid(f"{operation} does not use {group}")
            continue
        supplied = data.get(group, {})
        if not isinstance(supplied, dict) or set(supplied) - set(schema):
            raise invalid(f"Unknown {group} parameter")
        values = {}
        for key, rule in schema.items():
            value = supplied.get(key, rule["default"])
            if "choices" in rule:
                valid = isinstance(value, str) and value in rule["choices"]
            else:
                valid = (type(value) in (int, float) and math.isfinite(value)
                         and rule["min"] <= value <= rule["max"]
                         and (not rule.get("integer") or type(value) is int))
            if not valid:
                raise invalid(f"Invalid {group}.{key}")
            values[key] = value
        result[group] = values
    if "levels" in result and result["levels"]["white"] <= result["levels"]["black"]:
        raise invalid("levels.white must exceed levels.black")
    if "finish" in result:
        f = result["finish"]
        if f["white_point"] <= f["black_point"] or f["dark_tone"] < f["light_tone"]:
            raise invalid("finish requires white_point > black_point and dark_tone >= light_tone")
    return result


def validate(job):
    if (not isinstance(job, dict) or set(job) - {"id", "op", "input", "inputImagePath", "penLinesPath", "outputPath", "modelDir", "lineartPath", "lineartOutputPath"}
            or job.get("op") != "generate" or not isinstance(job.get("id"), str) or not job["id"]):
        raise invalid("Expected a MangaScreen job")
    result = parameters(job.get("input"))
    for key in ("inputImagePath", "penLinesPath", "outputPath"):
        value = job.get(key)
        if key == "penLinesPath" and value is None:
            continue
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise invalid(f"{key} must be a host-selected absolute path")
        if key != "outputPath" and not Path(value).is_file():
            raise invalid(f"Missing input file: {key}")
    if Path(job["outputPath"]).suffix != ".png" or Path(job["outputPath"]).exists():
        raise invalid("Expected a new PNG output path")
    if job.get("penLinesPath") and "finish" not in result:
        raise invalid("penLines requires finish, lite or comic")
    if job.get("penLinesPath") and (result["autoLines"] or result.get("rewrite")):
        raise invalid("External penLines cannot be combined with autoLines or Qwen redrawing")
    if not job.get("penLinesPath") and any(key in result for key in ("penLinesPolarity", "penLinesFit")):
        raise invalid("penLinesPolarity/penLinesFit require external penLines")
    has_lines = result["autoLines"] or bool(job.get("penLinesPath"))
    line_output = job.get("lineartOutputPath")
    if has_lines:
        expected = Path(job["outputPath"]) if result["operation"] == "lineart" else Path(job["outputPath"]).with_name("result-lineart.png")
        if (not isinstance(line_output, str) or not Path(line_output).is_absolute()
                or Path(line_output) != expected or Path(line_output).exists()):
            raise invalid("Expected the host-selected line output path for this operation")
    elif line_output is not None:
        raise invalid("lineartOutputPath requires automatic or external lines")
    for key, required in (("modelDir", bool(result.get("rewrite"))), ("lineartPath", result["autoLines"])):
        value = job.get(key)
        if required:
            if not isinstance(value, str) or not Path(value).is_absolute():
                raise invalid(f"{key} must be a host-selected local path")
        elif value is not None:
            raise invalid(f"{key} is unused by this request")
    return result
