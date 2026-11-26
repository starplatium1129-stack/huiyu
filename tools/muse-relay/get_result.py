"""Submit or resume a Muse drawing request over HTTPS and save one verified PNG."""
import argparse
import getpass
import hashlib
import http.client
import json
import os
from pathlib import Path
from queue import Empty, Queue
import re
import sys
import tempfile
from threading import Event, Thread
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PART = 128 * 1024
MAX_FILE = 32 * 1024 * 1024
PARALLEL_MIN = 1024 * 1024
PARALLEL_CONNECTIONS = 4
PARALLEL_DELAY = 1.5
POLL_SECONDS = 2
TRANSIENT_HTTP = (408, 429, 500, 502, 503, 504)
PNG_SIGNATURE = bytes.fromhex("89504e470d0a1a0a")
RECEIVE_PATH = re.compile(r"(/api/muse/batches/[A-Za-z0-9_-]{1,160})/original/([1-9][0-9]?)")
RESULT_PATH = re.compile(r"/api/(?:anima|moss|creative|qwen|keyframe|manga)/jobs/[a-f0-9]{32}/result")
REQUEST_KEY = re.compile(r"[A-Za-z0-9_-]{1,160}")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def matches_original(file, size, digest):
    with file.open("rb") as source:
        if os.fstat(source.fileno()).st_size != size or source.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
            return False
        source.seek(0)
        return hashlib.file_digest(source, "sha256").hexdigest() == digest


def publish_original(temporary, target, size, digest):
    if not matches_original(temporary, size, digest):
        raise ValueError("Incomplete original or incorrect PNG signature or SHA-256")
    try:
        os.link(temporary, target)
    except FileExistsError:
        if not matches_original(target, size, digest):
            raise SystemExit(f"Output already exists with different contents: {target}")


def retry_seconds(value, fallback=2):
    if value is not None and re.fullmatch(r"[0-9]{1,8}", str(value)):
        return max(1, min(60, int(value)))
    return fallback


def receive_original(reply, target, receipt):
    """Return a polling delay for a pending receipt, or None after publishing the PNG."""
    if reply.status == 202:
        return retry_seconds(reply.headers.get("Retry-After"))
    if reply.status != 200:
        raise ValueError(f"Unexpected HTTP {reply.status} for a full image")
    media_type = reply.headers.get_content_type()
    if media_type != "image/png":
        body = reply.read(4097)
        if len(body) <= 4096 and body.lstrip().startswith(b"{"):
            state = json.loads(body)
            if isinstance(state, dict) and state.get("pending") is True:
                return retry_seconds(reply.headers.get("Retry-After") or state.get("retryAfterSeconds"))
        raise ValueError(f"Expected image/png, received {media_type}")
    size = int(reply.headers.get("Content-Length") or 0)
    digest = reply.headers.get("X-Result-Sha256") or receipt.get("resultSha256") or ""
    declared_size = reply.headers.get("X-Result-Bytes") or receipt.get("resultBytes")
    if not (0 < size <= MAX_FILE and isinstance(digest, str) and re.fullmatch(r"[a-f0-9]{64}", digest)
            and str(declared_size) == str(size)
            and receipt.get("resultBytes") in (None, size) and receipt.get("resultSha256") in (None, digest)):
        raise ValueError("Invalid PNG receipt")
    received = 0
    started = time.monotonic()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            while data := reply.read(min(PART, size - received + 1)):
                received += len(data)
                if received > size:
                    raise ValueError("Incorrect Content-Length")
                output.write(data)
        publish_original(temporary, target, size, digest)
        print(f"Verified {target} | {size} bytes | SHA-256 {digest} | download {time.monotonic() - started:.2f} s")
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def receive_adaptive(open_request, target, size, digest):
    etag = f'"{digest}"'
    step = (size + PARALLEL_CONNECTIONS - 1) // PARALLEL_CONNECTIONS
    bounds = [(start, min(start + step, size) - 1) for start in range(0, size, step)]
    finished = Queue()
    stop = Event()

    def read(bounds):
        if bounds is None:
            expected, status, extra = size, 200, {}
        else:
            start, end = bounds
            expected, status = end - start + 1, 206
            extra = {"Range": f"bytes={start}-{end}", "If-Range": etag}
        try:
            with open_request(extra) as reply:
                headers = reply.headers
                if (reply.status != status or headers.get_content_type() != "image/png"
                        or headers.get("Content-Length") != str(expected)
                        or headers.get("X-Result-Sha256", digest) != digest
                        or (bounds is not None and (
                            headers.get("Content-Range") != f"bytes {start}-{end}/{size}"
                            or headers.get("ETag") != etag))):
                    raise ValueError("Unexpected original response")
                data = bytearray()
                while not stop.is_set() and len(data) < expected:
                    chunk = reply.read1(min(PART, expected - len(data)))
                    if not chunk:
                        raise http.client.IncompleteRead(b"", expected - len(data))
                    data.extend(chunk)
                if not stop.is_set():
                    finished.put((bounds, data))
        except (OSError, http.client.HTTPException, ValueError) as error:
            if isinstance(error, urllib.error.HTTPError):
                error.close()
            finished.put((bounds, error))

    def launch(bounds):
        # A losing request owns only its response and exits after the next
        # readable chunk or socket timeout. It never writes to disk.
        Thread(target=read, args=(bounds,), daemon=True).start()

    def verified(pieces):
        checksum = hashlib.sha256()
        for piece in pieces:
            checksum.update(piece)
        return pieces[0].startswith(PNG_SIGNATURE) and checksum.hexdigest() == digest

    def save(pieces, mode):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                temporary = Path(output.name)
                for piece in pieces:
                    output.write(piece)
            publish_original(temporary, target, size, digest)
            print(f"Verified {target} | {size} bytes | SHA-256 {digest} | {mode} download {time.monotonic() - started:.2f} s")
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)

    started = time.monotonic()
    launch(None)
    try:
        try:
            _, first = finished.get(timeout=PARALLEL_DELAY)
        except Empty:
            first = None
        if isinstance(first, bytearray) and verified([first]):
            return save([first], "single")
        if isinstance(first, urllib.error.HTTPError) and first.code in (401, 403):
            raise first
        for part in bounds:
            launch(part)
        pieces = {}
        for _ in range(len(bounds) + (first is None)):
            try:
                part, value = finished.get(timeout=max(0, started + 35 - time.monotonic()))
            except Empty as error:
                raise TimeoutError("Original download timed out") from error
            if isinstance(value, urllib.error.HTTPError) and value.code in (401, 403):
                raise value
            if not isinstance(value, bytearray):
                continue
            if part is None and verified([value]):
                stop.set()
                return save([value], "single")
            if part is not None:
                pieces[part] = value
                if len(pieces) == len(bounds):
                    ordered = [pieces[part] for part in bounds]
                    if verified(ordered):
                        stop.set()
                        return save(ordered, "parallel")
        raise ValueError("Could not verify a complete original")
    finally:
        stop.set()


def result_metadata(job):
    path, size, digest = job.get("resultUrl"), job.get("resultBytes"), job.get("resultSha256")
    if (isinstance(path, str) and RESULT_PATH.fullmatch(path)
            and type(size) is int and 0 < size <= MAX_FILE
            and isinstance(digest, str) and re.fullmatch(r"[a-f0-9]{64}", digest)):
        return path, size, digest
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("address", help="Muse HTTPS address")
    parser.add_argument("receipt", help="batchKey, statusPath or receivePath; with --submit, use JSON or @request.json")
    parser.add_argument("output", type=Path)
    parser.add_argument("--submit", action="store_true", help="Submit the request before receiving the result")
    parser.add_argument("--item", type=int, default=1, help="variant number within a batch (from 1)")
    parser.add_argument("--single-connection", action="store_true", help="Use the traditional whole-image download first")
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.address)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.path.strip("/") or url.query or url.fragment:
        parser.error("Use the HTTPS root address")
    if args.item < 1 or (not args.submit and not re.fullmatch(r"[a-zA-Z0-9_-]{1,160}|/api/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+", args.receipt)):
        parser.error("Use a batchKey, statusPath or receivePath and a positive item number")
    request_body = None
    if args.submit:
        try:
            if args.receipt.startswith("@"):
                with Path(args.receipt[1:]).open("rb") as source:
                    request_body = json.loads(source.read(256 * 1024 + 1))
            else:
                request_body = json.loads(args.receipt)
        except (OSError, ValueError) as error:
            parser.error(f"Cannot read the drawing request: {error}")
        if not isinstance(request_body, dict):
            parser.error("The drawing request must be a JSON object")
        key = request_body.setdefault("requestKey", str(uuid.uuid4()))
        if not isinstance(key, str) or not REQUEST_KEY.fullmatch(key):
            parser.error("Use a valid requestKey or omit it to generate one")
        if args.output.exists():
            parser.error("Choose a new output path when submitting, or resume the existing receipt")
    token = os.getenv("MUSE_TOKEN") or getpass.getpass("Muse X-Token: ")
    client = urllib.request.build_opener(NoRedirect())

    def make_request(path, extra=None, data=None):
        return urllib.request.Request(args.address.rstrip("/") + path, data=data, headers={
            "X-Token": token, "Accept-Encoding": "identity", "User-Agent": "Huiyu-Muse/1.0",
            **(extra or {}),
        })

    def fetch(path, parse, data=None):
        request = make_request(path, {"Content-Type": "application/json"} if data is not None else None, data)
        for attempt in range(8):
            delay = min(8, 2 ** attempt)
            try:
                with client.open(request, timeout=25) as reply:
                    return parse(reply)
            except urllib.error.HTTPError as error:
                with error:
                    if error.code not in TRANSIENT_HTTP:
                        if data is not None:
                            try:
                                problem = json.loads(error.read(16 * 1024))
                            except (ValueError, OSError, http.client.HTTPException):
                                problem = None
                            if isinstance(problem, dict) and isinstance(problem.get("message"), str):
                                raise SystemExit(f"HTTP {error.code}: {problem['message']}") from error
                        raise SystemExit(f"HTTP {error.code} at {path}") from error
                    delay = retry_seconds(error.headers.get("Retry-After"), delay)
                last = error
            except (OSError, http.client.HTTPException, ValueError) as error:
                last = error
            if attempt < 7:
                time.sleep(delay)
        raise SystemExit(f"Muse request interrupted at {path}: {last}")

    first_receipt = None
    if request_body is not None:
        endpoint = "/api/muse/batches" if any(key in request_body for key in ("ids", "items", "scenes")) else "/api/muse/jobs"
        key = request_body["requestKey"]
        path = "/api/muse/batches/" + key
        print(f"Muse requestKey: {key} | Resume: {path}", file=sys.stderr, flush=True)
        data = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
        if len(data) > (256 * 1024 if endpoint.endswith("/batches") else 64 * 1024):
            parser.error("Drawing request is too large")
        response = fetch(endpoint, lambda reply: json.loads(reply.read()), data)
        if not isinstance(response, dict) or response.get("statusPath") != path or response.get("batchKey") != key:
            raise SystemExit("Muse did not return the expected batch receipt. Resume with the requestKey above.")
        first_receipt = response
    else:
        path = args.receipt if args.receipt.startswith("/") else "/api/muse/batches/" + args.receipt
    original = RECEIVE_PATH.fullmatch(path)
    if original:
        path, args.item = original[1], int(original[2])
    fast = True
    parallel = not args.single_connection
    while True:
        receipt = first_receipt if first_receipt is not None else fetch(path, lambda reply: json.loads(reply.read()))
        first_receipt = None
        if not isinstance(receipt, dict):
            raise SystemExit("Expected a JSON job receipt")
        rejection = receipt.get("rejected") or (receipt if receipt.get("ok") is False and receipt.get("pending") is not True else None)
        if isinstance(rejection, dict):
            raise SystemExit(rejection.get("message") or rejection.get("code") or "Job rejected")
        items = receipt.get("items") or [receipt.get("job") or receipt.get("item") or {}]
        if not isinstance(items, list):
            raise SystemExit("Expected an array of image receipts")
        if args.item > len(items):
            parser.error(f"Receipt contains {len(items)} item(s)")
        job = items[args.item - 1]
        if not isinstance(job, dict):
            raise SystemExit("Invalid image receipt")
        if job.get("status") in ("failed", "cancelled", "interrupted") or job.get("deliveryStatus") in ("expired", "storageFull", "integrityError", "invalidReceipt"):
            raise SystemExit(job.get("error") or job.get("deliveryStatus") or job.get("status"))
        metadata = result_metadata(job)
        if job.get("resultAvailable") and metadata:
            result, size, digest = metadata
            if args.output.exists():
                if matches_original(args.output, size, digest):
                    print(f"Verified {args.output} ({size} bytes)")
                    return
                raise SystemExit(f"Output already exists with different contents: {args.output}")
            cache = args.output.parent / (args.output.name + "." + digest + ".parts")
            if cache.is_dir():
                break
            if parallel and size >= PARALLEL_MIN:
                parallel = False
                try:
                    receive_adaptive(lambda headers: client.open(make_request(result, headers), timeout=15),
                                     args.output, size, digest)
                    return
                except urllib.error.HTTPError as error:
                    if error.code in (401, 403):
                        raise SystemExit(f"HTTP {error.code} at {result}") from error
                except (OSError, http.client.HTTPException, ValueError):
                    pass
                fast = False
        # Poll delivery state so receivePath does not start a single download
        # before the ready receipt exposes the image size and digest.
        if (parallel and job.get("resultAvailable") is False
                and (job.get("status") in ("waiting", "queued", "running")
                     or job.get("deliveryStatus") == "transferring")):
            time.sleep(POLL_SECONDS)
            continue
        download = job.get("resultUrl") or (original[0] if original else job.get("receivePath")) or ""
        if fast and isinstance(download, str) and (RESULT_PATH.fullmatch(download) or RECEIVE_PATH.fullmatch(download)):
            try:
                while True:
                    with client.open(make_request(download), timeout=35) as reply:
                        delay = receive_original(reply, args.output, job)
                    if delay is None:
                        return
                    time.sleep(delay)
            except urllib.error.HTTPError as error:
                with error:
                    if error.code in (401, 403):
                        raise SystemExit(f"HTTP {error.code} at {download}") from error
                    delay = retry_seconds(error.headers.get("Retry-After"), 0)
                if delay:
                    time.sleep(delay)
            except (urllib.error.URLError, http.client.HTTPException, TimeoutError, ValueError, ConnectionError):
                pass
            # Recheck the receipt and use resumable parts after an interrupted transfer.
            fast = False
            continue
        if job.get("resultAvailable") and job.get("resultUrl"):
            break
        if job.get("status") == "succeeded" and job.get("deliveryStatus") != "transferring":
            raise SystemExit("Result unavailable; check the receipt and expiry.")
        time.sleep(3)

    metadata = result_metadata(job)
    if not metadata:
        raise SystemExit("Invalid result receipt")
    path, size, digest = metadata
    target = args.output
    if target.exists():
        if matches_original(target, size, digest):
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
                    if reply.status != 200 or reply.headers.get_content_type() != "application/octet-stream":
                        raise ValueError("Expected a binary result part")
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
        try:
            publish_original(temporary, target, size, digest)
        except ValueError as error:
            raise SystemExit(str(error)) from error
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
