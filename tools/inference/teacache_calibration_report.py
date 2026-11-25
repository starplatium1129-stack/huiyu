"""Fitting, pixel diff metrics, review HTML and acceptance helpers for TeaCache calibration."""
from __future__ import annotations

import html
import json
import math
from pathlib import Path
import statistics
import time


def fit(traces, args, *, load, canonical, positive, algorithm):
    import numpy as np  # only --run, in the operator's prepared runtime
    helper = load("teacache_profile")
    compatibility = traces[0].get("compatibility")
    if not isinstance(compatibility, dict) or not compatibility:
        raise ValueError("Trace lacks an established compatibility scope")
    local_tools = load("anima_local_cache")
    points, phase_points, local_points = [], [[], [], []], [[], [], []]
    for trace in traces:
        stats = trace.get("stats", {})
        if (trace.get("schemaVersion") != 1 or trace.get("runtime") != helper.RUNTIME or trace.get("compatibility") != compatibility or
                not positive(stats.get("fullComputes")) or stats.get("skippedComputes") != 0 or stats.get("nonfinite") != 0):
            raise ValueError("Require compatible runtime, finite, full-compute worker traces; recollect and recalibrate")
        if args.strategy == "local-guard" and trace.get("collectionMetric") != local_tools.METRIC:
            raise ValueError("Local calibration requires traces from the exact local metric collector")
        for sample in trace.get("samples", []):
            x, y = sample.get("proxyRelativeL1"), sample.get("residualRelativeL1")
            if x is None or y is None:
                continue
            if not all(type(v) in (int, float) and math.isfinite(v) and v >= 0 for v in (x, y)):
                raise ValueError("Trace has invalid relative-L1 samples")
            points.append((x, y))
            if args.strategy in ("phase-envelope", "local-guard"):
                step, total = sample.get("step"), sample.get("total")
                if type(step) is not int or type(total) is not int or not 0 <= step < total or total < 2:
                    raise ValueError("Phase calibration requires actual step/total trace identity")
                phase = min(2, 3 * step // (total - 1))
                phase_points[phase].append((x, y))
                if args.strategy == "local-guard":
                    local_pair = (sample.get("localProxyRelativeL1"), sample.get("localResidualRelativeL1"))
                    if not all(type(v) in (int, float) and math.isfinite(v) and v >= 0 for v in local_pair):
                        raise ValueError("Local calibration requires paired finite proxy/residual local observations")
                    local_points[phase].append(local_pair)
    if args.strategy in ("phase-envelope", "local-guard"):
        profile = {"schemaVersion": 2, "algorithm": helper.PHASE_ALGORITHM, "runtime": helper.RUNTIME,
                "compatibility": compatibility, "phaseEnvelopes": local_tools.envelopes(phase_points),
                "defaultThreshold": args.threshold, "maxThreshold": args.threshold, "maxConsecutiveSkips": args.max_consecutive_skips,
                "calibration": {"source": "local-full-compute", "sampleCount": len(points), "traceSha256": canonical(traces)},
                "fitDiagnostics": {"method": "phase-local observed upper envelope; not a semantic error bound",
                                   "phaseSampleCounts": [len(group) for group in phase_points]}}
        if args.strategy == "local-guard":
            profile.update(schemaVersion=3, algorithm=helper.LOCAL_ALGORITHM,
                localMetric=local_tools.METRIC, maxGroups=local_tools.MAX_GROUPS,
                localThreshold=args.local_threshold or args.threshold, localPhaseEnvelopes=local_tools.envelopes(local_points))
            profile["fitDiagnostics"].update(method="dual global/local empirical phase envelopes; not a semantic bound",
                localPhaseSampleCounts=[len(group) for group in local_points])
        return profile
    if len(points) < max(8, 2 * (args.degree + 1)):
        raise ValueError("Insufficient paired trace samples for a fresh polynomial")
    x, y = np.asarray(points, dtype=float).T
    coefficients, diagnostics = np.polynomial.polynomial.polyfit(x, y, args.degree, full=True)
    if diagnostics[1] != args.degree + 1 or not np.isfinite(coefficients).all():
        raise ValueError("Trace proxy variation is insufficient for a stable full-rank fit")
    error = np.maximum(0, np.polynomial.polynomial.polyval(x, coefficients)) - y
    return {"schemaVersion": 1, "algorithm": algorithm,
            "runtime": helper.RUNTIME,
            "compatibility": compatibility, "coefficients": coefficients.tolist(),
            "proxyRange": [float(x.min()), float(x.max())], "defaultThreshold": args.threshold,
            "maxThreshold": args.threshold, "maxConsecutiveSkips": args.max_consecutive_skips,
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


def review_html(target, report, *, disclaimer):
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
        '<h1>Anima TeaCache: candidate awaiting acceptance</h1><p>' + html.escape(disclaimer) + '</p>'
        '<p>Model/config/LoRA/job scope is recorded in candidate-profile.json. No profile has been installed.</p>'
        + f'<p>Median wall: baseline {report["medianBaselineWallSeconds"]:.3f}s; cache {report["medianCachedWallSeconds"]:.3f}s. Observed end-to-end ratio: {report["observedEndToEndSpeedup"]:.3f}x. No automatic quality approval.</p>'
        + ''.join(rows), encoding="utf-8")


def accept(args, *, load, read, digest, canonical, positive, verify_inputs, job_scope):
    if not args.accept_quality or not args.accept_performance:
        raise ValueError("Review held-out images and timings; explicitly provide --accept-quality and --accept-performance")
    target = Path(args.accept_run).expanduser().resolve()
    report, profile = read(target / "report.json"), read(target / "candidate-profile.json")
    helper = load("teacache_profile")
    if report.get("status") != "awaiting-operator-acceptance" or not report.get("pairs"):
        raise ValueError("Run is incomplete; no profile can be accepted")
    for name, key in (("candidate-profile.json", "candidateSha256"), ("source-jobs.json", "sourceJobsSha256"), ("traces.json", "tracesSha256")):
        if digest(target / name) != report.get(key):
            raise ValueError(f"Run artifact changed: {name}")
    traces = read(target / "traces.json")["traces"]
    if canonical(traces) != profile.get("calibration", {}).get("traceSha256"):
        raise ValueError("Candidate is not bound to its collected traces")
    if any(trace.get("runtime") != helper.RUNTIME for trace in traces):
        raise ValueError("Trace runtime mismatch; recollect and recalibrate")
    for pair in report["pairs"]:
        cached_report = pair["cached"].get("report", {})
        load("anima_local_cache").verify_execution(cached_report, profile)
        if any(pair[name].get("report", {}).get("runtime") != helper.RUNTIME for name in ("baseline", "cached")):
            raise ValueError("Held-out runtime mismatch; recollect and recalibrate")
        if report.get("executionMode") == "resident" and any(pair[name].get("report", {}).get("modelReused") is not True for name in ("baseline", "cached")):
            raise ValueError("Warm comparison lost its weight-reuse evidence")
        if report.get("executionMode") == "resident" and any(pair[name].get("report", {}).get("textCacheEnabled") is not False for name in ("baseline", "cached")):
            raise ValueError("TeaCache comparison lost its disabled text-cache evidence")
        if any(pair[name].get("report", {}).get("maskCacheEnabled") is not False for name in ("baseline", "cached")):
            raise ValueError("TeaCache comparison lost its disabled mask-cache evidence")
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
    current = job_scope(source, profile)
    helper.validate_profile(profile, current, require_accepted=False)
    profile["acceptance"] = {"status": "accepted", "operatorQualityAccepted": True, "operatorPerformanceAccepted": True,
                             "reportSha256": digest(target / "report.json"),
                             "acceptedAtUnix": time.time(), "scope": "only the recorded device/model/job configuration"}
    helper.validate_profile(profile, current)
    destination, installed_digest = helper.install_profile(source["modelDir"], profile, args.replace_profile_sha256)
    return {"mode": "accept", "installedProfile": str(destination), "sha256": installed_digest,
            "teaCacheDefaultEnabled": False}
