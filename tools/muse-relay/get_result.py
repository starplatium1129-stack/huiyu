"""Download one Muse result over HTTPS. Only verified PNG bytes reach the final path."""
import argparse
import getpass
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PART = 128 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def save_original(reply, target, receipt):
    size = int(reply.headers.get("Content-Length") or 0)
    digest = reply.headers.get("X-Result-Sha256") or receipt.get("resultSha256") or ""
    if not (0 < size <= 32 * 1024 * 1024 and re.fullmatch(r"[a-f0-9]{64}", digest)
            and reply.headers.get_content_type() == "image/png"
            and reply.headers.get("X-Result-Bytes", str(size)) == str(size)
            and receipt.get("resultBytes") in (None, size) and receipt.get("resultSha256") in (None, digest)):
        raise ValueError("Invalid PNG receipt")
    sha = hashlib.sha256()
    received = 0
    started = time.monotonic()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            while data := reply.read(min(128 * 1024, size - received + 1)):
                received += len(data)
                if received > size:
                    raise ValueError("Incorrect Content-Length")
                sha.update(data)
                output.write(data)
        if received != size or sha.hexdigest() != digest:
            raise ValueError("Incomplete original")
        try:
            os.link(temporary, target)
        except FileExistsError:
            with target.open("rb") as src:
                if target.stat().st_size != size or hashlib.file_digest(src, "sha256").hexdigest() != digest:
                    raise SystemExit(f"Output already exists with different contents: {target}")
        print(f"Verified {target} | {size} bytes | SHA-256 {digest} | download {time.monotonic() - started:.2f} s")
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("address", help="Muse HTTPS address")
    parser.add_argument("receipt", help="batchKey or /api/.../statusPath")
    parser.add_argument("output", type=Path)
    parser.add_argument("--item", type=int, default=1, help="variant number within a batch (from 1)")
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.address)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.path.strip("/") or url.query or url.fragment:
        parser.error("Use the HTTPS root address")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,160}|/api/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+", args.receipt) or args.item < 1:
        parser.error("Use a batchKey or a receipt statusPath and a positive item number")
    token = os.getenv("MUSE_TOKEN") or getpass.getpass("Muse X-Token: ")
    client = urllib.request.build_opener(NoRedirect())

    def make_request(path):
        return urllib.request.Request(args.address.rstrip("/") + path, headers={
            "X-Token": token, "Accept-Encoding": "identity", "User-Agent": "Huiyu-Muse/1.0",
        })

    def fetch(path, parse):
        request = make_request(path)
        for attempt in range(8):
            try:
                with client.open(request, timeout=25) as reply:
                    return parse(reply)
            except urllib.error.HTTPError as error:
                if error.code not in (408, 429, 500, 502, 503, 504):
                    raise SystemExit(f"HTTP {error.code} at {path}") from error
                last = error
            except (OSError, http.client.HTTPException, ValueError) as error:
                last = error
            if attempt < 7:
                time.sleep(min(8, 2 ** attempt))
        raise SystemExit(f"Download interrupted at {path}: {last}")

    path = args.receipt if args.receipt.startswith("/") else "/api/muse/batches/" + args.receipt
    original = re.fullmatch(r"(/api/muse/batches/[a-zA-Z0-9_-]+)/original/([1-9][0-9]?)", path)
    if original:
        path, args.item = original[1], int(original[2])
    fast = True
    while True:
        receipt = fetch(path, lambda reply: json.loads(reply.read()))
        items = receipt.get("items") or [receipt.get("job") or receipt.get("item") or {}]
        if args.item > len(items):
            parser.error(f"Receipt contains {len(items)} item(s)")
        job = items[args.item - 1]
        if job.get("status") in ("failed", "cancelled") or job.get("deliveryStatus") in ("expired", "storageFull", "integrityError", "invalidReceipt"):
            raise SystemExit(job.get("error") or job.get("deliveryStatus") or job.get("status"))
        download = job.get("receivePath") or job.get("resultUrl") or ""
        if fast and re.fullmatch(r"/api/(?:muse/batches/[A-Za-z0-9_-]{1,160}/original/[1-9][0-9]?|(?:anima|moss|creative|qwen)/jobs/[a-f0-9]{32}/result)", download):
            try:
                while True:
                    with client.open(make_request(download), timeout=35) as reply:
                        if reply.status == 202:
                            continue
                        save_original(reply, args.output, job)
                        return
            except (urllib.error.URLError, http.client.HTTPException, TimeoutError, ValueError, ConnectionError):
                # Recheck job state; a truncated response or broken proxy falls
                # back to the existing verified, resumable 128 KiB parts.
                fast = False
                continue
        if job.get("resultAvailable") and job.get("resultUrl"):
            break
        if job.get("status") == "succeeded" and job.get("deliveryStatus") != "transferring":
            raise SystemExit("Result unavailable; check the receipt and expiry.")
        time.sleep(3)

    path, size, digest = job["resultUrl"], job["resultBytes"], job["resultSha256"]
    if not re.fullmatch(r"/api/(?:anima|moss|creative|qwen)/jobs/[a-f0-9]{32}/result", path) or not re.fullmatch(r"[a-f0-9]{64}", digest or "") or not isinstance(size, int) or not 0 < size <= 32 * 1024 * 1024:
        raise SystemExit("Invalid result receipt")
    target = args.output
    def complete(file):
        with file.open("rb") as source:
            return file.stat().st_size == size and hashlib.file_digest(source, "sha256").hexdigest() == digest
    if target.exists():
        if complete(target):
            print(f"Verified {target} ({size} bytes)")
            return
        raise SystemExit(f"Output already exists with different contents: {target}")
    # Each verified part is installed atomically. An interrupted run or another
    # downloader can reuse it, even if a proxy removed all Range headers.
    cache = target.parent / (target.name + "." + digest + ".parts")
    cache.mkdir(exist_ok=True)
    started = time.monotonic()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            for n, offset in enumerate(range(0, size, PART)):
                expected = min(PART, size - offset)
                def parse(reply):
                    data = reply.read(expected + 1)
                    sha = hashlib.sha256(data).hexdigest()
                    required = {"Content-Length": str(expected), "X-Result-Offset": str(offset), "X-Result-Bytes": str(size),
                                "X-Result-Sha256": digest, "X-Part-Sha256": sha}
                    if len(data) != expected or any(reply.headers.get(k) != v for k, v in required.items()):
                        raise ValueError("Incomplete or incorrect part")
                    return data, sha
                data = None
                for saved in cache.glob(f"{n}.*"):
                    try:
                        candidate = saved.read_bytes()
                    except FileNotFoundError:
                        continue
                    if len(candidate) == expected and hashlib.sha256(candidate).hexdigest() == saved.suffix[1:]:
                        data = candidate
                        break
                if data is None:
                    data, sha = fetch(path + "?part=" + str(n), parse)
                    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as piece:
                        piece.write(data)
                    os.replace(piece.name, cache / f"{n}.{sha}")
                output.write(data)
        if not complete(temporary):
            raise SystemExit("Full-image SHA-256 mismatch")
        # Link only if the destination is still unused, including concurrent runs.
        try:
            os.link(temporary, target)
        except FileExistsError:
            if not complete(target):
                raise SystemExit("Another download wrote a different image to the same output")
        for part in cache.glob("*.*"):
            if re.fullmatch(r"\d+\.[a-f0-9]{64}", part.name):
                part.unlink(missing_ok=True)
        try:
            cache.rmdir()
        except OSError:
            pass
        print(f"Verified {target} | {size} bytes | SHA-256 {digest} | generation {job.get('generationMs')} ms | download {time.monotonic() - started:.1f} s")
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
