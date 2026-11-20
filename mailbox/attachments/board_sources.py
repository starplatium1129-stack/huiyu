"""Local observations for the bridge dashboard. No network or queue mutations."""
import json
import os
import re
import sqlite3
from collections import Counter
from contextlib import closing
from pathlib import Path

from bridge_delivery import read_delivery
from bridge_dispatch import MANAGED


CONFIRMATIONS = {
    ("qq", "reply", "sent"), ("qq", "reply", "skipped"),
    ("qq", "send", "sent"), ("desktop", "reply", "accepted"),
}


def live_workers(bridge, now_ms):
    """None means this dispatcher could not be observed; an empty set is observed idle."""
    uri = (bridge / "dispatch-v1.sqlite3").absolute().as_uri() + "?mode=ro"
    try:
        with closing(sqlite3.connect(uri, uri=True, timeout=0)) as db:
            keys = set()
            for (raw,) in db.execute(
                "SELECT started_json FROM slots WHERE phase = 'working' AND until_ms > ?", (now_ms,)
            ):
                started = json.loads(raw)
                if not isinstance(started, list) or not all(isinstance(key, str) for key in started):
                    return None
                keys.update(started)
            return keys
    except (sqlite3.Error, TypeError, ValueError):
        return None


def gateway_code(code):
    # Never pass request contents, exception text or a transport status on as a gateway code.
    return code if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{1,95}", code) else None


def legacy_attempts(bridge):
    """Old attempts.jsonl was written *after* HTTP. Its timestamps cannot date POST start."""
    by_key = {}
    try:
        fh = (bridge / "attempts.jsonl").open("rb")
    except FileNotFoundError:
        return by_key
    with fh:
        for line in fh:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if (not isinstance(row, dict) or not isinstance(row.get("key"), str)
                    or not isinstance(row.get("status"), str)):
                continue
            key, status = row["key"], row.get("status")
            if status in ("uncertain_hold", "delivery_unknown", "attempts_exhausted"):
                phase = "uncertain"
            elif status == "expired":
                phase = "expired"
            elif row.get("posted") is True:
                category = row.get("cls")
                if not isinstance(category, str):
                    category = ""
                phase = {"retryable": "retry", "uncertain": "uncertain", "terminal": "expired",
                         "dead": "rejected", "success": "marked_done"}.get(category, "uncertain")
            else:
                continue  # Gate/backoff entries are not new attempts.
            prior = by_key.get(key, {})
            maybe_sent = bool(row.get("maybe_sent")) or prior.get("maybeSent", False)
            if phase == "expired" and maybe_sent:
                phase = "uncertain"
            code = prior.get("code")
            if row.get("posted") is True:
                code = gateway_code(row.get("code")) or gateway_code(status)
            by_key[key] = {"phase": phase, "code": code, "maybeSent": maybe_sent}
    return by_key


def observe_rows(rows, bridge, now_ms):
    """Read each legacy ledger once. Current per-key state is authoritative for its route."""
    bridge = Path(bridge)
    working = live_workers(bridge, now_ms)
    attempts = legacy_attempts(bridge)
    duplicates = Counter(row["requestKey"] for row in rows)
    for row in rows:
        key, via = row["requestKey"], row["via"]
        stages = row["stages"]
        if via == "reply":
            active = None if working is None else key in working
            try:
                with (bridge / "claimed" / (key + ".claim")).open("rb") as claim:
                    stages["claimed"] = os.fstat(claim.fileno()).st_mtime_ns // 1_000_000
                    if active is False and row["status"] == "waiting_reply" and claim.read(len(MANAGED) + 1) != MANAGED:
                        active = None  # Before lease migration a claim may still belong to an old worker.
            except FileNotFoundError:
                pass
            row["workerActive"] = active

        try:
            record = read_delivery(bridge, key)
        except (OSError, ValueError, TypeError):
            # A damaged record is a blind spot on this row, not an idle sender.
            record = {"phase": "unknown", "via": via}
        legacy = record is None
        if record and record.get("via") != via:
            record = None
        elif record is None and duplicates[key] == 1:
            # Old files do not identify reply vs proactive send; ambiguous keys stay unknown.
            record = attempts.get(key)
        row["senderPhase"] = record.get("phase") if record else None
        row["lastErrorCode"] = None
        if not record:
            continue
        first_post = record.get("firstPostAt")
        if type(first_post) is int and first_post > 0:
            stages["firstPost"] = first_post
        if (row["senderPhase"] != "posting" and (legacy or type(record.get("httpStatus")) is int)
                and record.get("code") not in ("INTERRUPTED_POST", "LEGACY_DELIVERY", "LEGACY_UNTRACKED")):
            row["lastErrorCode"] = gateway_code(record.get("code"))
        receipt = record.get("receipt")
        if (isinstance(receipt, dict) and receipt.get("via") == via and receipt.get("key") == key
                and (row["channel"], via, receipt.get("status")) in CONFIRMATIONS):
            row["receipt"] = {name: receipt[name] for name in ("via", "status", "at") if name in receipt}
            row["status"] = "skipped" if receipt["status"] == "skipped" else "confirmed"
            if type(receipt.get("at")) is int and receipt["at"] > 0:
                stages["confirmed"] = receipt["at"]
        elif row["receipt"] is None and row["senderPhase"] == "fallback":
            row["status"] = "fallback"
            if type(record.get("at")) is int and record["at"] > 0:
                stages["fallback"] = record["at"]
        elif row["receipt"] is None and row["senderPhase"] == "expired" and row["status"] == "waiting_send":
            row["status"] = "expired"
