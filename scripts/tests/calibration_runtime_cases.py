"""Synthetic runtime-contract case, executed by the existing calibration test entry."""
import json
from pathlib import Path
import tempfile


def check_runtime_revision(case, fixture, module):
    with tempfile.TemporaryDirectory() as directory:
        args = fixture(Path(directory))
        with case.assertRaisesRegex(ValueError, "runtime.*recalibrate"):
            case.make_run(args, legacy_runtime=True)
        case.assertFalse((Path(args.output_dir) / "report.json").exists())
    with tempfile.TemporaryDirectory() as directory:
        args = fixture(Path(directory))
        case.make_run(args)
        target = Path(args.output_dir)
        traces = module.read(target / "traces.json")
        traces["traces"][0].pop("runtime")
        (target / "traces.json").write_text(json.dumps(traces))
        candidate = module.read(target / "candidate-profile.json")
        candidate["calibration"]["traceSha256"] = module.canonical(traces["traces"])
        (target / "candidate-profile.json").write_text(json.dumps(candidate))
        report = module.read(target / "report.json")
        report.update(tracesSha256=module.digest(target / "traces.json"),
                      candidateSha256=module.digest(target / "candidate-profile.json"))
        (target / "report.json").write_text(json.dumps(report))
        with case.assertRaisesRegex(ValueError, "runtime.*recalibrate"):
            module.accept(args)
        case.assertFalse((Path(directory) / "model/teacache-profile.json").exists())
