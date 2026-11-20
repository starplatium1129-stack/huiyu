#!/usr/bin/env python3
"""Send one qq payload through the saved relay connector."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / "workspace/bridge-tools"))
from bridge_delivery import ship_cli

if __name__ == "__main__":
    ship_cli("qq", Path(__file__).resolve().parent)
