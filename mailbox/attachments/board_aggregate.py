#!/usr/bin/env python3
"""Aggregate QQ + desktop bridge message states into board-status.json.

Row key is (channel, requestKey) per the dashboard contract agreed with
Codex (mailbox 2026-11-20): stages carry Unix-ms timestamps from local
file records; statuses use the shared labels. Gateway-side stages that
have no local record are simply absent (the board marks that blind spot).
"""
import glob
import json
import os
import tempfile
import time

HOME = "/home/hatch"
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


def load_receipts(bridge):
    """Sender-kept terminal outcomes; a receipt outranks outbox inference."""
    receipts = {}
    try:
        with open(os.path.join(bridge, "receipts.jsonl"), "r", encoding="utf-8") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("key"):
                    receipts[rec["key"]] = rec
    except FileNotFoundError:
        pass
    return receipts


def preview(text, limit=80):
    text = (text or "").replace("\n", " ").strip()
    return text[:limit]


def qq_rows(now_ms):
    bridge = os.path.join(HOME, "workspace/qq-bridge")
    state = os.path.join(HOME, "hooks/state/qq-bridge")
    receipts = load_receipts(bridge)
    rows = []
    for path in glob.glob(os.path.join(bridge, "inbox", "*.json")):
        key = os.path.basename(path)[:-5]
        item = load_json(path) or {}
        out_path = os.path.join(bridge, "outbox", key + ".json")
        out = load_json(out_path) if os.path.exists(out_path) else None
        sent_at = mtime_ms(os.path.join(state, "sent-" + key))
        fallback_at = mtime_ms(os.path.join(state, "fallback-" + key))
        exp = item.get("expiresAt") or 0
        stages = {"received": mtime_ms(path)}
        if out is not None:
            stages["answered"] = mtime_ms(out_path)
        if sent_at:
            stages["confirmed"] = sent_at
        rcpt = receipts.get(key)
        if rcpt is not None and rcpt.get("via") == "reply" and rcpt.get("status") in ("sent", "skipped", "accepted"):
            status = "skipped" if rcpt["status"] == "skipped" else "confirmed"
            if rcpt.get("at"):
                stages["confirmed"] = stages.get("confirmed") or rcpt["at"]
        elif out is not None and out.get("skip") and sent_at:
            status = "skipped"
        elif sent_at:
            status = "confirmed"
        elif fallback_at:
            status = "fallback"
            stages["fallback"] = fallback_at
        elif out is not None:
            status = "waiting_send"
        elif exp and now_ms > exp:
            status = "expired"
        else:
            status = "waiting_reply"
        rows.append({
            "channel": "qq",
            "requestKey": key,
            "conversationId": item.get("conversationId"),
            "who": item.get("senderNickname") or "",
            "role": item.get("senderRole") or "",
            "preview": preview(item.get("text")),
            "replyPreview": preview((out or {}).get("text")) if out else "",
            "hasAttachment": bool(item.get("attachments")),
            "status": status,
            "stages": stages,
            "expiresAt": exp,
        })
    for path in glob.glob(os.path.join(bridge, "sendbox", "*.json")):
        key = os.path.basename(path)[:-5]
        item = load_json(path) or {}
        sent_at = mtime_ms(os.path.join(state, "sent-send-" + key))
        rows.append({
            "channel": "qq",
            "requestKey": key,
            "conversationId": item.get("conversationId"),
            "who": "宁宁（主动）",
            "role": "proactive",
            "preview": preview(item.get("text")),
            "replyPreview": "",
            "hasAttachment": bool(item.get("imagePath") or item.get("audioPath")),
            "status": "confirmed" if sent_at else "waiting_send",
            "stages": {"received": mtime_ms(path), "confirmed": sent_at},
            "expiresAt": 0,
        })
    return rows


def desktop_rows(now_ms):
    bridge = os.path.join(HOME, "workspace/desktop-bridge")
    state = os.path.join(HOME, "hooks/state/desktop-bridge")
    receipts = load_receipts(bridge)
    rows = []
    for path in glob.glob(os.path.join(bridge, "inbox", "*.json")):
        key = os.path.basename(path)[:-5]
        item = load_json(path) or {}
        out_path = os.path.join(bridge, "outbox", key + ".json")
        out = load_json(out_path) if os.path.exists(out_path) else None
        sent_at = mtime_ms(os.path.join(state, "sent-" + key))
        lost_at = mtime_ms(os.path.join(state, "lost-" + key))
        exp = item.get("expiresAt") or 0
        stages = {"received": mtime_ms(path)}
        if out is not None:
            stages["answered"] = mtime_ms(out_path)
        if sent_at:
            stages["confirmed"] = sent_at
        rcpt = receipts.get(key)
        if rcpt is not None and rcpt.get("via") == "reply" and rcpt.get("status") in ("sent", "accepted"):
            status = "confirmed"
            if rcpt.get("at"):
                stages["confirmed"] = stages.get("confirmed") or rcpt["at"]
        elif sent_at:
            status = "confirmed"
        elif lost_at:
            status = "lost"
            stages["lost"] = lost_at
        elif out is not None:
            status = "waiting_send"
        elif exp and now_ms > exp:
            status = "expired"
        else:
            status = "waiting_reply"
        rows.append({
            "channel": "desktop",
            "requestKey": key,
            "conversationId": item.get("conversationId"),
            "who": item.get("character") or "",
            "role": "character",
            "preview": preview(item.get("text")),
            "replyPreview": preview((out or {}).get("text")) if out else "",
            "hasAttachment": False,
            "status": status,
            "stages": stages,
            "expiresAt": exp,
        })
    return rows


def main():
    now_ms = int(time.time() * 1000)
    rows = qq_rows(now_ms) + desktop_rows(now_ms)
    rows.sort(key=lambda r: r["stages"].get("received") or 0, reverse=True)
    payload = {"generatedAt": now_ms, "rows": rows[:KEEP]}
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    os.replace(tmp, OUT)
    print(f"board_rows={len(payload['rows'])}")


if __name__ == "__main__":
    main()
