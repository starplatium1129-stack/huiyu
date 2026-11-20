#!/usr/bin/env bash
# Hatch consumer hook. Independent workers run the same script with slots 1, 2, 3.
set -euo pipefail
exec bash "$HOME/workspace/bridge-tools/bridge_consume.sh" desktop "${1:-${MUSE_WORKER_SLOT:-1}}"
