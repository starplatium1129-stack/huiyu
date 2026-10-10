"""Plan or explicitly run local Anima TeaCache calibration; never downloads or installs dependencies."""
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
path = Path(__file__).resolve().parents[2] / "tools/inference/teacache_calibration.py"
spec = importlib.util.spec_from_file_location("huiyu_teacache_calibration", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

if __name__ == "__main__":
    raise SystemExit(module.main())
