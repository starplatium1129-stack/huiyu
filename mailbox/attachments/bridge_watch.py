#!/usr/bin/env python3
"""Run an existing one-shot bridge command when a Linux spool changes."""
import argparse
import ctypes
import errno
import fcntl
import os
import select
import struct
import subprocess
import sys
import time
from contextlib import contextmanager


# linux/inotify.h. Each event is followed by a NUL-padded filename.
EVENT = struct.Struct("=iIII")
CLOSE_WRITE = 0x00000008
MOVED_TO = 0x00000080
DELETE_SELF = 0x00000400
MOVE_SELF = 0x00000800
UNMOUNT = 0x00002000
OVERFLOW = 0x00004000
IGNORED = 0x00008000
IS_DIR = 0x40000000
RESET = DELETE_SELF | MOVE_SELF | UNMOUNT | OVERFLOW | IGNORED


@contextmanager
def watch_directories(paths):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.inotify_init1.argtypes = [ctypes.c_int]
    libc.inotify_init1.restype = ctypes.c_int
    libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
    libc.inotify_add_watch.restype = ctypes.c_int
    fd = libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
    if fd < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
    try:
        for path in paths:
            mask = CLOSE_WRITE | MOVED_TO | DELETE_SELF | MOVE_SELF
            if libc.inotify_add_watch(fd, os.fsencode(path), mask) < 0:
                err = ctypes.get_errno()
                if err != errno.ENOENT:
                    raise OSError(err, os.strerror(err), path)
                # A bridge can create a spool on first use. Retry on reconciliation.
        yield fd
    finally:
        os.close(fd)


def wait_for_work(fd, interval):
    deadline = time.monotonic() + interval
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            return
        data = os.read(fd, 65536)
        offset = 0
        while offset < len(data):
            _, mask, _, length = EVENT.unpack_from(data, offset)
            offset += EVENT.size
            name = data[offset:offset + length].rstrip(b"\0")
            offset += length
            if mask & RESET:
                return
            if not (mask & IS_DIR) and (name.endswith(b".json") or name.startswith(b"sent-")):
                return


def run(args, command):
    # Separate lock paths for the desktop sender, QQ sender and memory task.
    with open(args.lock, "a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.exit("bridge_watch: this job already has a runner")
        backoff = 1
        while True:
            # Subscribe before scanning. A write during the command wakes the next scan.
            with watch_directories(args.watch) as fd:
                result = subprocess.run(command, pass_fds=(lock.fileno(),))
                if result.returncode == 0:
                    backoff = 1
                    wait_for_work(fd, args.reconcile)
                else:
                    print(f"bridge_watch: command exited {result.returncode}, retry in {backoff}s",
                          file=sys.stderr, flush=True)
                    time.sleep(backoff)
                    backoff = min(30, backoff * 2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--watch", action="append", required=True, metavar="DIR")
    parser.add_argument("--lock", required=True, help="per-job lock file in an existing private directory")
    parser.add_argument("--reconcile", type=int, default=15, metavar="SECONDS")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="-- existing one-shot command and its arguments")
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or args.reconcile < 1:
        parser.error("provide a command after -- and a positive reconciliation interval")
    try:
        run(args, command)
    except KeyboardInterrupt:
        pass
    except OSError as error:
        sys.exit(f"bridge_watch: {error}")
