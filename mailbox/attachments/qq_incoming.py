"""Fetch the image attachments of one claimed QQ message for local viewing."""
from __future__ import annotations

import hashlib
import math
import os
import re
import select
import socket
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import getproxies_environment


MAX_BYTES = 8 * 1024 * 1024
DOMAINS = ("qq.com", "qq.com.cn", "qpic.cn", "qlogo.cn")


class ImageError(ValueError):
    pass


def cdn_url(url):
    if (not isinstance(url, str) or len(url.encode("utf-8")) > 4096 or "\\" in url
            or any(ord(char) <= 32 or ord(char) == 127 for char in url)):
        return False
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        return (parts.scheme in ("http", "https") and parts.username is None and parts.password is None
                and parts.port != 0 and any(host == domain or host.endswith("." + domain) for domain in DOMAINS))
    except ValueError:
        return False


def image_type(data):
    if data.startswith(b"\xff\xd8\xff") and b"\xff\xda" in data and data.endswith(b"\xff\xd9"):
        return "jpg"
    if (len(data) >= 57 and data.startswith(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR")
            and b"IDAT" in data and data.endswith(b"IEND\xaeB\x60\x82")):
        return "png"
    if len(data) > 13 and data.startswith((b"GIF87a", b"GIF89a")) and data.endswith(b";"):
        return "gif"
    if (data.startswith(b"RIFF") and data[8:12] == b"WEBP" and data[12:16] in (b"VP8 ", b"VP8L", b"VP8X")
            and int.from_bytes(data[4:8], "little") + 8 == len(data)):
        return "webp"
    raise ImageError("unsupported_or_incomplete_image")


def proxy_routes():
    try:
        with socket.create_connection(("127.0.0.1", 7890), timeout=0.1):
            local = ["--noproxy", "", "--proxy", "http://127.0.0.1:7890"]
    except OSError:
        return [[]]
    env = getproxies_environment()
    if any(env.get(kind) for kind in ("http", "https", "all")):
        return [[], local]  # Try the service's normal proxy settings first.
    return [local, []]


def fetch(url, proxy, deadline):
    for _ in range(4):
        if not cdn_url(url):
            raise ImageError("invalid_cdn_url")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ImageError("timeout")
        # The default curl config could enable -L. Inspect each redirect before following it.
        args = ["curl", "-q", "--silent", "--globoff", "--proto", "=http,https", "--connect-timeout", "3",
                "--max-time", f"{remaining:.3f}", "--max-filesize", str(MAX_BYTES),
                "--write-out", "%{stderr}%{http_code}\n%{redirect_url}", *proxy, "--", url]
        with tempfile.TemporaryFile() as metadata, subprocess.Popen(
            args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=metadata
        ) as client:
            data = bytearray()
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not select.select([client.stdout], [], [], remaining)[0]:
                        raise ImageError("timeout")
                    # Older curl versions only enforce --max-filesize if Content-Length is known.
                    chunk = os.read(client.stdout.fileno(), min(65536, MAX_BYTES + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        raise ImageError("image_too_large")
                code = client.wait(timeout=max(0.01, deadline - time.monotonic()))
            finally:
                if client.poll() is None:
                    client.kill()
            if code:
                raise ImageError({28: "timeout", 63: "image_too_large"}.get(code, "download_failed"))
            metadata.seek(0)
            status, _, redirect = metadata.read(4102).partition(b"\n")
        if status == b"200":
            return data
        if status not in (b"301", b"302", b"303", b"307", b"308"):
            raise ImageError("http_error")
        try:
            url = redirect.decode("utf-8")
        except UnicodeError:
            raise ImageError("invalid_cdn_url") from None
    raise ImageError("too_many_redirects")


def fetch_one(directory, index, item, deadline):
    try:
        if (not isinstance(item, dict) or not isinstance(item.get("mimeType"), str)
                or not item["mimeType"].startswith("image/") or not cdn_url(item.get("url"))):
            raise ImageError("invalid_attachment")
        url = item["url"]
        prefix = f"{index}-{hashlib.sha256(url.encode()).hexdigest()[:24]}-"
        for path in directory.glob(prefix + "*"):
            try:
                if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= MAX_BYTES:
                    continue
                with path.open("rb") as stream:
                    cached = stream.read(MAX_BYTES + 1)
                ext = image_type(cached)
            except (FileNotFoundError, ImageError):
                continue
            if len(cached) <= MAX_BYTES and path.name == prefix + hashlib.sha256(cached).hexdigest() + "." + ext:
                return {"index": index, "path": str(path)}
        routes = proxy_routes()
        for index_route, proxy in enumerate(routes):
            last = index_route == len(routes) - 1
            now = time.monotonic()
            try:
                data = fetch(url, proxy, deadline if last else now + (deadline - now) / 2)
                break
            except ImageError as error:
                if last or str(error) not in ("timeout", "download_failed"):
                    raise
        ext = image_type(data)
        path = directory / (prefix + hashlib.sha256(data).hexdigest() + "." + ext)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".incoming-")
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
            os.replace(tmp, path)
        finally:
            Path(tmp).unlink(missing_ok=True)
        return {"index": index, "path": str(path)}
    except ImageError as error:
        return {"index": index, "error": str(error)}
    except subprocess.TimeoutExpired:
        return {"index": index, "error": "timeout"}
    except (OSError, UnicodeError):
        return {"index": index, "error": "image_unavailable"}


def incoming_images(bridge: Path, key: str, attachments: list, timeout: float) -> list[dict]:
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", key):
        raise ValueError("invalid_request_key")
    if not isinstance(attachments, list) or not attachments:
        return []
    items = attachments[:4]
    if not math.isfinite(timeout) or timeout <= 0:
        return [{"index": index, "error": "timeout"} for index in range(1, len(items) + 1)]
    deadline = time.monotonic() + min(20, timeout)
    root = bridge / "att"
    directory = root / key
    try:
        for folder in (root, directory):
            if folder.is_symlink():
                raise OSError("symlink in image cache path")
            folder.mkdir(mode=0o700, exist_ok=True)
    except OSError:
        return [{"index": index, "error": "cache_unavailable"} for index in range(1, len(items) + 1)]
    with ThreadPoolExecutor(max_workers=len(items)) as pool:
        work = [pool.submit(fetch_one, directory, index, item, deadline)
                for index, item in enumerate(items, 1)]
        return [job.result() for job in work]
