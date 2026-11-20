#!/usr/bin/env python3
"""Muse VM: collect one channel continuously, independently of chat turns and sending."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError

from bridge_delivery import (FALLBACK_GRACE_MS, call_gateway, load_client,
                             publish_new_inbox, queue_expired_fallback, read_delivery,
                             rejected_as_expired, repair_receipt, reply_deadline, retry_floor)
from bridge_watch import wait_for_work, watch_directories


ROOT = Path.home()
KEY = re.compile(r"[A-Za-z0-9_-]{1,160}")


def ms():
    return time.time_ns() // 1_000_000


def save(path, data):
    fd, name = tempfile.mkstemp(prefix=".bridge-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def read(path):
    with path.open(encoding="utf-8") as source:
        return json.load(source)


class InboxRejected(Exception):
    def __init__(self, status, code, retry_ms):
        super().__init__(f"HTTP {status}" + (f" {code}" if code else ""))
        self.retry_seconds = retry_ms / 1000


def board_forever(stopping):
    from board_aggregate import refresh
    while not stopping.is_set():
        try:
            refresh(min_age_ms=2500)
        except Exception as error:
            print(f"board: {type(error).__name__}", file=sys.stderr, flush=True)
        stopping.wait(3)


def update_probe():
    from pipeline_signals import probe_cache_path, probe_relay, publish_probe
    if os.environ.get("HUIYU_BOARD_PROBE_FILE") or os.environ.get("MUSE_PROBE_EXTERNAL") == "1":
        return  # The site already has its own probe writer.
    cache = Path(probe_cache_path())
    with (cache.parent / ".connection-probe.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            stamp = read(cache).get("observedAt")
        except (OSError, AttributeError, ValueError):
            stamp = None
        if type(stamp) is int and 0 <= ms() - stamp < 30_000:
            return

        def get_json(path):
            status, data, _ = call_gateway(load_client(), "GET", path, timeout=5)
            if status != 200:
                raise HTTPError(path, status, "relay probe", {}, None)
            return data
        try:
            sample = probe_relay(get_json)
        except Exception:
            sample = {"observedAt": ms(), "online": None, "lastSeenAt": None, "reason": "transport_error"}
        publish_probe(sample)


class Bridge:
    def __init__(self, channel):
        self.channel = channel
        self.stopping = threading.Event()
        self.bridge = ROOT / "workspace" / (channel + "-bridge")
        self.state = ROOT / "hooks/state" / (channel + "-bridge")
        self.inbox = self.bridge / "inbox"
        self.spools = [self.bridge / "outbox"]
        if channel == "qq":
            self.spools.append(self.bridge / "sendbox")
        for directory in [self.state, self.inbox, self.bridge / "claimed", *self.spools]:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)

    def collect(self, client):
        path = f"/api/muse/{self.channel}/inbox?wait=25"
        status = None
        ok = False
        added = 0
        reason = "transport"
        try:
            status, response, headers = call_gateway(client, "GET", path, timeout=45)
            reason = "http" if status != 200 else "protocol"
            if status != 200:
                error = response if isinstance(response, dict) else {}
                code = error.get("code")
                if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9_]{1,96}", code):
                    code = None
                raise InboxRejected(status, code, retry_floor(error, headers))
            if not isinstance(response, dict) or response.get("ok") is not True:
                raise ValueError("unexpected inbox")
            items = response.get("items")
            if not isinstance(items, list):
                raise ValueError("malformed inbox")
            received_at = ms()
            server_now = response.get("serverNow")
            problem = None
            for item in items:
                key = item.get("requestKey") if isinstance(item, dict) else None
                if (not isinstance(key, str) or not KEY.fullmatch(key)
                        or type(item.get("expiresAt")) is not int
                        or not isinstance(item.get("conversationId"), str) or not item["conversationId"]):
                    problem = "protocol"
                    continue
                if type(server_now) is int and server_now > 0:
                    # Keep the wire deadline for identity; compare on the VM's own clock.
                    item = {**item, "localExpiresAt": received_at + item["expiresAt"] - server_now}
                if reply_deadline(item) <= received_at:
                    continue
                destination = self.inbox / (key + ".json")
                try:
                    if not destination.exists():
                        if publish_new_inbox(self.bridge, item):
                            added += 1
                        elif not destination.exists():
                            problem = "spool"
                except (OSError, ValueError):
                    problem = "spool"
            if problem:
                reason = problem
            else:
                ok = True
            return bool(items), added
        finally:
            save(self.state / "last-poll.json",
                 {"completedAt": ms(), "ok": ok, "httpStatus": status if type(status) is int else None,
                  "reason": None if ok else reason})

    def receive_forever(self):
        failures = 0
        client = None
        while not self.stopping.is_set():
            try:
                client = client or load_client()
                repeated, added = self.collect(client)
                failures = 0
                # Some gateways immediately list outstanding turns until their reply.
                if repeated and not added:
                    self.stopping.wait(1)
            except Exception as error:
                detail = str(error) if isinstance(error, InboxRejected) else type(error).__name__
                print(f"intake {self.channel}: {detail}", file=sys.stderr, flush=True)
                failures += 1
                delay = min(20, 2 ** min(failures - 1, 5))
                self.stopping.wait(max(delay, error.retry_seconds if isinstance(error, InboxRejected) else 0))

    def maintain(self):
        # Ancillary reads never delay fetching, claiming or sending a message.
        recheck_targets = 0
        while not self.stopping.is_set():
            try:
                update_probe()
                if self.channel == "qq" and time.monotonic() >= recheck_targets:
                    recheck_targets = time.monotonic() + 60
                    status, data, _ = call_gateway(load_client(), "GET", "/api/muse/qq/targets", timeout=10)
                    if status == 200 and isinstance(data, dict) and data.get("targets"):
                        file = self.bridge / "targets.json"
                        if not file.exists() or read(file) != data:
                            save(file, data)
                    recheck_targets = time.monotonic() + 300
            except Exception as error:
                print(f"maintenance {self.channel}: {type(error).__name__}", file=sys.stderr, flush=True)
            self.stopping.wait(5)

    def update_pool(self):
        # Keep the VM's installed memory-pool implementation and its own write lock.
        # The receiver and sender already recover through the independent hooks.
        paths = [self.inbox, self.state, *self.spools]
        script = self.bridge / "pool.py"
        while not self.stopping.is_set():
            try:
                with watch_directories(paths) as fd:
                    if script.is_file():
                        subprocess.run([sys.executable, str(script), "sync"], timeout=60,
                                       stdout=subprocess.DEVNULL, check=True)
                    wait_for_work(fd, 60, ignore_names=(b"last-poll.json",))
                self.stopping.wait(0.5)
            except (OSError, subprocess.SubprocessError) as error:
                print(f"pool: {type(error).__name__}", file=sys.stderr, flush=True)
                self.stopping.wait(5)

    def next_ship(self, path, via):
        key = path.stem
        if not KEY.fullmatch(key):
            return
        marker = self.state / (("sent-send-" if via == "send" else "sent-") + key)
        if marker.exists():
            return
        end_marker = self.state / (("fallback-" if self.channel == "qq" else "lost-") + key)
        if via == "reply" and end_marker.exists():
            return
        info = read_delivery(self.bridge, key) or {}
        if info.get("via") not in (None, via):
            return
        receipt = info.get("receipt") or {}
        if via == "send":
            allowed = ("sent",)
        elif self.channel == "qq":
            allowed = ("sent", "skipped")
        else:
            allowed = ("accepted",)
        if receipt.get("status") in allowed and receipt.get("via", via) == via:
            if repair_receipt(self.bridge, key, via):
                marker.touch(exist_ok=True)
            return
        if info.get("phase") == "fallback" and via == "reply":
            end_marker.touch(exist_ok=True)
            return
        if info.get("phase") in ("posting", "marked_done"):
            return
        if via == "reply":
            incoming = read(self.inbox / path.name)
            deadline = reply_deadline(incoming)
            if type(deadline) is not int or deadline <= 0:
                return
            now = ms()
            gateway_expired = rejected_as_expired(info)
            if now >= deadline or gateway_expired:
                if self.channel == "qq":
                    if (info.get("newInbox") and not info.get("maybeSent")
                            and info.get("phase") in ("ready", "expired")
                            and (info.get("attempts") == 0 or gateway_expired)
                            and (now <= deadline + FALLBACK_GRACE_MS or info.get("fallbackKey"))
                            and queue_expired_fallback(self.bridge, key)):
                        end_marker.touch(exist_ok=True)
                elif (info.get("newInbox") is True and info.get("attempts") == 0
                      and info.get("phase") not in ("uncertain", "retry")):
                    end_marker.touch(exist_ok=True)
                return
        else:
            deadline = float("inf")
        if info.get("phase") in ("uncertain", "rejected", "expired", "exhausted", "confirmed"):
            return
        if (info.get("nextAttemptAt") or 0) > ms():
            return
        return deadline

    def ship_one(self, path, via):
        result = subprocess.run(
            [sys.executable, str(self.bridge / "ship_relay.py"),
             f"/api/muse/{self.channel}/{via}", str(path)],
             stdout=subprocess.DEVNULL, timeout=100, check=False)
        # The next scan validates and repairs the original receipt and markers.
        if result.returncode != 0:
            print(f"ship {self.channel}: exit {result.returncode}", file=sys.stderr, flush=True)

    def ship_forever(self):
        limit = 3 if self.channel == "qq" else 1
        pending = {}
        with ThreadPoolExecutor(max_workers=limit) as senders:
            while not self.stopping.is_set():
                try:
                    with watch_directories(self.spools) as fd:
                        for file, future in list(pending.items()):
                            if future.done():
                                del pending[file]
                                try:
                                    future.result()
                                except (OSError, subprocess.SubprocessError) as error:
                                    print(f"ship {self.channel}: {type(error).__name__}", file=sys.stderr, flush=True)
                        free = limit - len(pending)
                        if free:
                            candidates = []
                            for spool in self.spools:
                                via = "send" if spool.name == "sendbox" else "reply"
                                for file in spool.glob("*.json"):
                                    if self.stopping.is_set():
                                        return
                                    if file in pending:
                                        continue
                                    try:
                                        deadline = self.next_ship(file, via)
                                        if deadline is not None:
                                            candidates.append((deadline, file, via))
                                    except (OSError, ValueError) as error:
                                        print(f"ship {self.channel}: {type(error).__name__}", file=sys.stderr, flush=True)
                            for _, file, via in sorted(candidates)[:free]:
                                pending[file] = senders.submit(self.ship_one, file, via)
                        wait_for_work(fd, 0.5 if pending else 2)
                except Exception as error:
                    print(f"ship scan {self.channel}: {type(error).__name__}", file=sys.stderr, flush=True)
                    self.stopping.wait(2)

    def watch_drain(self, generation):
        path = self.state / "receiver-drain.json"
        while not self.stopping.wait(1):
            try:
                if path.is_file() and read(path).get("generation") == generation:
                    self.stopping.set()
            except (OSError, ValueError, AttributeError):
                continue

    def drain(self):
        # Disable worker hooks / stop an external supervisor first. Never signal a
        # recycled PID; only the current generation recognizes this request.
        with (self.state / "start.lock").open("a") as starter, (self.state / "poll.lock").open("a") as lock:
            fcntl.flock(starter, fcntl.LOCK_EX)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return
            except BlockingIOError:
                generation = read(self.state / "receiver-generation.json")["generation"]
            save(self.state / "receiver-drain.json", {"generation": generation})
            deadline = time.monotonic() + 125
            while time.monotonic() < deadline:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return
                except BlockingIOError:
                    time.sleep(0.25)
            raise RuntimeError("receiver still active; inspect its service before replacing it")

    def serve(self, ready_fd=None):
        with (self.state / "poll.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                if ready_fd is not None:
                    os.close(ready_fd)
                return
            generation = uuid.uuid4().hex
            save(self.state / "receiver-generation.json", {"generation": generation})
            signal.signal(signal.SIGTERM, lambda *_: self.stopping.set())
            if ready_fd is not None:
                os.write(ready_fd, b"1")
                os.close(ready_fd)
            sender = threading.Thread(target=self.ship_forever)
            sender.start()
            jobs = [self.maintain, lambda: board_forever(self.stopping), lambda: self.watch_drain(generation)]
            if self.channel == "qq":
                jobs.append(self.update_pool)
            for job in jobs:
                threading.Thread(target=job, daemon=True).start()
            try:
                self.receive_forever()
            finally:
                self.stopping.set()
                sender.join()

    def ensure(self):
        # Concurrent Hatch callbacks share a single receiver. In supervised installs
        # the foreground service already owns poll.lock and the hook only reads it.
        import select
        with (self.state / "start.lock").open("a") as starter:
            fcntl.flock(starter, fcntl.LOCK_EX)
            with (self.state / "poll.lock").open("a") as probe:
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return
            rd, wr = os.pipe()
            try:
                with (self.state / "relay.log").open("ab") as log:
                    subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "serve",
                                      self.channel, "--ready-fd", str(wr)],
                                     start_new_session=True, pass_fds=(wr,), stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log)
            finally:
                os.close(wr)
            try:
                if not select.select([rd], [], [], 4)[0] or os.read(rd, 1) != b"1":
                    # A supervisor may have won the race. Verify the actual lock.
                    with (self.state / "poll.lock").open("a") as probe:
                        try:
                            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        except BlockingIOError:
                            return
                        raise RuntimeError("receiver did not acquire poll.lock")
            finally:
                os.close(rd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("serve", "ensure", "drain"))
    parser.add_argument("channel", choices=("qq", "desktop"))
    parser.add_argument("--ready-fd", type=int)
    args = parser.parse_args()
    if os.environ.get("HATCH_HOOK_DRY_RUN") == "1":
        sys.exit(0)
    os.umask(0o077)
    bridge = Bridge(args.channel)
    if args.action == "serve":
        bridge.serve(args.ready_fd)
    elif args.action == "drain":
        bridge.drain()
    else:
        bridge.ensure()
