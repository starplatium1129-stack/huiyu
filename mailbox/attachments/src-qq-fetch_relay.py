#!/usr/bin/env python3
"""Fetch one JSON document from the main-machine Huiyu relay and print it.

Usage: fetch_relay.py <api-path>
Prints the response JSON on stdout. Exits 1 on transport error or HTTP >= 400
so the caller can treat the fetch as failed.
"""
import importlib.util
import json
import sys

CLIENT = "/home/hatch/workspace/custom-connectors/custom.huiyu-relay-main/bin/client.py"


def load_client():
    spec = importlib.util.spec_from_file_location("huiyu_relay_main", CLIENT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    path = sys.argv[1]
    mod = load_client()
    try:
        status, out = mod.call_json("GET", path, timeout=45)
    except Exception as exc:  # transport failure
        print(f"fetch_error:{type(exc).__name__}", file=sys.stderr)
        return 1
    if status >= 400 or not isinstance(out, dict):
        print(f"fetch_error:http_{status}", file=sys.stderr)
        return 1
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
