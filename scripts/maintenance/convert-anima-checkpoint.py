"""Offline raw Anima conversion: plan by default, --check or explicit --apply.

Run with the prepared inference Python and -I. No packages or weights are fetched.
"""
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[2] / "tools/inference/anima_conversion.py"
spec = importlib.util.spec_from_file_location("huiyu_anima_conversion", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

if __name__ == "__main__":
    raise SystemExit(module.main())
