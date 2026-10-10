"""Bounded, offline TeaCache calibration and explicit quality/performance acceptance.

Default: read local job JSON, print a plan, no ML imports, subprocesses or writes.
--run: full-compute training traces, a fresh polynomial, then held-out baseline/cache
pairs. Pixel differences are not semantic, identity, anatomy or edit-quality verdicts.
Use the prepared inference Python; no packages or models are installed/downloaded.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import importlib.util
import json
import math
import os
from pathlib import Path
import signal
import statistics
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
LIMIT = 16 * 1024 * 1024
ALGORITHM = "huiyu-anima-first-norm-residual-v1"
DISCLAIMER = ("Pixel metrics measure numerical image differences only. Inspect every held-out pair for "
              "identity, composition, anatomy, texture and masked-edit boundaries. Neither these metrics "
              "nor synthetic tests establish semantic quality. Whole-image metrics may hide local edit regressions "
              "when preserved pixels dominate; review the edited region and edges directly. Timings include fresh process/model load "
              "and the cached path's required fingerprint overhead; uncached timing excludes preflight identity hashes. "
              "Preflight hashes may warm the operating-system file cache. Pipeline timings include encoding, "
              "denoising and decoding, not pure sampling. Skipped blocks are not wall-clock savings.")


def load(name):
    spec = importlib.util.spec_from_file_location("huiyu_calibration_" + name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read(path):
    with Path(path).open("rb") as stream:
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError(f"JSON exceeds {LIMIT} bytes: {path}")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def write(path, value):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write("\n")


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def jobs(paths):
    worker = load("worker")  # stdlib-only until generate() is called
    result = []
    for path in paths:
        job = read(path)
        try:
            data = worker.validate_job(job)
        except worker.WorkerError as exc:
            raise ValueError(str(exc)) from exc
        if data.get("teaCache") or data.get("teacache"):
            raise ValueError("Source jobs must have TeaCache disabled")
        data.pop("teaCache", None)
        data.pop("teacache", None)
        job["input"] = data
        if not isinstance(job.get("modelDir"), str) or not job["modelDir"]:
            raise ValueError("Every job must name an existing local modelDir")
        model = Path(job["modelDir"]).expanduser().resolve()
        if not model.is_dir():
            raise ValueError("Every job must name an existing local modelDir")
        job["modelDir"] = str(model)
        result.append(job)
    return result


def plan(args):
    if not args.calibration_job or not args.validation_job or not args.output_dir:
        raise ValueError("Provide --calibration-job, --validation-job and --output-dir")
    training, heldout = jobs(args.calibration_job), jobs(args.validation_job)
    target = Path(args.output_dir).expanduser().resolve()
    if target.exists():
        raise ValueError("--output-dir must be new; existing files are never reused or overwritten")
    if any(target.is_relative_to(Path(job["modelDir"])) for job in training + heldout):
        raise ValueError("Use an output directory outside the model directory")
    train_seeds = {job["input"]["seed"] for job in training}
    train_prompts = {job["input"]["prompt"].strip() for job in training}
    if any(job["input"]["seed"] in train_seeds for job in heldout):
        raise ValueError("Validation seeds must be held out from all calibration seeds")
    if any(job["input"]["prompt"].strip() in train_prompts for job in heldout):
        raise ValueError("Validation prompts must also be held out from all calibration prompts")
    if len(training) + len(heldout) > 32:
        raise ValueError("At most 32 total job files per bounded calibration run")
    def scope(job):
        return {key: value for key, value in job.items() if key not in ("id", "outputPath", "input", "inputImagePath", "maskImagePath")} | {
            "mode": "masked" if job.get("maskImagePath") or job["input"].get("maskPrompt") else ("img2img" if job.get("inputImagePath") else "txt2img"),
            "manualMask": bool(job.get("maskImagePath")),
            "input": {key: value for key, value in job["input"].items()
                      if key not in ("prompt", "negativePrompt", "seed")}}
    if any(scope(job) != scope(training[0]) for job in training + heldout):
        raise ValueError("Jobs must share one exact model/LoRA/sampler/shape/CFG/edit scope")
    return training, heldout, target, {
        "mode": "plan", "modelCalls": len(training) + len(heldout) * args.repeats * 2,
        "trainingJobs": len(training), "heldoutJobs": len(heldout), "repeats": args.repeats,
        "outputDir": str(target), "threshold": args.threshold, "polynomialDegree": args.degree,
        "scopeStatus": "Exact model/config hashes, dtype and device will be established by real worker traces",
        "installsProfile": False, "limitations": DISCLAIMER,
        "next": "Use --run only on the authorized CUDA device with the prepared inference Python."}


def input_files(all_jobs):
    return {str(Path(job[key]).resolve()): digest(Path(job[key])) for job in all_jobs
            for key in ("inputImagePath", "maskImagePath") if job.get(key)}


def verify_inputs(expected):
    if any(digest(Path(path)) != sha for path, sha in expected.items()):
        raise ValueError("Source image or mask changed during the run/review; rerun calibration")


def job_scope(job, profile):
    scope = profile["compatibility"]
    mode = "masked" if job.get("maskImagePath") or job["input"].get("maskPrompt") else ("img2img" if job.get("inputImagePath") else "txt2img")
    return load("teacache_profile").compatibility(Path(job["modelDir"]), job.get("loras", []), job["input"],
        mode, scope["dtype"], scope["deviceName"], mask_model_dir=job.get("maskModelDir"))


def stop(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def child(request_path):
    request = read(request_path)
    report = load("worker").generate(request["job"], sys.stdout,
                                    collect_teacache=request["collect"],
                                    teacache_profile=request.get("profile"),
                                    measure_teacache=not request["collect"] and request.get("profile") is None)
    write(Path(request_path).with_name("worker-report.json"), report or {})


def execute(job, folder, collect, profile, timeout):
    folder.mkdir()
    job = json.loads(json.dumps(job))
    job["outputPath"] = str(folder / "output.png")
    job["input"].pop("teacache", None)
    job["input"]["teaCache"] = profile is not None
    request = folder / "request.json"
    write(request, {"job": job, "collect": collect, "profile": profile})
    kwargs = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    start = time.perf_counter()
    with (folder / "stdout.jsonl").open("x") as out, (folder / "stderr.log").open("x") as err:
        process = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()),
                                    "--_worker-job", str(request)], stdout=out, stderr=err, **kwargs)
        try:
            code = process.wait(timeout=timeout)
        except BaseException:
            stop(process)
            raise
    seconds = time.perf_counter() - start
    if code != 0:
        raise ValueError(f"Worker failed ({code}); inspect {folder / 'stderr.log'}")
    output = folder / "output.png"
    if not output.is_file():
        raise ValueError("Worker did not create its requested PNG")
    report = read(folder / "worker-report.json")
    return {"wallSeconds": seconds, "output": str(output), "outputSha256": digest(output),
            "report": report}


def fit(traces, args):
    import numpy as np  # only --run, in the operator's prepared runtime
    compatibility = traces[0].get("compatibility")
    if not isinstance(compatibility, dict) or not compatibility:
        raise ValueError("Trace lacks an established compatibility scope")
    points = []
    for trace in traces:
        stats = trace.get("stats", {})
        if (trace.get("schemaVersion") != 1 or trace.get("compatibility") != compatibility or
                not positive(stats.get("fullComputes")) or stats.get("skippedComputes") != 0 or stats.get("nonfinite") != 0):
            raise ValueError("Require compatible, finite, full-compute worker traces")
        for sample in trace.get("samples", []):
            x, y = sample.get("proxyRelativeL1"), sample.get("residualRelativeL1")
            if x is None or y is None:
                continue
            if not all(type(v) in (int, float) and math.isfinite(v) and v >= 0 for v in (x, y)):
                raise ValueError("Trace has invalid relative-L1 samples")
            points.append((x, y))
    if len(points) < max(8, 2 * (args.degree + 1)):
        raise ValueError("Insufficient paired trace samples for a fresh polynomial")
    x, y = np.asarray(points, dtype=float).T
    coefficients, diagnostics = np.polynomial.polynomial.polyfit(x, y, args.degree, full=True)
    if diagnostics[1] != args.degree + 1 or not np.isfinite(coefficients).all():
        raise ValueError("Trace proxy variation is insufficient for a stable full-rank fit")
    error = np.maximum(0, np.polynomial.polynomial.polyval(x, coefficients)) - y
    return {"schemaVersion": 1, "algorithm": ALGORITHM,
            "runtime": {"diffusers": "0.41.0", "torch": "2.8.0"},
            "compatibility": compatibility, "coefficients": coefficients.tolist(),
            "proxyRange": [float(x.min()), float(x.max())], "defaultThreshold": args.threshold,
            "maxThreshold": args.threshold, "maxConsecutiveSkips": 1,
            "calibration": {"source": "local-full-compute", "sampleCount": len(points),
                            "traceSha256": canonical(traces)},
            "fitDiagnostics": {"trainingRmse": float(np.sqrt(np.mean(error ** 2))),
                               "trainingMaxAbsoluteError": float(np.max(np.abs(error)))}}


def pixels(left, right):
    import numpy as np
    from PIL import Image
    with Image.open(left) as a, Image.open(right) as b:
        if a.format != "PNG" or b.format != "PNG" or a.size != b.size:
            raise ValueError("Held-out outputs must be equal-size PNG images")
        delta = (np.asarray(a.convert("RGB"), dtype=float) - np.asarray(b.convert("RGB"), dtype=float)) / 255
    mse = float(np.mean(delta ** 2))
    return {"maeRgb01": float(np.mean(np.abs(delta))), "rmseRgb01": math.sqrt(mse),
            "maxAbsoluteRgb01": float(np.max(np.abs(delta))),
            "psnrDb": -10 * math.log10(mse) if mse else None, "identicalPixels": mse == 0,
            "qualityVerdict": "requires-human-review"}


def review_html(target, report):
    rows = []
    for pair in report["pairs"]:
        images = "".join(f'<figure><figcaption>{name}</figcaption><img width="384" src="{html.escape(pair[name]["output"], quote=True)}"></figure>'
                         for name in ("baseline", "cached"))
        rows.append(f'<section><h2>Held-out pair {pair["index"]}, seed {pair["seed"]}</h2><p>{html.escape(pair["prompt"])}</p><div>{images}</div><pre>'
                    + html.escape(json.dumps({"pixels": pair["pixels"], "cacheStats": pair["cached"]["report"]["stats"],
                                               "baselineWallSeconds": pair["baseline"]["wallSeconds"],
                                               "cachedWallSeconds": pair["cached"]["wallSeconds"],
                                               "baselineMeasurements": pair["baseline"]["report"],
                                               "cachedMeasurements": {key: value for key, value in pair["cached"]["report"].items() if key not in ("samples", "compatibility")}}, indent=2)) + '</pre></section>')
    (target / "review.html").write_text('<!doctype html><meta charset="utf-8"><title>Anima TeaCache review</title>'
        '<style>body{font:16px system-ui;max-width:1100px;margin:2em auto;background:#fafafa;color:#222}div{display:flex;flex-wrap:wrap}figure{margin:8px}img{max-width:100%}pre{white-space:pre-wrap}</style>'
        '<h1>Anima TeaCache: candidate awaiting acceptance</h1><p>' + html.escape(DISCLAIMER) + '</p>'
        '<p>Model/config/LoRA/job scope is recorded in candidate-profile.json. No profile has been installed.</p>'
        + f'<p>Median wall: baseline {report["medianBaselineWallSeconds"]:.3f}s; cache {report["medianCachedWallSeconds"]:.3f}s. Observed end-to-end ratio: {report["observedEndToEndSpeedup"]:.3f}x. No automatic quality approval.</p>'
        + ''.join(rows), encoding="utf-8")


def run(args, training, heldout, target):
    target.mkdir(parents=True)
    sources = input_files(training + heldout)
    write(target / "source-jobs.json", {"training": training, "heldout": heldout, "inputFiles": sources})
    def measured(job, folder, collect, profile, expected=None):
        verify_inputs(sources)
        if expected is not None and profile is None and job_scope(job, expected) != expected["compatibility"]:
            raise ValueError("Baseline model/LoRA scope changed before generation")
        result = execute(job, folder, collect, profile, args.timeout)
        verify_inputs(sources)
        if expected is not None and profile is None:
            result["identityScope"] = job_scope(job, expected)
            result["identityCheckOutsideWall"] = True
            if result["identityScope"] != expected["compatibility"]:
                raise ValueError("Baseline model/LoRA scope changed during generation")
        return result
    traces = [measured(job, target / f"training-{index}", True, None)["report"]
              for index, job in enumerate(training)]
    write(target / "traces.json", {"traces": traces})
    profile = fit(traces, args)
    load("teacache_profile").validate_profile(profile, profile["compatibility"], require_accepted=False)
    write(target / "candidate-profile.json", profile)
    pairs = []
    for index, job in enumerate(heldout * args.repeats):
        pair = {"index": index, "seed": job["input"]["seed"], "prompt": job["input"]["prompt"]}
        order = ("baseline", "cached") if index % 2 == 0 else ("cached", "baseline")
        for name in order:
            result = measured(job, target / f"heldout-{index}-{name}", False,
                              profile if name == "cached" else None, expected=profile)
            result["output"] = Path(result["output"]).relative_to(target).as_posix()
            pair[name] = result
        cached = pair["cached"]["report"]
        if cached.get("compatibility") != profile["compatibility"] or cached.get("stats", {}).get("nonfinite") != 0:
            raise ValueError("Held-out cached execution lacks matching finite runtime evidence")
        if (pair["baseline"]["report"].get("teaCacheEnabled") is not False or
                pair["baseline"].get("identityScope") != profile["compatibility"] or
                pair["baseline"]["report"].get("fingerprintSeconds") != 0):
            raise ValueError("Held-out baseline lacks explicit disabled-cache worker evidence")
        pair["pixels"] = pixels(target / pair["baseline"]["output"], target / pair["cached"]["output"])
        pairs.append(pair)
    baseline = statistics.median(pair["baseline"]["wallSeconds"] for pair in pairs)
    cached = statistics.median(pair["cached"]["wallSeconds"] for pair in pairs)
    report = {"schemaVersion": 1, "status": "awaiting-operator-acceptance", "pairs": pairs,
              "medianBaselineWallSeconds": baseline, "medianCachedWallSeconds": cached,
              "observedEndToEndSpeedup": baseline / cached, "humanQualityAccepted": False,
              "candidateSha256": digest(target / "candidate-profile.json"),
              "sourceJobsSha256": digest(target / "source-jobs.json"),
              "tracesSha256": digest(target / "traces.json"), "limitations": DISCLAIMER}
    write(target / "report.json", report)
    review_html(target, report)
    return {"mode": "run", "status": report["status"], "report": str(target / "report.json"),
            "review": str(target / "review.html"), "installed": False,
            "observedEndToEndSpeedup": report["observedEndToEndSpeedup"]}


def accept(args):
    if not args.accept_quality or not args.accept_performance:
        raise ValueError("Review held-out images and timings; explicitly provide --accept-quality and --accept-performance")
    target = Path(args.accept_run).expanduser().resolve()
    report, profile = read(target / "report.json"), read(target / "candidate-profile.json")
    if report.get("status") != "awaiting-operator-acceptance" or not report.get("pairs"):
        raise ValueError("Run is incomplete; no profile can be accepted")
    for name, key in (("candidate-profile.json", "candidateSha256"), ("source-jobs.json", "sourceJobsSha256"), ("traces.json", "tracesSha256")):
        if digest(target / name) != report.get(key):
            raise ValueError(f"Run artifact changed: {name}")
    traces = read(target / "traces.json")["traces"]
    if canonical(traces) != profile.get("calibration", {}).get("traceSha256"):
        raise ValueError("Candidate is not bound to its collected traces")
    for pair in report["pairs"]:
        cached_report = pair["cached"].get("report", {})
        if (cached_report.get("compatibility") != profile["compatibility"] or
                pair["baseline"].get("identityScope") != profile["compatibility"] or
                pair["baseline"].get("report", {}).get("fingerprintSeconds") != 0 or
                pair["baseline"].get("report", {}).get("teaCacheEnabled") is not False):
            raise ValueError("Held-out baseline/cache scope evidence changed")
        stats = cached_report.get("stats", {})
        if not positive(stats.get("skippedComputes")) or stats.get("nonfinite") != 0:
            raise ValueError("Every held-out run must demonstrate finite actual cache skips")
        for name in ("baseline", "cached"):
            item = pair[name]
            path = (target / item["output"]).resolve()
            if not path.is_relative_to(target) or digest(path) != item["outputSha256"] or not positive(item["wallSeconds"]):
                raise ValueError("Held-out image/timing evidence is missing or changed")
    speedup = statistics.median(pair["baseline"]["wallSeconds"] for pair in report["pairs"]) / statistics.median(pair["cached"]["wallSeconds"] for pair in report["pairs"])
    if speedup <= 1:
        raise ValueError("No measured end-to-end speedup; adjust/recalibrate rather than install")
    sources = read(target / "source-jobs.json")
    verify_inputs(sources["inputFiles"])
    source = sources["training"][0]
    helper = load("teacache_profile")
    current = job_scope(source, profile)
    helper.validate_profile(profile, current, require_accepted=False)
    destination = Path(source["modelDir"]) / "teacache-profile.json"
    if destination.is_symlink():
        raise ValueError("Refusing to replace a symbolic-link profile")
    replacing = destination.exists()
    if replacing and (not args.replace_profile_sha256 or digest(destination) != args.replace_profile_sha256):
        raise ValueError("Existing profile preserved; replacement requires its exact --replace-profile-sha256")
    if not replacing and args.replace_profile_sha256:
        raise ValueError("Expected replacement profile is missing")
    profile["acceptance"] = {"status": "accepted", "operatorQualityAccepted": True, "operatorPerformanceAccepted": True,
                             "reportSha256": digest(target / "report.json"),
                             "acceptedAtUnix": time.time(), "scope": "only the recorded device/model/job configuration"}
    helper.validate_profile(profile, current)
    if not replacing:
        write(destination, profile)
    else:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination.parent,
                                         prefix=".teacache-", suffix=".json", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(profile, stream, indent=2, allow_nan=False)
        try:
            if digest(destination) != args.replace_profile_sha256:
                raise ValueError("Existing profile changed during acceptance")
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
    return {"mode": "accept", "installedProfile": str(destination), "sha256": digest(destination),
            "teaCacheDefaultEnabled": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration-job", action="append", help="Local worker JSON, repeatable; never modified")
    parser.add_argument("--validation-job", action="append", help="Same scope, prompts and seeds absent from calibration jobs")
    parser.add_argument("--output-dir", help="New output directory outside model directory")
    parser.add_argument("--threshold", type=float, default=0.05, help="Candidate threshold only, not a universal quality recommendation")
    parser.add_argument("--degree", type=int, choices=range(1, 6), default=2)
    parser.add_argument("--repeats", type=int, default=1, help="Held-out repetitions; use >=2 to alternate pair order")
    parser.add_argument("--timeout", type=float, default=1800, help="Maximum seconds per worker process")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--run", action="store_true", help="Explicitly authorize model execution on this device")
    mode.add_argument("--accept-run", metavar="RUN_DIR", help="Install a completed reviewed candidate; no model execution")
    parser.add_argument("--accept-quality", action="store_true", help="Operator personally reviewed held-out image quality")
    parser.add_argument("--accept-performance", action="store_true", help="Operator accepts measured end-to-end timings")
    parser.add_argument("--replace-profile-sha256", help="Explicit expected digest of an existing profile to replace")
    parser.add_argument("--_worker-job", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        if args._worker_job:
            child(args._worker_job)
            return 0
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        if args.accept_run:
            result = accept(args)
        else:
            if args.accept_quality or args.accept_performance or args.replace_profile_sha256:
                raise ValueError("Acceptance options require --accept-run")
            if not math.isfinite(args.threshold) or not 0.01 <= args.threshold <= 1 or not 1 <= args.repeats <= 10 or not positive(args.timeout):
                raise ValueError("Require threshold 0.01..1, repeats 1..10 and positive finite timeout")
            training, heldout, target, result = plan(args)
            if args.run:
                result = run(args, training, heldout, target)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except KeyboardInterrupt:
        print(json.dumps({"status": "cancelled", "installed": False}), file=sys.stderr)
        return 130
    except (OSError, ValueError, KeyError, ImportError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc), "installed": False}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
