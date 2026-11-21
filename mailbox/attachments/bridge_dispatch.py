#!/usr/bin/env python3
"""Assign one conversation group to each independent Hatch worker slot."""
import argparse
from contextlib import ExitStack, contextmanager
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from bridge_delivery import object_at, reply_deadline
from bridge_watch import wait_for_work, watch_directories


OFFER_MS = 20_000
# A worker with the question in its wake can compose before making its first tool call.
PREVIEW_MS = 60_000
WORK_MS = 80_000
QQ_WORK_MS = 120_000
MAX_GROUP = 8
INLINE_QUESTION_BYTES = 12 * 1024
KEY = re.compile(r"[A-Za-z0-9_-]{1,160}")
MEDIA_REQUEST = re.compile(
    r"^(?:(?:宁宁|宝宝|老婆)[，,：:\s]*)?(?:请问|请|麻烦)?(?:能不能|能否|可以|能)?"
    r"(?:给(?:我们|我)|帮(?:我们|我))?(?:再|先|顺便|也)?\s*(?:发(?:送)?|来|看看|想看|找|挑|录(?:制)?|画|生成)"
    r"[^。！？!?\n]{0,16}(?:(?P<picture>图片|照片|自拍|表情包|[张幅][^。！？!?\n]{0,12}图)|语音|录音|音频)"
)
MANAGED = b"muse-dispatch-v1\n"


class Unavailable(Exception):
    """A ticket is stale, or the item has already finished."""


def milliseconds():
    return time.time_ns() // 1_000_000


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def member_brief(bridge, message):
    room, sender = message.get("conversationId"), message.get("senderId")
    if not isinstance(room, str) or not room or not isinstance(sender, str) or not sender:
        return {}
    try:
        profiles = object_at(bridge / "members.json")
    except (OSError, ValueError):
        return {}
    rooms = profiles.get("conversations")
    room_profile = rooms.get(room) if isinstance(rooms, dict) else None
    members = room_profile.get("members") if isinstance(room_profile, dict) else None
    member = members.get(sender) if isinstance(members, dict) else None
    if not isinstance(member, dict):
        return {}
    brief = {}
    for field in ("nickname", "preferredName", "aliases", "preferences", "brief"):
        value = member.get(field)
        if isinstance(value, str) and value.strip():
            brief[field] = value[:160]
        elif isinstance(value, list):
            words = [word[:60] for word in value[:4] if isinstance(word, str) and word.strip()]
            if words:
                brief[field] = words
    return brief


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

    @contextmanager
    def writing(self):
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            yield

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

    def reserve(self, slot, candidates, *, after_wake=False, preview=False):
        now = milliseconds()
        expired = self.db.execute("SELECT slot, phase, keys_json FROM slots WHERE phase IN ('offered','preview') AND until_ms<=?",
                                  (now,)).fetchall()
        for row in expired:
            duration = PREVIEW_MS if row["phase"] == "preview" else OFFER_MS
            self.record(row["slot"], "offer_expired", len(json.loads(row["keys_json"])), duration)
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
            batch = []
            for item in items:
                # The slot may have published and released between the scan and this transaction.
                fresh = self.read_item(item[4], now)
                if fresh and fresh[0] == group and not self.legacy_claim(item[4]):
                    batch.append(fresh)
                    if len(batch) == batch_size:
                        break
            if batch:
                keys = [item[4] for item in batch]
                ticket = uuid.uuid4().hex
                phase, duration = ("preview", PREVIEW_MS) if preview else ("offered", OFFER_MS)
                self.db.execute("INSERT INTO slots VALUES (?,?,?,?,?,?,'[]')",
                                (slot, ticket, group, phase, now + duration, json.dumps(keys)))
                if not after_wake:
                    self.record(slot, "offer", len(keys), max(0, now - batch[0][1] // 1_000_000))
                return {"channel": self.channel, "slot": slot, "ticket": ticket, "pending": keys}
        return None

    def offer(self, slot, wait, preview=False):
        end = time.monotonic() + wait
        with ExitStack() as watches:
            fd = None
            if wait and preview:
                try:
                    fd = watches.enter_context(watch_directories([self.inbox, self.outbox]))
                except (OSError, AttributeError):
                    pass  # Polling still services leases and recovers when inotify is unavailable.
            while True:
                busy = self.db.execute("SELECT 1 FROM slots WHERE slot=? AND until_ms>?",
                                       (slot, milliseconds())).fetchone()
                if not busy:
                    # Reads of a large historical spool never hold the dispatcher write lock.
                    candidates = self.candidates()
                    if candidates:
                        with self.writing():
                            result = self.reserve(slot, candidates, preview=preview)
                        if result:
                            return self.with_first(result) if preview else result
                left = end - time.monotonic()
                if left <= 0:
                    return {"pending": []}
                if fd is None:
                    time.sleep(min(left, 1))
                else:
                    wait_for_work(fd, min(left, 1))

    def require(self, ticket, *phases):
        row = self.db.execute("SELECT * FROM slots WHERE ticket=?", (ticket,)).fetchone()
        if row is None or row["phase"] not in phases or row["until_ms"] <= milliseconds():
            raise Unavailable("ticket_unavailable")
        return row

    def pending_keys(self, row):
        pending = []
        now = milliseconds()
        for key in json.loads(row["keys_json"]):
            item = self.read_item(key, now)
            if item and item[0] == row["group_id"] and not self.legacy_claim(key):
                pending.append(key)
        return pending

    def begin(self, ticket, *, after_wake=False):
        row = self.require(ticket, "offered", "preview")
        keys = self.pending_keys(row)
        if not keys:
            self.db.execute("DELETE FROM slots WHERE ticket=?", (ticket,))
            return {"pending": []}
        self.require(ticket, row["phase"])
        began = milliseconds()
        self.db.execute("UPDATE slots SET phase='working',until_ms=?,keys_json=? WHERE ticket=?",
                        (began + self.work_ms, json.dumps(keys), ticket))
        duration = PREVIEW_MS if row["phase"] == "preview" else OFFER_MS
        wake_delay = None if after_wake else max(0, began - (row["until_ms"] - duration))
        event = "first_action" if row["phase"] == "preview" else "begin"
        self.record(row["slot"], "take" if after_wake else event, len(keys), wake_delay)
        return {"channel": self.channel, "slot": row["slot"], "ticket": ticket, "pending": keys}

    def take(self, slot, candidates):
        row = self.db.execute("SELECT * FROM slots WHERE slot=? AND until_ms>?",
                              (slot, milliseconds())).fetchone()
        # A live preview may already be in the middle of composing its first reply.
        if row and row["phase"] in ("working", "preview"):
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

    def following_questions(self, keys, message):
        following = []
        for key in keys:
            path = self.inbox / (key + ".json")
            try:
                other = object_at(path)
            except (OSError, ValueError):
                continue
            if (other.get("requestKey") != key or other.get("conversationId") != message.get("conversationId")
                    or other.get("senderId") != message.get("senderId")):
                continue
            part = {"requestKey": key, "path": str(path)}
            text = other.get("userText", other.get("text"))
            if isinstance(text, str):
                part["text"] = text[:120]
                if len(text) > 120:
                    part["truncated"] = True
            following.append(part)
        return following

    def with_first(self, assignment):
        if not assignment.get("pending"):
            return assignment
        key = assignment["pending"][0]
        path = self.inbox / (key + ".json")
        first = {"requestKey": key, "path": str(path)}
        try:
            message = object_at(path)
        except (OSError, ValueError):
            return {**assignment, "first": first}
        if message.get("requestKey") != key:
            return {**assignment, "first": first}
        if len(assignment["pending"]) > 1:
            assignment = {**assignment, "following": self.following_questions(assignment["pending"][1:], message)}
        first["isOwner"] = self.is_owner(message)
        member = member_brief(self.bridge, message)
        if member:
            first["member"] = member
        text = message.get("userText", message.get("text"))
        request = MEDIA_REQUEST.match(text.strip()) if isinstance(text, str) else None
        if request and request.group("picture"):
            from qq_media import search_gallery
            images = search_gallery(self.bridge, text)
            if images:
                first["gallery"] = images
        # Keep the current question intact. Large histories lose oldest turns first;
        # the original inbox file always remains available for a long quote or question.
        history = message.pop("recentMessages", None)
        if isinstance(history, list):
            message["recentMessages"] = []
        first["message"] = message
        # Optional hints must not crowd a complete question out of the wake.
        budget = INLINE_QUESTION_BYTES - 80
        available = budget - len(json_bytes({**assignment, "first": first}))
        for optional in ("gallery", "member"):
            if available < 0 and optional in first:
                del first[optional]
                available = budget - len(json_bytes({**assignment, "first": first}))
        if available < 0 and "following" in assignment:
            # Workers can still read a sibling by its assigned path before combining fragmented messages.
            assignment["following"] = [{"requestKey": part["requestKey"], "path": part["path"]}
                                       for part in assignment["following"]]
            available = budget - len(json_bytes({**assignment, "first": first}))
        if available < 0:
            del first["message"]
        elif isinstance(history, list):
            recent = []
            for turn in reversed(history):
                size = len(json_bytes(turn)) + 1
                if size > available:
                    break
                recent.append(turn)
                available -= size
            message["recentMessages"] = recent[::-1]
            if len(recent) < len(history):
                first["olderTurnsOmitted"] = len(history) - len(recent)
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

    def start(self, ticket, key, *, inline=False):
        row = self.require(ticket, "working", "preview")
        if row["phase"] == "preview":
            inline = True
            self.begin(ticket)
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
            phase = self.db.execute("SELECT at,event FROM activity WHERE slot=? AND event IN ('begin','take','first_action','start') "
                                    "ORDER BY id DESC LIMIT 1", (row["slot"],)).fetchone()
            if phase and phase["event"] in ("begin", "take"):
                self.record(row["slot"], "first_start", 1, max(0, now - phase["at"]))
            self.record(row["slot"], "start", 1, None if inline else max(0, now - arrived))
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

    def finish(self, row):
        self.record(row["slot"], "finish", len(json.loads(row["started_json"])))
        self.db.execute("DELETE FROM slots WHERE ticket=?", (row["ticket"],))
        return {"released": True}

    def after_reply(self, ticket):
        row = self.require(ticket, "working")
        pending = self.pending_keys(row)
        if not pending:
            return self.finish(row)
        return {"channel": self.channel, "ticket": ticket, "slot": row["slot"], "pending": pending}

    def recover_item(self, ticket, key, error):
        # An expired first message does not invalidate its still-live siblings. The
        # failed publish has rolled back; advance only the exact ticket/key in a new transaction.
        with self.writing():
            row = self.require(ticket, "preview", "working")
            pending = self.pending_keys(row)
            if key not in json.loads(row["keys_json"]) or key in pending:
                raise error
            if not pending:
                assignment = self.finish(row)
            elif row["phase"] == "preview":
                assignment = self.begin(ticket)
                if not assignment["pending"]:
                    assignment["released"] = True
            else:
                started = [k for k in json.loads(row["started_json"]) if k in pending]
                self.db.execute("UPDATE slots SET until_ms=?,started_json=? WHERE ticket=?",
                                (milliseconds() + self.work_ms, json.dumps(started), ticket))
                assignment = {"channel": self.channel, "ticket": ticket, "slot": row["slot"], "pending": pending}
        return self.with_first({**assignment, "unavailable": key})

    def start_media(self, ticket, key):
        with self.writing():
            self.start(ticket, key, inline=True)
            row = self.require(ticket, "working")
            item = self.check_key(row, key)
        # File work and TTS run after committing the claim, leaving other slots free.
        seconds = (min(item[2], row["until_ms"]) - milliseconds()) / 1000 - 1
        if seconds <= 0:
            raise Unavailable("item_unavailable")
        return seconds

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
    validate_answer(channel, key, json.loads(raw))
    return raw


def validate_answer(channel, key, body):
    if not isinstance(body, dict) or body.get("requestKey") != key:
        raise ValueError("wrong_request_key")
    if channel == "qq" and set(body) == {"requestKey", "skip"} and body["skip"] is True:
        return
    media = [field for field in ("audioPath", "imagePath") if field in body]
    if (channel == "desktop" and media) or len(media) > 1:
        raise ValueError("unsupported_attachment")
    if media and (not isinstance(body[media[0]], str) or not os.path.isabs(body[media[0]])):
        raise ValueError("invalid_attachment_path")
    extra = {"mentionSenderId"} if channel == "qq" else set()
    if set(body) - {"requestKey", "text", *media, *extra}:
        raise ValueError("unexpected_reply_fields")
    text = body.get("text")
    limit = 1600 if channel == "qq" else 12_000
    if "text" in body or not media:
        if not isinstance(text, str) or not 0 < len(text.strip()) <= limit:
            raise ValueError("invalid_reply_text")
    if "mentionSenderId" in body:
        sender_id = body["mentionSenderId"]
        if (not isinstance(text, str) or not text.strip() or not isinstance(sender_id, str)
                or re.fullmatch(r"[0-9a-f]{64}", sender_id) is None):
            raise ValueError("invalid_mention_sender_id")


def reply(queue, args):
    body = {"requestKey": args.key}
    if args.skip:
        body["skip"] = True
    if args.mention:
        if args.skip or args.voice or (args.image and not args.caption):
            raise ValueError("mention_requires_text")
        body["mentionSenderId"] = args.mention
    if not (args.skip or args.image) or args.caption:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError("invalid_reply_text")
        body["text"] = raw.decode("utf-8").strip()
    media_path = None
    if args.voice or args.image:
        from qq_media import prepare_image, synthesize_voice
        seconds = queue.start_media(args.ticket, args.key)
        if args.voice:
            validate_answer("qq", args.key, body)
            media_path = synthesize_voice(queue.bridge, body.pop("text"), args.voice, min(seconds, 60))
            body["audioPath"] = str(media_path)
        else:
            media_path = prepare_image(queue.bridge, args.image)
            body["imagePath"] = str(media_path)
    try:
        validate_answer("qq", args.key, body)
        with queue.writing():
            if media_path is None:
                queue.start(args.ticket, args.key, inline=True)
            published = queue.publish(args.ticket, args.key, json_bytes(body))
            assignment = queue.after_reply(args.ticket)
    except BaseException:
        if media_path is not None and args.voice:
            # A link to outbox can survive a later SQLite or directory-sync failure.
            try:
                written = object_at(queue.outbox / (args.key + ".json"))
            except FileNotFoundError:
                written = {}
            except (OSError, ValueError):
                written = body
            if str(media_path) != written.get("audioPath"):
                media_path.unlink(missing_ok=True)
        raise
    if args.remember:
        from qq_media import remember_gallery
        try:
            remember_gallery(queue.bridge, args.image, args.remember, snapshot=media_path)
            published["gallerySaved"] = True
        except (OSError, RuntimeError, ValueError, sqlite3.Error):
            published["gallerySaved"] = False
    return queue.with_first({**published, **assignment})


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
        timings = {"offer": "inboxToOfferMs", "begin": "offerToBeginMs", "first_action": "offerToFirstActionMs",
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
    for name in ("offer", "begin", "take", "start", "renew", "publish", "reply", "images", "finish", "adopt-legacy", "status"):
        sub = commands.add_parser(name)
        sub.add_argument("channel", choices=("qq",) if name in ("reply", "images") else ("qq", "desktop"))
        if name in ("offer", "take"):
            sub.add_argument("slot", type=int, choices=(1, 2, 3))
        elif name not in ("adopt-legacy", "status"):
            sub.add_argument("ticket")
        if name in ("start", "publish", "reply", "images"):
            sub.add_argument("key")
        if name == "offer":
            sub.add_argument("--wait", type=int, choices=range(61), metavar="0..60", default=0)
            sub.add_argument("--with-context", action="store_true", help="include the first QQ question in the wake")
        if name in ("begin", "take"):
            sub.add_argument("--read-first", action="store_true", help="claim and return the first QQ message")
        if name == "reply":
            media = sub.add_mutually_exclusive_group()
            media.add_argument("--voice", choices=("lily", "mature"), help="synthesize the words on stdin")
            media.add_argument("--image", type=Path, help="send a verified local image")
            media.add_argument("--skip", action="store_true")
            sub.add_argument("--caption", action="store_true", help="read an image caption from stdin")
            sub.add_argument("--mention", metavar="SENDER_ID", help="mention one known member of this QQ group")
            sub.add_argument("--remember", metavar="DESCRIPTION", help="index the reviewed gallery image after publication")
    args = parser.parse_args()
    read_first = getattr(args, "read_first", False)
    preview = getattr(args, "with_context", False)
    if (read_first or preview) and args.channel != "qq":
        parser.error("inline questions require the QQ channel")
    if (getattr(args, "caption", False) or getattr(args, "remember", None) is not None) and not args.image:
        parser.error("--caption and --remember require --image")
    os.umask(0o077)
    if args.command == "status":
        print(json.dumps(status(args.channel)))
        return
    queue = Queue(args.channel)
    try:
        # Read the producer pipe before locking; slow generation must not stall other slots.
        body = answer_from_stdin(args.channel, args.key) if args.command == "publish" else None
        if args.command == "offer":
            result = queue.offer(args.slot, args.wait, preview)
        elif args.command == "reply":
            result = reply(queue, args)
        elif args.command == "images":
            from qq_incoming import incoming_images
            seconds = queue.start_media(args.ticket, args.key)
            item = object_at(queue.inbox / (args.key + ".json"))
            result = {"images": incoming_images(queue.bridge, args.key, item.get("attachments") or [], min(seconds, 20))}
            queue.check_key(queue.require(args.ticket, "working"), args.key)
        else:
            candidates = queue.candidates() if args.command == "take" else None
            with queue.writing():
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
                        result = queue.finish(row)
                    else:
                        queue.db.execute("UPDATE slots SET until_ms=? WHERE ticket=?",
                                         (milliseconds() + queue.work_ms, args.ticket))
                        result = {"renewed": True}
                if read_first and result["pending"]:
                    queue.start(result["ticket"], result["pending"][0])
            if read_first:
                result = queue.with_first(result)
    except Unavailable as error:
        if args.channel != "qq" or args.command not in ("start", "reply", "images"):
            raise
        result = queue.recover_item(args.ticket, args.key, error)
    finally:
        queue.db.close()
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (Unavailable, ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        sys.exit(str(error))
