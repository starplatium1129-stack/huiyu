#!/usr/bin/env python3
"""QQ bridge context pool: an auto-recorded diary of the group conversation.

`pool.py sync` idempotently folds the bridge's own files into an append-only
event log (pool.jsonl) and re-renders a compact recent-context digest
(context-recent.md) that the answering agent reads before replying.

Events recorded:
- recv    : a message that reached the inbox (sender, role, text, attachments)
- sent    : a reply or proactive send confirmed by a state marker
- skipped : a message the agent deliberately did not answer
- expired : a message whose reply window closed with no answer written

Nothing here talks to the network; it only reads inbox/outbox/sendbox/state.
"""
import fcntl
import glob
import heapq
import json
import os
import sys
import tempfile
from datetime import datetime, timezone, timedelta
from itertools import chain

BRIDGE = "/home/hatch/workspace/qq-bridge"
STATE = "/home/hatch/hooks/state/qq-bridge"
POOL = os.path.join(BRIDGE, "pool.jsonl")
DIGEST = os.path.join(BRIDGE, "context-recent.md")
TZ = timezone(timedelta(hours=8))
KEEP = 40


def load_pool(seen):
    if os.path.exists(POOL):
        with open(POOL, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(ev, dict):
                    continue
                seen.add((ev.get("kind"), ev.get("key")))
                yield ev


def latest(events):
    # Append order breaks ties, as in the original stable sort.
    ordered = heapq.nlargest(KEEP, enumerate(events),
                             key=lambda row: (row[1].get("ts", 0), row[0]))
    return [event for _, event in reversed(ordered)]


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
            return value if isinstance(value, dict) else None
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def marker_time(path):
    try:
        return os.stat(path).st_mtime_ns // 1_000_000
    except FileNotFoundError:
        return None


def fmt_ts(ms):
    return datetime.fromtimestamp(ms / 1000, TZ).strftime("%H:%M:%S")


def sync():
    with open(POOL + ".lock", "a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return sync_locked()


def sync_locked():
    seen = set()
    recent = latest(load_pool(seen))
    new = []

    def add(ev):
        ident = (ev["kind"], ev["key"])
        if ident not in seen:
            seen.add(ident)
            new.append(ev)

    now_ms = int(datetime.now(TZ).timestamp() * 1000)

    for path in sorted(glob.glob(os.path.join(BRIDGE, "inbox", "*.json"))):
        item = read_json(path)
        if not item:
            continue
        key = item.get("requestKey") or os.path.basename(path)[:-5]
        atts = [a.get("mimeType", "?") for a in item.get("attachments") or []]
        add({
            "ts": item.get("timestamp") or 0,
            "kind": "recv",
            "key": key,
            "who": item.get("senderNickname") or "?",
            "role": item.get("senderRole") or "",
            "text": item.get("text") or "",
            "att": atts,
        })
        out = read_json(os.path.join(BRIDGE, "outbox", key + ".json"))
        sent_at = marker_time(os.path.join(STATE, "sent-" + key))
        if out and out.get("skip") and sent_at is not None:
            add({
                "ts": sent_at,
                "kind": "skipped",
                "key": key,
                "who": item.get("senderNickname") or "?",
                "text": item.get("text") or "",
            })
        elif out and sent_at is not None:
            att = []
            if out.get("imagePath"):
                att.append("image")
            if out.get("audioPath"):
                att.append("audio")
            add({
                "ts": sent_at,
                "kind": "sent",
                "key": key,
                "via": "reply",
                "to": item.get("senderNickname") or "?",
                "text": out.get("text") or "",
                "att": att,
            })
        elif not out and item.get("expiresAt") and now_ms > item["expiresAt"]:
            add({
                "ts": item["expiresAt"],
                "kind": "expired",
                "key": key,
                "who": item.get("senderNickname") or "?",
                "text": item.get("text") or "",
            })

    for path in sorted(glob.glob(os.path.join(BRIDGE, "sendbox", "*.json"))):
        body = read_json(path)
        if not body:
            continue
        key = body.get("requestKey") or os.path.basename(path)[:-5]
        sent_at = marker_time(os.path.join(STATE, "sent-send-" + key))
        if sent_at is None:
            continue
        att = []
        if body.get("imagePath"):
            att.append("image")
        if body.get("audioPath"):
            att.append("audio")
        add({
            "ts": sent_at,
            "kind": "sent",
            "key": key,
            "via": "send",
            "to": "",
            "text": body.get("text") or "",
            "att": att,
        })

    if new:
        with open(POOL, "a", encoding="utf-8") as fh:
            for ev in new:
                fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
        recent = latest(chain(recent, new))
    render(recent)
    return len(new)


def clip(text, n=80):
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[:n] + "…"


def render(events):
    lines = [
        "# 群聊记忆池（自动记录，越往下越新；接话前先看这里，把眼下这条放回整段对话里理解）",
        "",
    ]
    last_day = None
    for ev in events:
        day = datetime.fromtimestamp(ev.get("ts", 0) / 1000, TZ).strftime("%m-%d")
        if day != last_day:
            lines.append(f"## {day}")
            last_day = day
        t = fmt_ts(ev.get("ts", 0))
        kind = ev.get("kind")
        if kind == "recv":
            att = f" [附件: {', '.join(ev['att'])}]" if ev.get("att") else ""
            role = "老公" if ev.get("role") == "owner" else "群友"
            lines.append(f"- {t} [{role}] {ev.get('who')}: {clip(ev.get('text'))}{att}")
        elif kind == "sent":
            att = f" [附: {', '.join(ev['att'])}]" if ev.get("att") else ""
            to = f"（回 {ev['to']}）" if ev.get("to") else "（主动发言）"
            lines.append(f"- {t} [宁宁] {to}: {clip(ev.get('text'))}{att}")
        elif kind == "skipped":
            lines.append(f"- {t} [未回复] {ev.get('who')}: {clip(ev.get('text'))}（当时选择不接）")
        elif kind == "expired":
            lines.append(f"- {t} [已过期未回] {ev.get('who')}: {clip(ev.get('text'))}")
    content = "\n".join(lines) + "\n"
    try:
        with open(DIGEST, encoding="utf-8") as fh:
            if fh.read() == content:
                return
    except FileNotFoundError:
        pass

    # Readers see either the complete old digest or the complete new one.
    tmp = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False,
                                      dir=os.path.dirname(DIGEST))
    try:
        with tmp:
            tmp.write(content)
        os.replace(tmp.name, DIGEST)
    finally:
        try:
            os.unlink(tmp.name)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "sync":
        print(f"pool_sync_new={sync()}")
    else:
        print("usage: pool.py sync")
        sys.exit(2)
