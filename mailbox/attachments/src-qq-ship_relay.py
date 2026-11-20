#!/usr/bin/env python3
"""Ship one QQ-bridge payload file through the main-machine Huiyu relay.

Usage: ship_relay.py <api-path> <payload.json>
Mirrors ship.py: a payload "imagePath" is read, size-checked (<= 3145728
bytes) and base64-encoded into {"mimeType": ..., "data": ...} before posting.
A payload "audioPath" (MP3 only) is converted the same way into "audio"
(mimeType audio/mpeg). Image and audio are mutually exclusive per the
gateway protocol; a payload carrying both is rejected.
Prints the response JSON's "status" field (or "http_error"/"bad_response")
on stdout.

Retry discipline (Codex, 2026-11-20) lives inside this script so every
caller inherits it: per requestKey at most 5 POSTs total (1 + 4 retries)
with 2/5/10/20s backoff (+ jitter, floored by any Retry-After the gateway
mirrors in the response body); replies are only retried before the
original message's expiresAt; QQ_MUSE_SEND_UNCERTAIN stops all automatic
sending for the key pending manual review; non-transient rejections are
terminal; exhausting the attempts after a transport failure marks the
key delivery_unknown (the original requestKey is kept, never resent
under a new one). Attempts are recorded in attempts.jsonl next to this
script. The ledger is advisory only: any ledger problem fails open and
the POST proceeds exactly as before.
"""
import base64
import importlib.util
import json
import os
import random
import sys
import time

CLIENT = "/home/hatch/workspace/custom-connectors/custom.huiyu-relay-main/bin/client.py"
MAX_IMAGE_BYTES = 3145728
MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER = os.path.join(BRIDGE_DIR, "attempts.jsonl")
INBOX_DIR = os.path.join(BRIDGE_DIR, "inbox")
MAX_ATTEMPTS = 5  # 1 initial send + up to 4 retries, per requestKey
BACKOFF_S = (2, 5, 10, 20)  # wait after attempt 1..4, plus jitter
SUCCESS_STATUSES = {"sent", "skipped", "accepted"}
PENDING_STATUS = "QQ_MUSE_SEND_PENDING"
UNCERTAIN_STATUS = "QQ_MUSE_SEND_UNCERTAIN"


def _now_ms():
    return int(time.time() * 1000)


def _ledger_rows(key):
    """All ledger rows for key. Fail-open: any problem -> []."""
    rows = []
    try:
        with open(LEDGER, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                if isinstance(row, dict) and row.get("key") == key:
                    rows.append(row)
    except Exception:
        return []
    return rows


def _ledger_add(key, status, posted, cls=None, note=None, retry_after_ms=None,
                maybe_sent=False):
    """Append one ledger row {key, at, status, ...}. Fail-open."""
    try:
        row = {"key": key, "at": _now_ms(), "status": status,
               "posted": bool(posted)}
        if cls:
            row["cls"] = cls
        if note:
            row["note"] = note
        if retry_after_ms:
            row["retry_after_ms"] = int(retry_after_ms)
        if maybe_sent:
            row["maybe_sent"] = True
        with open(LEDGER, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _retry_after_ms(out):
    """Retry-After mirrored in a JSON body, if the gateway provides one.

    call_json does not expose HTTP headers, so a header-only Retry-After
    is invisible here; body fields are the only channel available.
    """
    if not isinstance(out, dict):
        return None
    for name in ("retryAfterMs", "retry_after_ms"):
        value = out.get(name)
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
    for name in ("retryAfterSeconds", "retry_after_seconds",
                 "retryAfter", "retry_after"):
        value = out.get(name)
        if isinstance(value, (int, float)) and value > 0:
            return int(value * 1000)
    return None


def _expires_at_ms(key):
    """expiresAt from inbox/<key>.json, or None. Fail-open."""
    try:
        with open(os.path.join(INBOX_DIR, key + ".json"), "r",
                  encoding="utf-8") as fh:
            item = json.load(fh)
        exp = item.get("expiresAt")
        if isinstance(exp, (int, float)) and exp > 0:
            return int(exp)
    except Exception:
        pass
    return None


def _gate(path, key, is_skip):
    """Return a status string to print INSTEAD of POSTing, or None to POST.

    Any ledger problem fails open (returns None). For skip payloads the
    QQ callers treat any status other than "http_error*"/"ship_error" as
    handled, so a suppressed skip prints the pre-existing "ship_error"
    (caller leaves the file for a later round) and the true gate reason
    is recorded in the ledger.
    """
    def masked(status):
        return "ship_error" if is_skip else status

    try:
        rows = _ledger_rows(key)
        posted = [r for r in rows if r.get("posted")]
        # UNCERTAIN is sticky: no more automatic sending for this key.
        if any(r.get("cls") == "uncertain" or r.get("status") == "uncertain_hold"
               for r in rows):
            _ledger_add(key, "uncertain_hold", False,
                        note="gate: uncertain, awaiting manual check")
            return masked("uncertain_hold")
        # Terminal outcomes are replayed from the ledger, never re-POSTed.
        for row in reversed(posted):
            if row.get("cls") in ("success", "terminal", "dead"):
                _ledger_add(key, str(row.get("status")), False,
                            note="gate: terminal replay")
                return str(row.get("status"))
        # Replies are only retried inside the original message window.
        if path.endswith("/reply"):
            exp = _expires_at_ms(key)
            if exp is not None and _now_ms() > exp:
                _ledger_add(key, "expired", False,
                            note="gate: past original expiresAt")
                return masked("expired")
        if len(posted) >= MAX_ATTEMPTS:
            if (any(r.get("maybe_sent") for r in posted)
                    and not any(r.get("status") == "delivery_unknown"
                                for r in rows)):
                _ledger_add(key, "delivery_unknown", False,
                            note="attempts exhausted after transport "
                                 "failure(s); original requestKey kept, "
                                 "never resend under a new key")
            _ledger_add(key, "attempts_exhausted", False,
                        note="gate: attempt cap reached")
            return masked("attempts_exhausted")
        if posted:
            last = posted[-1]
            idx = min(len(posted), len(BACKOFF_S)) - 1
            wait_ms = int((BACKOFF_S[idx] + random.uniform(0, 0.3)) * 1000)
            retry_after = last.get("retry_after_ms")
            if isinstance(retry_after, (int, float)) and retry_after > wait_ms:
                wait_ms = int(retry_after)
            if _now_ms() - int(last.get("at", 0)) < wait_ms:
                _ledger_add(key, "backoff", False,
                            note=f"gate: backoff {wait_ms}ms")
                return masked("backoff")
    except Exception:
        return None
    return None


def load_client():
    spec = importlib.util.spec_from_file_location("huiyu_relay_main", CLIENT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    path, payload_file = sys.argv[1], sys.argv[2]
    with open(payload_file, "r", encoding="utf-8") as fh:
        body = json.load(fh)

    audio_path = body.pop("audioPath", None)
    image_path = body.pop("imagePath", None)
    if audio_path and image_path:
        print("conflicting_attachments")
        return 0
    if audio_path:
        ext = os.path.splitext(audio_path)[1].lower()
        if ext != ".mp3":
            print("bad_audio_type")
            return 0
        size = os.path.getsize(audio_path)
        if size > MAX_IMAGE_BYTES:
            print("audio_too_large")
            return 0
        with open(audio_path, "rb") as fh:
            data = base64.b64encode(fh.read()).decode("ascii")
        body["audio"] = {"mimeType": "audio/mpeg", "data": data}

    if image_path:
        ext = os.path.splitext(image_path)[1].lower()
        mime = MIME_BY_EXT.get(ext)
        if not mime:
            print("bad_image_type")
            return 0
        size = os.path.getsize(image_path)
        if size > MAX_IMAGE_BYTES:
            print("image_too_large")
            return 0
        with open(image_path, "rb") as fh:
            data = base64.b64encode(fh.read()).decode("ascii")
        body["image"] = {"mimeType": mime, "data": data}

    key = body.get("requestKey")
    is_skip = body.get("skip") is True
    if isinstance(key, str) and key:
        gated = _gate(path, key, is_skip)
        if gated is not None:
            print(gated)
            return 0

    mod = load_client()
    try:
        status, out = mod.call_json("POST", path, body, timeout=60)
    except Exception as exc:  # transport failure; request may be submitted
        if isinstance(key, str) and key:
            _ledger_add(key, f"http_error:{type(exc).__name__}", True,
                        cls="retryable", maybe_sent=True,
                        note="transport failure; request may have been "
                             "submitted before the failure")
        print(f"http_error:{type(exc).__name__}")
        return 0
    body_status = out.get("status") if isinstance(out, dict) else None
    if body_status == UNCERTAIN_STATUS and isinstance(key, str) and key:
        # Stop all automatic sending for this key, whatever the HTTP code.
        _ledger_add(key, UNCERTAIN_STATUS, True, cls="uncertain",
                    note="gateway reported QQ_MUSE_SEND_UNCERTAIN; "
                         "manual check required")
    if status >= 400:
        if isinstance(key, str) and key and body_status != UNCERTAIN_STATUS:
            if status == 410:
                cls = "terminal"
                note = "original message expired (410)"
            elif status == 429 or 500 <= status < 600 \
                    or body_status == PENDING_STATUS:
                cls = "retryable"
                note = f"transient http {status}"
            else:
                cls = "dead"
                detail = body_status or ""
                for field in ("error", "message"):
                    value = out.get(field) if isinstance(out, dict) else None
                    if isinstance(value, str) and value:
                        detail = f"{detail} {value}".strip()
                        break
                note = f"non-retryable rejection http {status}" \
                       + (f": {detail[:200]}" if detail else "")
            _ledger_add(key, f"http_error:{status}", True, cls=cls,
                        note=note, retry_after_ms=_retry_after_ms(out))
        print(f"http_error:{status}")
        return 0
    if isinstance(out, dict):
        printed = str(out.get("status", "no_status"))
        if isinstance(key, str) and key and body_status != UNCERTAIN_STATUS:
            if printed in SUCCESS_STATUSES:
                cls = "success"
            elif printed == PENDING_STATUS:
                cls = "retryable"
            else:
                # Unknown gateway status: callers leave the file and call
                # again; the attempt cap still bounds the total POSTs.
                cls = "retryable"
            _ledger_add(key, printed, True, cls=cls,
                        retry_after_ms=_retry_after_ms(out))
        print(printed)
    else:
        if isinstance(key, str) and key:
            _ledger_add(key, "bad_response", True, cls="retryable",
                        maybe_sent=True,
                        note="unparseable response; delivery unknown")
        print("bad_response")
    return 0


if __name__ == "__main__":
    sys.exit(main())
