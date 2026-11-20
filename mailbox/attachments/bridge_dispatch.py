#!/usr/bin/env python3
"""Assign one conversation group to each independent Hatch worker slot."""
import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import uuid
from pathlib import Path

from bridge_delivery import object_at, reply_deadline


OFFER_MS = 20_000
WORK_MS = 80_000
QQ_WORK_MS = 120_000
MAX_GROUP = 8
INLINE_QUESTION_BYTES = 12 * 1024
KEY = re.compile(r"[A-Za-z0-9_-]{1,160}")
MEDIA_REQUEST = re.compile(
    r"^(?:(?:宁宁|宝宝|老婆)[，,：:\s]*)?(?:请|麻烦)?(?:给(?:我|我们)|帮(?:我|我们))?"
    r"(?:再|先|顺便|也)?\s*(?:发(?:送)?|来|录(?:制)?|画|生成)"
    r"[^。！？!?\n]{0,16}(?:图片|照片|自拍|表情包|语音|录音|音频|[张幅]图)"
)
MANAGED = b"muse-dispatch-v1\n"


class Unavailable(Exception):
    """A ticket is stale, or the item has already finished."""


def milliseconds():
    return time.time_ns() // 1_000_000


def atomic_first(path, contents, before_link=None):
    """Publish a fully written file without replacing another producer's answer."""
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".dispatch-")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        if before_link is not None:
            before_link()
        os.link(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(name)


class Queue:
    def __init__(self, channel):
        self.channel = channel
        self.work_ms = QQ_WORK_MS if channel == "qq" else WORK_MS
        self.bridge = Path.home() / "workspace" / (channel + "-bridge")
        self.state = Path.home() / "hooks" / "state" / (channel + "-bridge")
        self.inbox = self.bridge / "inbox"
        self.outbox = self.bridge / "outbox"
        self.claims = self.bridge / "claimed"
        for directory in (self.inbox, self.outbox, self.claims):
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.bridge / "dispatch-v1.sqlite3", timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("""CREATE TABLE IF NOT EXISTS slots (
            slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 3),
            ticket TEXT UNIQUE NOT NULL, group_id TEXT UNIQUE NOT NULL,
            phase TEXT NOT NULL, until_ms INTEGER NOT NULL,
            keys_json TEXT NOT NULL, started_json TEXT NOT NULL)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY, at INTEGER NOT NULL, slot INTEGER NOT NULL,
            event TEXT NOT NULL, items INTEGER NOT NULL, queueMs INTEGER)""")

    def record(self, slot, event, items, queue_ms=None):
        cursor = self.db.execute("INSERT INTO activity(at,slot,event,items,queueMs) VALUES(?,?,?,?,?)",
                                 (milliseconds(), slot, event, items, queue_ms))
        self.db.execute("DELETE FROM activity WHERE id<=?", (cursor.lastrowid - 512,))

    def read_item(self, key, now, finished=None):
        if not KEY.fullmatch(key):
            return None
        if finished is not None:
            if key in finished:
                return None
        elif (self.outbox / (key + ".json")).exists() or any(
            (self.state / (prefix + key)).exists() for prefix in ("sent-", "lost-", "fallback-")
        ):
            return None
        path = self.inbox / (key + ".json")
        try:
            with path.open(encoding="utf-8") as stream:
                item = json.load(stream)
                arrival = os.fstat(stream.fileno()).st_mtime_ns
        except (FileNotFoundError, UnicodeError, json.JSONDecodeError):
            return None
        if not isinstance(item, dict) or item.get("requestKey") != key:
            return None
        expiry = reply_deadline(item)
        if type(expiry) is not int or expiry <= now:
            return None
        room = item.get("conversationId")
        group = [room if isinstance(room, str) else ""]
        ambient = item.get("ambient") is True
        if self.channel == "qq":
            sender = item.get("senderId")
            group.append(sender if isinstance(sender, str) else "")
            text = item.get("userText", item.get("text", ""))
            has_media = bool(item.get("attachments")) or (
                isinstance(text, str) and MEDIA_REQUEST.match(text.strip()) is not None)
            if not ambient or has_media:
                # Addressed questions and media jobs get their own slot even when the sender is the same.
                group.append(key)
                ambient = False
        return (json.dumps(group, ensure_ascii=False), arrival, expiry, ambient, key)

    def legacy_claim(self, key):
        try:
            with (self.claims / (key + ".claim")).open("rb") as stream:
                return stream.read(len(MANAGED) + 1) != MANAGED
        except FileNotFoundError:
            return False

    def candidates(self):
        now = milliseconds()
        groups = {}
        blocked = set()
        finished = {path.stem for path in self.outbox.glob("*.json")}
        for prefix in ("sent-", "lost-", "fallback-"):
            finished.update(path.name[len(prefix):] for path in self.state.glob(prefix + "*"))
        for path in self.inbox.glob("*.json"):
            item = self.read_item(path.stem, now, finished)
            if item is None:
                continue
            group = item[0]
            if group in blocked:
                continue
            if self.legacy_claim(path.stem):
                # An old writer has no ticket and cannot be fenced. Leave its group alone.
                blocked.add(group)
            else:
                groups.setdefault(group, []).append(item)
        candidates = []
        for group, items in groups.items():
            if group in blocked:
                continue
            items.sort(key=lambda item: (item[1], item[4]))
            first = items[0]
            candidates.append(((first[2], first[3], first[1], first[4]), group, items))
        return sorted(candidates, key=lambda candidate: candidate[0])

    def reserve(self, slot, candidates, *, after_wake=False):
        now = milliseconds()
        expired = self.db.execute("SELECT slot, keys_json FROM slots WHERE phase='offered' AND until_ms<=?",
                                  (now,)).fetchall()
        for row in expired:
            self.record(row["slot"], "offer_expired", len(json.loads(row["keys_json"])), OFFER_MS)
        self.db.execute("DELETE FROM slots WHERE until_ms <= ?", (now,))
        rows = self.db.execute("SELECT slot, group_id FROM slots").fetchall()
        if any(row["slot"] == slot for row in rows):
            return None
        busy = {row["group_id"] for row in rows}
        for _, group, items in candidates:
            if group in busy:
                continue
            # Legacy records without a room or sender must not be merged as one person's turn.
            grouping = json.loads(group)
            batch_size = MAX_GROUP if len(grouping) <= 2 and all(grouping) else 1
            batch = [item for item in items if item[2] > now][:batch_size]
            if batch:
                keys = [item[4] for item in batch]
                ticket = uuid.uuid4().hex
                self.db.execute("INSERT INTO slots VALUES (?,?,?,'offered',?,?,'[]')",
                                (slot, ticket, group, now + OFFER_MS, json.dumps(keys)))
                if not after_wake:
                    self.record(slot, "offer", len(keys), max(0, now - batch[0][1] // 1_000_000))
                return {"channel": self.channel, "slot": slot, "ticket": ticket, "pending": keys}
        return None

    def offer(self, slot, wait):
        end = time.monotonic() + wait
        while True:
            busy = self.db.execute("SELECT 1 FROM slots WHERE slot=? AND until_ms>?",
                                   (slot, milliseconds())).fetchone()
            if not busy:
                # Reads of a large historical spool never hold the dispatcher write lock.
                candidates = self.candidates()
                if candidates:
                    with self.db:
                        self.db.execute("BEGIN IMMEDIATE")
                        result = self.reserve(slot, candidates)
                    if result:
                        return result
            left = end - time.monotonic()
            if left <= 0:
                return {"pending": []}
            time.sleep(min(left, 1))

    def require(self, ticket, phase):
        row = self.db.execute("SELECT * FROM slots WHERE ticket=?", (ticket,)).fetchone()
        if row is None or row["phase"] != phase or row["until_ms"] <= milliseconds():
            raise Unavailable("ticket_unavailable")
        return row

    def begin(self, ticket, *, after_wake=False):
        row = self.require(ticket, "offered")
        now = milliseconds()
        keys = [key for key in json.loads(row["keys_json"]) if self.read_item(key, now)]
        if not keys:
            self.db.execute("DELETE FROM slots WHERE ticket=?", (ticket,))
            return {"pending": []}
        self.require(ticket, "offered")
        began = milliseconds()
        self.db.execute("UPDATE slots SET phase='working',until_ms=?,keys_json=? WHERE ticket=?",
                        (began + self.work_ms, json.dumps(keys), ticket))
        wake_delay = None if after_wake else max(0, began - (row["until_ms"] - OFFER_MS))
        self.record(row["slot"], "take" if after_wake else "begin", len(keys), wake_delay)
        return {"channel": self.channel, "slot": row["slot"], "ticket": ticket, "pending": keys}

    def take(self, slot, candidates):
        row = self.db.execute("SELECT * FROM slots WHERE slot=? AND until_ms>?",
                              (slot, milliseconds())).fetchone()
        if row and row["phase"] == "working":
            return {"pending": []}
        if row:
            return self.begin(row["ticket"], after_wake=True)
        offer = self.reserve(slot, candidates, after_wake=True)
        return self.begin(offer["ticket"], after_wake=True) if offer else {"pending": []}

    def check_key(self, row, key):
        keys = json.loads(row["keys_json"])
        if key not in keys:
            raise Unavailable("unassigned_key")
        item = self.read_item(key, milliseconds())
        if item is None or item[0] != row["group_id"] or self.legacy_claim(key):
            raise Unavailable("item_unavailable")
        if self.channel == "desktop":
            if any(self.read_item(old, milliseconds()) for old in keys[:keys.index(key)]):
                raise Unavailable("earlier_turn_pending")
        return item

    def read_first(self, assignment):
        if not assignment["pending"]:
            return assignment
        key = assignment["pending"][0]
        ticket = assignment["ticket"]
        path = self.inbox / (key + ".json")
        with path.open("rb") as stream:
            raw = stream.read(INLINE_QUESTION_BYTES + 1)
        first = {"requestKey": key, "path": str(path)}
        if len(raw) <= INLINE_QUESTION_BYTES:
            message = json.loads(raw)
            first.update(message=message, isOwner=self.is_owner(message))
        self.start(ticket, key)
        return {**assignment, "first": first}

    def is_owner(self, message):
        if message.get("senderRole") == "owner":
            return True
        try:
            owners = object_at(self.bridge / "owners.json")
        except (OSError, ValueError):
            return False
        conversations = owners.get("conversations")
        room_id = message.get("conversationId")
        room = conversations.get(room_id) if isinstance(conversations, dict) and isinstance(room_id, str) else None
        senders = room.get("ownerSenderIds") if isinstance(room, dict) else None
        sender = message.get("senderId")
        return isinstance(senders, list) and isinstance(sender, str) and sender in senders

    def start(self, ticket, key):
        row = self.require(ticket, "working")
        item = self.check_key(row, key)
        path = self.claims / (key + ".claim")
        try:
            atomic_first(path, MANAGED)
        except FileExistsError:
            if self.legacy_claim(key):
                raise Unavailable("legacy_worker_active")
        self.require(ticket, "working")
        started = json.loads(row["started_json"])
        if key not in started:
            started.append(key)
            arrived = item[1] // 1_000_000
            now = milliseconds()
            phase = self.db.execute("SELECT at,event FROM activity WHERE slot=? AND event IN ('begin','take','start') "
                                    "ORDER BY id DESC LIMIT 1", (row["slot"],)).fetchone()
            if phase and phase["event"] != "start":
                self.record(row["slot"], "first_start", 1, max(0, now - phase["at"]))
            self.record(row["slot"], "start", 1, max(0, now - arrived))
        self.db.execute("UPDATE slots SET until_ms=?,started_json=? WHERE ticket=?",
                        (milliseconds() + self.work_ms, json.dumps(started), ticket))
        return {"started": key}

    def publish(self, ticket, key, answer):
        row = self.require(ticket, "working")
        item = self.check_key(row, key)
        started = json.loads(row["started_json"])
        if key not in started:
            raise Unavailable("item_not_started")

        def still_current():
            self.require(ticket, "working")
            self.check_key(row, key)

        try:
            atomic_first(self.outbox / (key + ".json"), answer, still_current)
        except FileExistsError:
            raise Unavailable("already_published")
        started.remove(key)
        self.db.execute("UPDATE slots SET until_ms=?,started_json=? WHERE ticket=?",
                        (milliseconds() + self.work_ms, json.dumps(started), ticket))
        self.record(row["slot"], "publish", 1, max(0, milliseconds() - item[1] // 1_000_000))
        return {"published": key}

    def adopt_legacy(self):
        # Operator calls this only after draining all pre-ticket answering hooks.
        adopted = 0
        for path in self.claims.glob("*.claim"):
            if not self.read_item(path.stem, milliseconds()):
                continue
            try:
                with path.open("r+b") as stream:
                    original = os.fstat(stream.fileno())
                    if original.st_size:
                        continue
                    stream.write(MANAGED)
                    stream.flush()
                    os.utime(stream.fileno(), ns=(original.st_atime_ns, original.st_mtime_ns))
                    os.fsync(stream.fileno())
                    adopted += 1
            except FileNotFoundError:
                continue
        return {"adopted": adopted}


def answer_from_stdin(channel, key):
    raw = sys.stdin.buffer.read(131_073)
    if len(raw) > 131_072:
        raise ValueError("payload_too_large")
    body = json.loads(raw)
    if not isinstance(body, dict) or body.get("requestKey") != key:
        raise ValueError("wrong_request_key")
    if channel == "qq" and set(body) == {"requestKey", "skip"} and body["skip"] is True:
        return raw
    media = [field for field in ("audioPath", "imagePath") if field in body]
    if (channel == "desktop" and media) or len(media) > 1:
        raise ValueError("unsupported_attachment")
    if media and (not isinstance(body[media[0]], str) or not os.path.isabs(body[media[0]])):
        raise ValueError("invalid_attachment_path")
    if set(body) - {"requestKey", "text", *media}:
        raise ValueError("unexpected_reply_fields")
    text = body.get("text")
    limit = 1600 if channel == "qq" else 12_000
    if "text" in body or not media:
        if not isinstance(text, str) or not 0 < len(text.strip()) <= limit:
            raise ValueError("invalid_reply_text")
    return raw


def status(channel):
    path = Path.home() / "workspace" / (channel + "-bridge") / "dispatch-v1.sqlite3"
    result = {"channel": channel, "sampledAt": milliseconds(), "installed": False,
              "slots": [], "recent": []}
    if not path.is_file():
        return result
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    try:
        db.execute("BEGIN")
        for row in db.execute("SELECT slot,phase,until_ms,started_json FROM slots WHERE until_ms>? ORDER BY slot",
                              (result["sampledAt"],)):
            result["slots"].append({"slot": row["slot"], "phase": row["phase"], "until": row["until_ms"],
                                    "started": len(json.loads(row["started_json"]))})
        events = db.execute("SELECT at,slot,event,items,queueMs FROM activity ORDER BY id DESC LIMIT 64")
        timings = {"offer": "inboxToOfferMs", "begin": "offerToBeginMs",
                   "first_start": "beginToFirstStartMs", "offer_expired": "offerWaitAtLeastMs",
                   "publish": "inboxToPublishMs"}
        for row in reversed(events.fetchall()):
            event = dict(row)
            timing = timings.get(event["event"])
            if timing is not None and event["queueMs"] is not None:
                event[timing] = event["queueMs"]
                event["queueMs"] = None
            result["recent"].append(event)
        result["installed"] = True
        return result
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("offer", "begin", "take", "start", "renew", "publish", "finish", "adopt-legacy", "status"):
        sub = commands.add_parser(name)
        sub.add_argument("channel", choices=("qq", "desktop"))
        if name in ("offer", "take"):
            sub.add_argument("slot", type=int, choices=(1, 2, 3))
        elif name not in ("adopt-legacy", "status"):
            sub.add_argument("ticket")
        if name in ("start", "publish"):
            sub.add_argument("key")
        if name == "offer":
            sub.add_argument("--wait", type=int, choices=range(61), metavar="0..60", default=0)
        if name in ("begin", "take"):
            sub.add_argument("--read-first", action="store_true", help="claim and return the first QQ message")
    args = parser.parse_args()
    read_first = getattr(args, "read_first", False)
    if read_first and args.channel != "qq":
        parser.error("--read-first requires the QQ channel")
    os.umask(0o077)
    if args.command == "status":
        print(json.dumps(status(args.channel)))
        return
    queue = Queue(args.channel)
    try:
        # Read the producer pipe before locking; slow generation must not stall other slots.
        body = answer_from_stdin(args.channel, args.key) if args.command == "publish" else None
        if args.command == "offer":
            result = queue.offer(args.slot, args.wait)
        else:
            candidates = queue.candidates() if args.command == "take" else None
            with queue.db:
                queue.db.execute("BEGIN IMMEDIATE")
                if args.command == "begin":
                    result = queue.begin(args.ticket)
                elif args.command == "take":
                    result = queue.take(args.slot, candidates)
                elif args.command == "start":
                    result = queue.start(args.ticket, args.key)
                elif args.command == "publish":
                    result = queue.publish(args.ticket, args.key, body)
                elif args.command == "adopt-legacy":
                    result = queue.adopt_legacy()
                else:
                    row = queue.require(args.ticket, "working")
                    if args.command == "finish":
                        queue.record(row["slot"], "finish", len(json.loads(row["started_json"])))
                        queue.db.execute("DELETE FROM slots WHERE ticket=?", (args.ticket,))
                        result = {"released": True}
                    else:
                        queue.db.execute("UPDATE slots SET until_ms=? WHERE ticket=?",
                                         (milliseconds() + queue.work_ms, args.ticket))
                        result = {"renewed": True}
                if read_first:
                    result = queue.read_first(result)
        print(json.dumps(result, ensure_ascii=False))
    finally:
        queue.db.close()


if __name__ == "__main__":
    try:
        main()
    except (Unavailable, ValueError, OSError, sqlite3.Error) as error:
        sys.exit(str(error))
