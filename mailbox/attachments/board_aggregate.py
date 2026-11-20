#!/usr/bin/env python3
"""Aggregate QQ + desktop bridge message states into board-status.json.

Row key is (channel, requestKey) per the dashboard contract agreed with
Codex (mailbox 2026-11-20): stages carry Unix-ms timestamps from local
file records; statuses use the shared labels. Gateway-side stages that
have no local record are simply absent (the board marks that blind spot).
"""
import glob
import fcntl
import json
import os
import tempfile
import time

from board_sources import CONFIRMATIONS, observe_rows
from pipeline_signals import channel_traffic, connector_node, delivery_view, intake_edge, probe_cache_path

HOME = os.path.expanduser("~")
OUT = os.path.join(HOME, "workspace/bridge-tools/board-status.json")
KEEP = 60


def mtime_ms(path):
    try:
        return int(os.stat(path).st_mtime * 1000)
    except FileNotFoundError:
        return None


def load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            value = json.load(fh)
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def load_receipts(bridge, channel):
    """Sender-kept terminal outcomes; a receipt outranks outbox inference."""
    receipts = {}
    try:
        with open(os.path.join(bridge, "receipts.jsonl"), "rb") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if not isinstance(rec, dict):
                    continue
                key, via, status = rec.get("key"), rec.get("via"), rec.get("status")
                if not isinstance(key, str) or not key or not isinstance(via, str) or not isinstance(status, str):
                    continue
                confirmed = (channel, via, status) in CONFIRMATIONS
                # Earlier snapshots treated these two spellings as locally complete.
                legacy = (channel, via, status) in (
                    ("qq", "reply", "accepted"), ("desktop", "reply", "sent"),
                )
                if not (confirmed or legacy):
                    continue
                receipt = {"via": via, "status": status}
                if type(rec.get("at")) is int and rec["at"] > 0:
                    receipt["at"] = rec["at"]
                prior = receipts.get((via, key))
                if prior is None or (confirmed and prior.get("legacy")):
                    if legacy:
                        receipt["legacy"] = True
                    receipts[(via, key)] = receipt
    except FileNotFoundError:
        pass
    return receipts


def preview(text, limit=80):
    return text.replace("\n", " ").strip()[:limit] if isinstance(text, str) else ""


def deadline_ms(item):
    value = item.get("expiresAt")
    return value if type(value) is int and value > 0 else 0


def qq_rows(now_ms):
    bridge = os.path.join(HOME, "workspace/qq-bridge")
    state = os.path.join(HOME, "hooks/state/qq-bridge")
    receipts = load_receipts(bridge, "qq")
    rows = []
    for path in glob.glob(os.path.join(bridge, "inbox", "*.json")):
        key = os.path.basename(path)[:-5]
        item = load_json(path) or {}
        out_path = os.path.join(bridge, "outbox", key + ".json")
        out = load_json(out_path) if os.path.exists(out_path) else None
        sent_at = mtime_ms(os.path.join(state, "sent-" + key))
        fallback_at = mtime_ms(os.path.join(state, "fallback-" + key))
        exp = deadline_ms(item)
        stages = {"received": mtime_ms(path)}
        if out is not None:
            stages["answered"] = mtime_ms(out_path)
        if sent_at:
            stages["confirmed"] = sent_at
        rcpt = receipts.get(("reply", key))
        if rcpt is not None:
            status = "skipped" if rcpt["status"] == "skipped" else "confirmed"
            if rcpt.get("at"):
                stages["confirmed"] = rcpt["at"]
        elif out is not None and out.get("skip") and sent_at:
            status = "skipped"
        elif sent_at:
            status = "confirmed"
        elif fallback_at:
            # The old poller also touched fallback-<key> when dropping an expired skip.
            if out and (out.get("skip") or not (out.get("text") or out.get("audioPath") or out.get("imagePath"))):
                status = "expired"
            else:
                status = "fallback"
                stages["fallback"] = fallback_at
        elif out is not None:
            status = "waiting_send"
        elif exp and now_ms > exp:
            status = "expired"
        elif not exp or item.get("requestKey") != key:
            status = "unknown"
        else:
            status = "waiting_reply"
        rows.append({
            "channel": "qq",
            "via": "reply",
            "requestKey": key,
            "conversationId": item.get("conversationId"),
            "who": item.get("senderNickname") or "",
            "role": item.get("senderRole") or "",
            "preview": preview(item.get("text")),
            "replyPreview": preview((out or {}).get("text")) if out else "",
            "hasAttachment": bool(item.get("attachments")),
            "status": status,
            "receipt": rcpt,
            "stages": stages,
            "expiresAt": exp,
        })
    for path in glob.glob(os.path.join(bridge, "sendbox", "*.json")):
        key = os.path.basename(path)[:-5]
        item = load_json(path) or {}
        sent_at = mtime_ms(os.path.join(state, "sent-send-" + key))
        rcpt = receipts.get(("send", key))
        rows.append({
            "channel": "qq",
            "via": "send",
            "requestKey": key,
            "conversationId": item.get("conversationId"),
            "who": "宁宁（主动）",
            "role": "proactive",
            "preview": preview(item.get("text")),
            "replyPreview": "",
            "hasAttachment": bool(item.get("imagePath") or item.get("audioPath")),
            "status": "confirmed" if rcpt or sent_at else "waiting_send",
            "receipt": rcpt,
            "stages": {"received": mtime_ms(path), "confirmed": (rcpt or {}).get("at", sent_at)},
            "expiresAt": 0,
        })
    observe_rows(rows, bridge, now_ms)
    return rows


def desktop_rows(now_ms):
    bridge = os.path.join(HOME, "workspace/desktop-bridge")
    state = os.path.join(HOME, "hooks/state/desktop-bridge")
    receipts = load_receipts(bridge, "desktop")
    rows = []
    for path in glob.glob(os.path.join(bridge, "inbox", "*.json")):
        key = os.path.basename(path)[:-5]
        item = load_json(path) or {}
        out_path = os.path.join(bridge, "outbox", key + ".json")
        out = load_json(out_path) if os.path.exists(out_path) else None
        sent_at = mtime_ms(os.path.join(state, "sent-" + key))
        lost_at = mtime_ms(os.path.join(state, "lost-" + key))
        exp = deadline_ms(item)
        stages = {"received": mtime_ms(path)}
        if out is not None:
            stages["answered"] = mtime_ms(out_path)
        if sent_at:
            stages["confirmed"] = sent_at
        rcpt = receipts.get(("reply", key))
        if rcpt is not None:
            status = "confirmed"
            if rcpt.get("at"):
                stages["confirmed"] = rcpt["at"]
        elif sent_at:
            status = "confirmed"
        elif lost_at:
            status = "lost"
            stages["lost"] = lost_at
        elif out is not None:
            status = "waiting_send"
        elif exp and now_ms > exp:
            status = "expired"
        elif not exp or item.get("requestKey") != key:
            status = "unknown"
        else:
            status = "waiting_reply"
        rows.append({
            "channel": "desktop",
            "via": "reply",
            "requestKey": key,
            "conversationId": item.get("conversationId"),
            "who": item.get("character") or "",
            "role": "character",
            "preview": preview(item.get("text")),
            "replyPreview": preview((out or {}).get("text")) if out else "",
            "hasAttachment": False,
            "status": status,
            "receipt": rcpt,
            "stages": stages,
            "expiresAt": exp,
        })
    observe_rows(rows, bridge, now_ms)
    return rows


def board_signal(row, now_ms):
    """Map one existing board row to the pipeline without inventing worker activity."""
    status = row["status"]
    via = row.get("via") or ("send" if row.get("role") == "proactive" else "reply")
    attempt = row.get("senderPhase")
    code = row.get("lastErrorCode") if attempt != "posting" else None
    receipt = row.get("receipt")
    deadline = row.get("expiresAt") or 0
    if receipt and not receipt.get("legacy"):
        phase = "skipped" if receipt["status"] == "skipped" else "confirmed"
    elif attempt in ("posting", "rejected", "uncertain", "expired", "fallback", "unknown"):
        phase = attempt
    elif status in ("confirmed", "skipped", "fallback") or attempt == "marked_done":
        phase = {"confirmed": "marked_done", "skipped": "marked_skip", "fallback": "fallback"}.get(status, "marked_done")
    elif status in ("expired", "lost") or (deadline and now_ms >= deadline):
        phase = "uncertain" if row["stages"].get("firstPost") or attempt == "retry" else (
            "lost" if status == "lost" else "expired")
    elif attempt == "retry":
        phase = "retry"
    elif status == "waiting_send":
        phase = "uncertain" if row["stages"].get("firstPost") else "ready"
    elif status == "waiting_reply":
        worker = row.get("workerActive")
        phase = "awaiting_answer" if worker is None else "answering" if worker else "queued"
    else:
        phase = None
    return {"phase": phase, "receipt": receipt, "via": via, "code": code}


def pipeline_lanes(rows, now_ms):
    grouped = {"qq": {}, "desktop": {}}
    for row in rows:
        channel, key = row["channel"], row["requestKey"]
        signal = board_signal(row, now_ms)
        row["phase"] = signal["phase"]
        row["delivery"] = delivery_view(channel, **signal)
        entries = grouped[channel]
        # A reused key across sendbox/inbox is ambiguous. Keep its details visible
        # and count it once as unknown instead of letting traversal order select a row.
        entries[key] = {"phase": None} if key in entries else signal
    # Both current routes target the same main-machine relay. The independent probe
    # replaces this sample even on error. Reading the board never performs a GET.
    node = connector_node(load_json(probe_cache_path()), at=now_ms)
    lanes = {}
    for channel, entries in grouped.items():
        bridge = os.path.join(HOME, "workspace", channel + "-bridge")
        available = os.path.isdir(os.path.join(bridge, "inbox"))
        poll = load_json(os.path.join(HOME, "hooks/state", channel + "-bridge", "last-poll.json")) or {}
        lanes[channel] = {
            "node": node,
            "intake": intake_edge(completed_at=poll.get("completedAt"), ok=poll.get("ok"),
                                  http_status=poll.get("httpStatus"), reason=poll.get("reason"), at=now_ms),
            "counts": channel_traffic(channel, entries if available else None),
        }
    return lanes


def write_snapshot():
    now_ms = int(time.time() * 1000)
    rows = qq_rows(now_ms) + desktop_rows(now_ms)
    now_ms = int(time.time() * 1000)
    lanes = pipeline_lanes(rows, now_ms)
    rows.sort(key=lambda r: r["stages"].get("received") or 0, reverse=True)
    payload = {"generatedAt": now_ms, "rows": rows[:KEEP], "lanes": lanes}
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        os.replace(tmp, OUT)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return len(payload["rows"])


def refresh(min_age_ms=0):
    # The old directory watcher and two receiver processes can all request a refresh.
    # Only one reads the spools, so a slow run cannot replace a more recent snapshot.
    with open(OUT + ".lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return None
        last = mtime_ms(OUT)
        if last is not None and 0 <= time.time_ns() // 1_000_000 - last < min_age_ms:
            return None
        return write_snapshot()


def main():
    count = refresh()
    if count is not None:
        print(f"board_rows={count}")


if __name__ == "__main__":
    main()
