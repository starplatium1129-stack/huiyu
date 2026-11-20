#!/usr/bin/env python3
"""Look up reviewed QQ pictures and prepare immutable files for the reply spool."""
import argparse
from contextlib import closing
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unicodedata

from bridge_delivery import MAX_MEDIA, sync_dir


GALLERIES = ("nene-gallery", "your_files", "morning-nene")
GALLERY_DB = "reviewed-gallery.sqlite3"
PNG = b"\x89PNG\r\n\x1a\n"
JPEG = b"\xff\xd8\xff"
IMAGE_HEADERS = {".png": PNG, ".jpg": JPEG, ".jpeg": JPEG}
VOICES = {"lily": "avocado_v2:Lily", "mature": "avocado_v2:vd3_qvd_04055"}


def read_media(path):
    if not path.is_absolute():
        raise ValueError("media_path_must_be_absolute")
    # An accidentally selected FIFO must not block a worker waiting for a writer.
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_MEDIA:
            raise ValueError("invalid_media_file_or_size")
        data = stream.read(MAX_MEDIA + 1)
    if len(data) != info.st_size:
        raise ValueError("media_changed_while_reading")
    return data


def read_image(path):
    header = IMAGE_HEADERS.get(path.suffix.lower())
    if header is None:
        raise ValueError("unsupported_image_extension")
    data = read_media(path)
    if not data.startswith(header) or len(data) <= len(header):
        raise ValueError("image_type_mismatch")
    return data


def media_directory(bridge):
    directory = bridge / "reply-media"
    if directory.is_symlink():
        raise ValueError("invalid_reply_media_directory")
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory


def save_media(directory, suffix, data):
    # The sender may retry long after the gallery file or the TTS working file changes.
    output = tempfile.NamedTemporaryFile(dir=directory, prefix="reply-", suffix=suffix, delete=False)
    path = Path(output.name)
    try:
        with output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        sync_dir(directory)
        return path
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def prepare_image(bridge: Path, source: Path) -> Path:
    data = read_image(source)
    directory = media_directory(bridge)
    suffix = ".png" if data.startswith(PNG) else ".jpg"
    target = directory / ("image-" + hashlib.sha256(data).hexdigest() + suffix)
    try:
        if not target.is_symlink() and read_media(target) == data:
            return target
    except (FileNotFoundError, ValueError):
        pass
    temporary = save_media(directory, suffix, data)
    try:
        # Concurrent publications of the same picture install identical bytes.
        os.replace(temporary, target)
        sync_dir(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def gallery_path(bridge, path):
    if not path.is_absolute():
        raise ValueError("gallery_path_must_be_absolute")
    resolved = path.resolve(strict=True)
    workspace = bridge.parent.resolve()
    if not any(workspace / name in resolved.parents for name in GALLERIES):
        raise ValueError("outside_gallery")
    return resolved


def remember_gallery(bridge, source, description, *, snapshot=None):
    description = " ".join(description.split())
    if not 0 < len(description) <= 200:
        raise ValueError("description_must_be_1_to_200_characters")
    path = gallery_path(bridge, source)
    # On first use record the exact picture that was published. A later replacement at
    # the gallery path will not match this description until it has been reviewed again.
    digest = hashlib.sha256(read_image(snapshot if snapshot is not None else path)).hexdigest()
    with closing(sqlite3.connect(bridge / GALLERY_DB, timeout=1)) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS pictures (path TEXT PRIMARY KEY, description TEXT NOT NULL, "
                   "sha256 TEXT NOT NULL)")
        db.execute("INSERT OR REPLACE INTO pictures VALUES (?, ?, ?)", (str(path), description, digest))


# Strip request wording at the edges to preserve subjects such as 白发 and 未来.
REQUEST_PREFIX = re.compile(
    r"^(?:/muse|宁宁|宝宝|老婆|能不能|可不可以|可以|能否|麻烦|请问|请|给我们|给我|帮我|"
    r"我想要|我想|我要|想看|看一下|看看|来|发给我|发来|发送|发|挑|随便|随机|任意|好看的|"
    r"[一几两]?[张幅个]|你的|的|[，,、\s])+", re.IGNORECASE)
REQUEST_SUFFIX = re.compile(r"(?:的?(?:照片|图片|存图|图)|给我|看看|就行|都行|[吗吧呢呗啊呀，。,.!?！？\s])+$")


def search_terms(query):
    query = unicodedata.normalize("NFKC", query[:256]).casefold()
    query = REQUEST_SUFFIX.sub("", REQUEST_PREFIX.sub("", query))
    terms = set()
    for word in re.findall(r"[a-z0-9]+|[\u3400-\u9fff]+", query):
        terms.add(word)
        if len(word) > 2 and word[0] >= "\u3400":
            terms.update(word[pos:pos + 2] for pos in range(len(word) - 1))
    return terms


def search_gallery(bridge: Path, query: str) -> list:
    index = bridge / GALLERY_DB
    if not index.is_file():
        return []
    try:
        with closing(sqlite3.connect(index.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)) as db:
            rows = db.execute("SELECT path, description, sha256 FROM pictures ORDER BY rowid DESC").fetchall()
    except (OSError, sqlite3.Error):
        return []

    terms = search_terms(query)
    ranked = []
    for path, description, digest in rows:
        if not all(isinstance(field, str) for field in (path, description, digest)) or not 0 < len(description) <= 200:
            continue
        words = unicodedata.normalize("NFKC", description).casefold()
        score = sum(len(term) for term in terms if term in words)
        if score or not terms:
            ranked.append((score, Path(path), description, digest))
    results = []
    for _, path, description, digest in sorted(ranked, key=lambda row: row[0], reverse=True):
        try:
            if gallery_path(bridge, path) != path or hashlib.sha256(read_image(path)).hexdigest() != digest:
                continue
        except (OSError, RuntimeError, ValueError):
            continue
        results.append({"path": str(path), "description": description})
        if len(results) == 3:
            break
    return results


def has_mp3_frame(data):
    # Skip ID3 metadata and require a complete MPEG Layer III frame.
    offset = 0
    while data.startswith(b"ID3", offset):
        tag = data[offset:offset + 10]
        if len(tag) != 10 or not 2 <= tag[3] <= 4 or any(byte & 0x80 for byte in tag[6:10]):
            return False
        size = 0
        for byte in tag[6:10]:
            size = (size << 7) + byte
        offset += 10 + size
        if tag[3] == 4 and tag[5] & 0x10:
            offset += 10
    frame = data[offset:offset + 4]
    if len(frame) != 4 or frame[0] != 0xff or frame[1] & 0xe0 != 0xe0 or (frame[1] >> 1) & 3 != 1:
        return False
    version = (frame[1] >> 3) & 3
    rate_index, frequency_index = frame[2] >> 4, (frame[2] >> 2) & 3
    if version == 1 or rate_index not in range(1, 15) or frequency_index == 3:
        return False
    frequencies = (44100, 48000, 32000)
    frequency = frequencies[frequency_index] >> {0: 2, 2: 1, 3: 0}[version]
    if version == 3:
        kbps = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)[rate_index]
        length = 144000 * kbps // frequency
    else:
        kbps = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)[rate_index]
        length = 72000 * kbps // frequency
    return len(data) - offset >= length + ((frame[2] >> 1) & 1)


def synthesize_voice(bridge: Path, text: str, voice: str, timeout: float) -> Path:
    if voice not in VOICES or not 0 < len(text.strip()) <= 1600:
        raise ValueError("invalid_voice_or_text")
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("voice_deadline_expired")
    directory = media_directory(bridge)
    with tempfile.TemporaryDirectory(dir=directory, prefix=".tts-") as scratch:
        output = Path(scratch) / "speech.mp3"
        subprocess.run(["/opt/hatch/bin/tts", "speak", "--output", str(output), "--voice", VOICES[voice],
                        "--language", "zh_CN", "--text-stdin"], input=text.strip().encode("utf-8"),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=timeout)
        data = read_media(output)
        if not has_mp3_frame(data):
            raise ValueError("tts_output_is_not_mp3")
        return save_media(directory, ".mp3", data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    find = commands.add_parser("find", help="find up to three reviewed pictures")
    find.add_argument("query", nargs="?", default="")
    remember = commands.add_parser("remember", help="record a QQ-suitable picture after viewing this version")
    remember.add_argument("path", type=Path)
    remember.add_argument("description", help="describe the visible subject, scene or expression in up to 200 characters")
    args = parser.parse_args()
    os.umask(0o077)
    bridge = Path.home() / "workspace/qq-bridge"
    if args.command == "find":
        print(json.dumps(search_gallery(bridge, args.query), ensure_ascii=False))
    else:
        remember_gallery(bridge, args.path, args.description)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, sqlite3.Error) as error:
        sys.exit(str(error))
