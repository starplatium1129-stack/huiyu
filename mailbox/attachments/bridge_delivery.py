"""Local Linux sender state for the Muse bridges. Install in ~/workspace/bridge-tools."""
import base64
import fcntl
import hashlib
import importlib.util
import json
import math
import os
import random
import re
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from email.utils import parsedate_to_datetime
from functools import lru_cache
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError

CLIENT = Path.home() / "workspace/custom-connectors/custom.huiyu-relay-main/bin/client.py"
ROUTES = {
    ("qq", "/api/muse/qq/reply"): "reply",
    ("qq", "/api/muse/qq/send"): "send",
    ("desktop", "/api/muse/desktop/reply"): "reply",
}
MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".mp3": "audio/mpeg"}
MAX_MEDIA = 3 * 1024 * 1024
MAX_ATTEMPTS = 5
BACKOFF = (2, 5, 10, 20)
TERMINAL = {"confirmed", "marked_done", "uncertain", "expired", "rejected", "fallback"}


def now_ms():
    return time.time_ns() // 1_000_000


def key_ok(key):
    return isinstance(key, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,160}", key) is not None


def object_at(path):
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ValueError("invalid JSON object")
    return value


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish(path, value, *, replace=True):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".delivery-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            json.dump(value, target, ensure_ascii=False, allow_nan=False)
            target.flush()
            os.fsync(target.fileno())
        if replace:
            os.replace(tmp, path)
        else:
            os.link(tmp, path)
        sync_dir(path.parent)
    finally:
        Path(tmp).unlink(missing_ok=True)


def initialize(bridge):
    directory = bridge / "delivery"
    directory.mkdir(mode=0o700, exist_ok=True)
    marker = directory / ".cutover"
    if not marker.exists():
        with locked(directory / ".cutover.lock"):
            if not marker.exists():
                # Old writers are stopped at installation. Index their evidence once,
                # so a growing receipt log never makes the intake loop progressively slower.
                stamp = time.time_ns()
                index, damaged = legacy_index(bridge)
                had_spool = any(any((bridge / spool).glob("*.json")) for spool in ("inbox", "outbox", "sendbox"))
                had_logs = any((bridge / name).exists() for name in ("attempts.jsonl", "receipts.jsonl"))
                publish(marker, {"atNs": stamp, "legacy": index, "damagedRows": damaged,
                                 "priorBridge": had_spool or had_logs}, replace=False)
                sync_dir(bridge)
                if damaged:
                    print(f"bridge_delivery: {damaged} unreadable legacy rows in {bridge.name}", file=sys.stderr)
    return directory


@lru_cache(maxsize=2)
def cutover(bridge):
    return object_at(bridge / "delivery" / ".cutover")


@contextmanager
def locked(path, blocking=True):
    with path.open("a+b") as handle:
        mode = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
        fcntl.flock(handle, mode)
        yield


def state_at(path, key):
    try:
        state = object_at(path)
    except FileNotFoundError:
        return None
    if (state.get("key") != key or state.get("via") not in ("send", "reply")
            or state.get("phase") not in TERMINAL | {"ready", "posting", "retry"}
            or type(state.get("attempts")) is not int or not 0 <= state["attempts"] <= MAX_ATTEMPTS):
        raise ValueError("invalid delivery state")
    if state["phase"] in ("retry", "posting", "confirmed") and (
            state["attempts"] < 1 or not isinstance(state.get("digest"), str)):
        raise ValueError("missing original POST")
    return state


def read_delivery(bridge, key):
    """Read one committed sender snapshot. An unlocked old posting record has no live POST."""
    if not key_ok(key):
        return None
    directory = Path(bridge) / "delivery"
    path = directory / (key + ".json")
    state = state_at(path, key)
    if state and state["phase"] in ("ready", "retry") and 0 < state.get("expiresAt", 0) <= now_ms():
        return {**state, "phase": expiry_phase(state)}
    if not state or state["phase"] != "posting":
        return state
    try:
        with (directory / (key + ".post.lock")).open("rb") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                return state_at(path, key)
            state = state_at(path, key)
    except FileNotFoundError:
        pass
    if state and state["phase"] == "posting":
        return {**state, "phase": "uncertain", "code": "INTERRUPTED_POST"}
    return state


def expiry_phase(state):
    untracked = state["via"] == "reply" and not state.get("newInbox")
    return "uncertain" if untracked or state.get("maybeSent") else "expired"


def legacy_index(bridge):
    index = {}
    damaged = 0
    for filename in ("attempts.jsonl", "receipts.jsonl"):
        try:
            source = (bridge / filename).open("rb")
        except FileNotFoundError:
            continue
        with source:
            for line in source:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except (UnicodeDecodeError, ValueError, RecursionError):
                    row = None
                key = row.get("key") if isinstance(row, dict) else None
                if not key_ok(key):
                    # Existing writers use plain ASCII keys. A torn suffix can still
                    # identify a key to hold, but can never prove a successful receipt.
                    damaged += 1
                    for candidate in re.findall(rb'"key"\s*:\s*"([A-Za-z0-9_-]{1,160})"', line):
                        index.setdefault(candidate.decode("ascii"), {"attempts": 0, "phase": "uncertain"})
                    continue
                record = index.setdefault(key, {"attempts": 0, "phase": "uncertain"})
                if row.get("posted") is True:
                    record["attempts"] = min(MAX_ATTEMPTS, record["attempts"] + 1)
                if filename == "receipts.jsonl" or row.get("cls") == "success":
                    record["phase"] = "marked_done"
    return index, damaged


def initial(bridge, key, via):
    state = {"key": key, "via": via, "phase": "ready", "attempts": 0}
    prior = cutover(bridge)["legacy"].get(key)
    markers = Path.home() / "hooks/state" / bridge.name
    present = any((markers / (prefix + key)).exists()
                  for prefix in ("sent-", "sent-send-", "lost-", "fallback-"))
    if prior or present:
        # Legacy POST records have no request fingerprint, and old desktop "sent"
        # could mean HTTP 200 without the protocol receipt. Never re-POST these.
        if prior:
            state.update(prior)
        if present:
            state["phase"] = "marked_done"
        state["code"] = "LEGACY_DELIVERY"
    return state


def publish_new_inbox(bridge, item):
    """Journal provenance first; a crash before inbox publication can resume on the next fetch."""
    bridge = Path(bridge)
    key = item.get("requestKey")
    if not key_ok(key):
        raise ValueError("invalid key")
    directory = initialize(bridge)
    path = directory / (key + ".json")
    target = bridge / "inbox" / (key + ".json")
    identity = digest([item["conversationId"], item["expiresAt"]])
    with locked(directory / (key + ".lock")):
        if target.exists():
            return False
        state = state_at(path, key)
        if state is None:
            state = initial(bridge, key, "reply")
            previous = cutover(bridge)
            if state["phase"] == "ready":
                # A missing old inbox may be re-listed by the gateway. Its actual
                # acceptance window started before cutover even if we receive it now.
                window_ms = 150_000 if bridge.name == "desktop-bridge" else (
                    300_000 if item.get("scope") == "group" else 3_600_000)
                started = item["expiresAt"] - window_ms
                prior_bridge = previous.get("priorBridge", bool(previous["legacy"]))
                possible_replay = prior_bridge and started <= previous["atNs"] // 1_000_000
                if possible_replay or (bridge / "outbox" / target.name).exists():
                    state.update(phase="uncertain", code="LEGACY_REPLAY")
            state["newInbox"] = state["phase"] == "ready"
            state["inboxIdentity"] = identity
            state["expiresAt"] = item["expiresAt"]
            publish(path, state)
        if state.get("inboxIdentity") != identity or state["via"] != "reply" or state["phase"] != "ready":
            return False
        publish(target, item, replace=False)
        return True


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def prepare(channel, via, payload):
    body = dict(payload)
    if channel == "desktop":
        if (set(body) != {"requestKey", "text"} or not isinstance(body["text"], str)
                or not 1 <= len(body["text"].strip()) <= 12000):
            raise ValueError("desktop requires 1 to 12000 characters")
        return body
    for media in ("image", "audio"):
        local = body.pop(media + "Path", None)
        if local is None:
            continue
        source = Path(local)
        mime = MIME.get(source.suffix.lower(), "")
        if not mime.startswith(media + "/") or media in body:
            raise ValueError("unsupported attachment")
        with source.open("rb") as handle:
            data = handle.read(MAX_MEDIA + 1)
        if not 0 < len(data) <= MAX_MEDIA:
            raise ValueError("invalid attachment size")
        body[media] = {"mimeType": mime, "data": base64.b64encode(data).decode("ascii")}
    if body.get("skip") is True:
        if via != "reply" or set(body) != {"requestKey", "skip"}:
            raise ValueError("invalid skip")
        return body
    fields = set(body) - {"requestKey", "conversationId"}
    if (not fields or fields - {"image", "audio", "text"} or {"image", "audio"} <= fields
            or (via == "send" and (len(fields) != 1 or not body.get("conversationId")))
            or (via == "reply" and "conversationId" in body)):
        raise ValueError("invalid QQ payload")
    if "text" in body:
        text = body["text"]
        if (not isinstance(text, str) or not text.strip()
                or len(text if via == "send" else text.strip()) > 1600):
            raise ValueError("invalid QQ text")
    return body


def expires(bridge, key):
    item = object_at(bridge / "inbox" / (key + ".json"))
    if item.get("requestKey") != key or type(item.get("expiresAt")) is not int or item["expiresAt"] <= 0:
        raise ValueError("invalid reply window")
    return item["expiresAt"]


def retry_floor(data, headers):
    waits = []
    for field, unit in (("retryAfterMs", 1), ("retry_after_ms", 1),
                        ("retryAfterSeconds", 1000), ("retry_after_seconds", 1000),
                        ("retryAfter", 1000), ("retry_after", 1000)):
        value = data.get(field)
        if type(value) in (float, int) and math.isfinite(value) and value > 0:
            waits.append(math.ceil(value * unit))
    pairs = headers.items() if hasattr(headers, "items") else ()
    header = next((value for name, value in pairs if str(name).lower() == "retry-after"), None)
    if isinstance(header, str):
        if header.strip().isdigit():
            waits.append(int(header) * 1000)
        else:
            try:
                waits.append(math.ceil(parsedate_to_datetime(header).timestamp() * 1000) - now_ms())
            except (OverflowError, TypeError, ValueError):
                pass
    return max([0, *waits])


def load_client():
    spec = importlib.util.spec_from_file_location("huiyu_relay_main", CLIENT)
    client = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client)
    return client


def call_gateway(client, method, route, *args, timeout):
    """Normalize the connector's (HTTP status, JSON[, headers]) or urllib HTTPError."""
    try:
        response = client.call_json(method, route, *args, timeout=timeout)
    except HTTPError as error:
        with error:
            try:
                data = json.loads(error.read(65536))
            except (ValueError, OSError, HTTPException, RecursionError):
                data = {}
        return int(error.code), data, error.headers
    if len(response) == 2:
        status, data = response
        headers = None
    else:
        status, data, headers = response
    if not isinstance(status, int) or not 100 <= status <= 599:
        raise ValueError("invalid HTTP status")
    return int(status), data, headers


def outcome(state, channel, via, body, http, data, headers):
    stamp = now_ms()
    data = data if isinstance(data, dict) else {}
    code = data.get("code")
    if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9_]{1,96}", code):
        code = None
    status = data.get("status")
    expected = "accepted" if channel == "desktop" else ("skipped" if body.get("skip") is True else "sent")
    state.update(at=stamp, httpStatus=http, code=code, nextAttemptAt=None)
    if (http == 200 and data.get("ok") is True and not code and status == expected
            and data.get("requestKey") == state["key"]
            and (via != "send" or data.get("conversationId") == body["conversationId"])):
        state.update(phase="confirmed", receipt={"key": state["key"], "via": via, "at": stamp, "status": status})
        return
    multipart_reply = via == "reply" and "text" in body and ("image" in body or "audio" in body)
    ambiguous = state.get("maybeSent", False) or multipart_reply
    if code in ("QQ_MUSE_SEND_UNCERTAIN", "QQ_AUDIT_PENDING"):
        state.update(phase="uncertain", maybeSent=True)
        return
    if http == 410:
        state["phase"] = "uncertain" if ambiguous else "expired"
        return
    preparing = code == "QQ_MUSE_SEND_PENDING" and channel == "qq" and via == "send"
    transient = http is None or http in (408, 429) or (http is not None and 500 <= http < 600) or preparing
    if not transient:
        state["phase"] = "uncertain" if ambiguous or (http is not None and 200 <= http < 300) else "rejected"
        return
    state["maybeSent"] = ambiguous or http is None or http == 408 or http >= 500
    if state["attempts"] >= MAX_ATTEMPTS:
        state["phase"] = "uncertain" if state["maybeSent"] or preparing else "rejected"
        return
    wait = BACKOFF[state["attempts"] - 1] * 1000 + random.randint(0, 300)
    state.update(phase="retry", nextAttemptAt=stamp + max(wait, retry_floor(data, headers)))


def stdout_status(state, channel):
    receipt = state.get("receipt")
    if state["phase"] == "confirmed" and receipt:
        return "sent" if channel == "desktop" else receipt["status"]
    http = state.get("httpStatus")
    return "http_error:" + str(http) if type(http) is int and http >= 400 else "ship_error"


def mirror_receipt(bridge, receipt, *, recover):
    """Recover the log projection from the authoritative, already durable receipt."""
    with locked(bridge / "delivery" / ".receipts.lock"):
        log = bridge / "receipts.jsonl"
        with log.open("a+b") as stream:
            if recover:
                stream.seek(0)
                for line in stream:
                    try:
                        row = json.loads(line)
                    except (UnicodeDecodeError, ValueError):
                        continue
                    if isinstance(row, dict) and all(row.get(k) == receipt[k] for k in ("key", "via", "status", "at")):
                        os.fsync(stream.fileno())
                        sync_dir(bridge)
                        return
            if stream.seek(0, os.SEEK_END) > 0:
                stream.seek(-1, os.SEEK_END)
                if stream.read(1) != b"\n":
                    stream.write(b"\n")
            stream.write(json.dumps(receipt, separators=(",", ":")).encode() + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        sync_dir(bridge)


def ensure_receipt(bridge, state, via, *, recover):
    if not state or state["phase"] != "confirmed" or state["via"] != via:
        return None
    receipt = state.get("receipt") or {}
    allowed = {
        ("desktop-bridge", "reply"): ("accepted",),
        ("qq-bridge", "reply"): ("sent", "skipped"),
        ("qq-bridge", "send"): ("sent",),
    }.get((bridge.name, via), ())
    if (receipt.get("status") not in allowed or receipt.get("key") != state["key"]
            or receipt.get("via") != via or type(receipt.get("at")) is not int):
        raise ValueError("invalid delivery receipt")
    if not state.get("receiptLogged"):
        mirror_receipt(bridge, receipt, recover=recover)
        state["receiptLogged"] = True
        publish(bridge / "delivery" / (state["key"] + ".json"), state)
    return receipt


def repair_receipt(bridge, key, via):
    """Repair a committed receipt even after a source attachment has been cleaned up."""
    bridge = Path(bridge)
    if not key_ok(key):
        return None
    directory = bridge / "delivery"
    with locked(directory / (key + ".lock"), blocking=False):
        return ensure_receipt(bridge, state_at(directory / (key + ".json"), key), via, recover=True)


def ship(channel, bridge, route, file):
    via = ROUTES[(channel, route)]
    source = object_at(file)
    key = source.get("requestKey")
    spool = "sendbox" if via == "send" else "outbox"
    parent = file.parent.resolve()
    expected = (bridge / spool).resolve()
    if not key_ok(key) or (parent == expected and file.name != key + ".json"):
        raise ValueError("invalid spool key")
    if parent in ((bridge / "sendbox").resolve(), (bridge / "outbox").resolve()) and parent != expected:
        raise ValueError("wrong spool")
    if via == "send" and str(uuid.UUID(key)) != key:
        raise ValueError("proactive send needs canonical UUID")
    directory = initialize(bridge)
    path = directory / (key + ".json")
    with locked(directory / (key + ".lock"), blocking=False):
        state = state_at(path, key) or initial(bridge, key, via)
        if state["via"] != via:
            return "ship_error"
        if state["phase"] == "posting":
            state.update(phase="uncertain", code="INTERRUPTED_POST", at=now_ms())
            publish(path, state)
        if state["phase"] in TERMINAL - {"confirmed"}:
            if not path.exists():
                publish(path, state)
            return stdout_status(state, channel)
        if state["phase"] == "retry" and now_ms() < state["nextAttemptAt"]:
            return "ship_error"
        try:
            body = prepare(channel, via, source)
        except (ValueError, TypeError):
            if state["phase"] != "confirmed":
                state.update(phase="uncertain" if state["attempts"] else "rejected",
                             code="LOCAL_INVALID_PAYLOAD", at=now_ms())
                publish(path, state)
            return "ship_error"
        fingerprint = digest(body)
        if state.get("digest", fingerprint) != fingerprint:
            if state["phase"] != "confirmed":
                state.update(phase="uncertain", code="LOCAL_PAYLOAD_CHANGED", at=now_ms())
                publish(path, state)
            return "ship_error"
        if state["phase"] == "confirmed":
            ensure_receipt(bridge, state, via, recover=True)
            return stdout_status(state, channel)
        if state["attempts"] >= MAX_ATTEMPTS:
            return "ship_error"
        if via == "reply":
            deadline = expires(bridge, key)
            deadline = min(deadline, state.get("expiresAt", deadline))
        else:
            # The QQ proactive idempotency record is retained for about 24 hours.
            deadline = state.get("firstPostAt", now_ms()) + 23 * 3600_000
        if now_ms() >= deadline:
            state.update(phase=expiry_phase(state), at=now_ms())
            publish(path, state)
            return "ship_error"
        if not state.get("newInbox") and not state.get("attempts"):
            # Older advisory ledgers cannot prove an old, unmarked payload was never sent.
            # A post-cutover proactive file is new, while inbox provenance is explicit.
            if via == "reply" or file.stat().st_mtime_ns <= cutover(bridge)["atNs"]:
                state.update(phase="uncertain", code="LEGACY_UNTRACKED", at=now_ms())
                publish(path, state)
                return "ship_error"
        client = load_client()
        with locked(directory / (key + ".post.lock")):
            stamp = now_ms()
            if stamp >= deadline:
                state.update(phase=expiry_phase(state), at=stamp)
                publish(path, state)
                return "ship_error"
            state.update(phase="posting", digest=fingerprint, attempts=state["attempts"] + 1,
                         firstPostAt=state.get("firstPostAt", stamp), lastPostAt=stamp, at=stamp,
                         expiresAt=deadline, code=None, httpStatus=None, nextAttemptAt=None)
            attempt = {"startedAt": stamp}
            state.setdefault("history", []).append(attempt)
            publish(path, state)
            try:
                http, data, headers = call_gateway(client, "POST", route, body, timeout=30 if channel == "desktop" else 60)
            except Exception:
                http, data, headers = None, {}, None
            outcome(state, channel, via, body, http, data, headers)
            attempt.update(completedAt=state["at"], phase=state["phase"], httpStatus=http, code=state["code"])
            publish(path, state)
        if state["phase"] == "confirmed":
            ensure_receipt(bridge, state, via, recover=False)
        return stdout_status(state, channel)


def queue_expired_fallback(bridge, key):
    """Convert only a proven never-posted new QQ answer, under the original sender lock."""
    bridge = Path(bridge)
    if bridge.name != "qq-bridge" or not key_ok(key):
        return None
    directory = initialize(bridge)
    path = directory / (key + ".json")
    with locked(directory / (key + ".lock"), blocking=False):
        state = state_at(path, key)
        if not state or state["via"] != "reply" or not state.get("newInbox") or state["attempts"] != 0:
            return None
        if state["phase"] == "fallback":
            return state["fallbackKey"]
        if state["phase"] not in ("expired", "ready") or now_ms() < expires(bridge, key):
            return None
        # Historical markers or receipts may have appeared since the item was fetched.
        if initial(bridge, key, "reply")["phase"] != "ready":
            return None
        item = object_at(bridge / "inbox" / (key + ".json"))
        destination = item.get("conversationId")
        if digest([destination, item["expiresAt"]]) != state.get("inboxIdentity"):
            return None
        raw = object_at(bridge / "outbox" / (key + ".json"))
        if raw.get("requestKey") != key or not isinstance(destination, str) or not destination or raw.get("skip"):
            return None
        reply = prepare("qq", "reply", raw)
        if len(reply) != 2:
            # QQ proactive sends allow text OR one attachment. Keep a combined reply intact.
            return None
        fallback_key = state.get("fallbackKey") or str(uuid.uuid4())
        body = {**reply, "requestKey": fallback_key, "conversationId": destination}
        fingerprint = digest(body)
        target = bridge / "sendbox" / (fallback_key + ".json")
        if "fallbackKey" not in state:
            if target.exists() or (directory / (fallback_key + ".json")).exists():
                return None
            state.update(phase="expired", fallbackKey=fallback_key, fallbackDigest=fingerprint)
            publish(path, state)
        elif state["fallbackDigest"] != fingerprint:
            return None
        try:
            publish(target, body, replace=False)
        except FileExistsError:
            if digest(object_at(target)) != fingerprint:
                return None
        state.update(phase="fallback", at=now_ms())
        publish(path, state)
        return fallback_key


def ship_cli(channel, bridge):
    if os.environ.get("HATCH_HOOK_DRY_RUN") == "1":
        print("ship_error")
        return
    try:
        result = ship(channel, bridge, sys.argv[1], Path(sys.argv[2]))
    except Exception as error:
        # The legacy QQ skip caller treats arbitrary stdout strings as success.
        print(f"ship_error:{type(error).__name__}", file=sys.stderr)
        result = "ship_error"
    print(result)


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] != "init":
        sys.exit("usage: bridge_delivery.py init <bridge-directory> ...")
    for argument in sys.argv[2:]:
        initialize(Path(argument))
