"""Download and install the pinned native keyframe models and CUDA runner."""
import argparse
from contextlib import contextmanager
import hashlib
from http.client import IncompleteRead
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import uuid
from zipfile import BadZipFile, ZipFile


CHUNK = 1024 * 1024
RANGE = 128 * CHUNK


def child(root, relative):
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root) or path.resolve() == root:
        raise ValueError(f"文件超出所选目录：{relative}")
    return path


@contextmanager
def installation_lock(cache):
    cache.mkdir(parents=True, exist_ok=True)
    with child(cache, "prepare.lock").open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise OSError("另一条准备命令正在使用这个模型根目录。") from exc
        yield  # Closing the handle also releases the lock after interruption.


def sha256(stream):
    digest = hashlib.sha256()
    while block := stream.read(4 * CHUNK):
        digest.update(block)
    return digest.hexdigest()


def matches(path, row):
    if not path.is_file() or ("bytes" in row and path.stat().st_size != row["bytes"]):
        return False
    with path.open("rb") as stream:
        return sha256(stream) == row["sha256"]


def fetch(url, part, expected, label):
    """Append only a contiguous Content-Range. A full response restarts the file."""
    failures = 0
    next_report = 0.0
    while True:
        offset = part.stat().st_size if part.exists() else 0
        if expected is not None and offset == expected:
            return
        if expected is not None and offset > expected:
            part.unlink()
            continue
        end = offset + RANGE - 1
        if expected is not None:
            end = min(end, expected - 1)
        # A fresh signed redirect avoids replaying a CDN link cached for an old range.
        sep = "&" if "?" in url else "?"
        request = Request(f"{url}{sep}huiyu_range={offset}-{time.time_ns()}",
                          headers={"Range": f"bytes={offset}-{end}", "Accept-Encoding": "identity",
                                   "User-Agent": "Huiyu-Keyframe-Setup/1"})
        try:
            with urlopen(request, timeout=60) as response:
                length = response.headers.get("Content-Length")
                length = int(length) if length is not None else None
                if response.status == 206:
                    span = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                    if not span:
                        raise ValueError(f"{label} 缺少有效的续传范围。")
                    first, last, total = map(int, span.groups())
                    if first != offset or last < first or last > end or last >= total:
                        raise ValueError(f"{label} 的续传位置不一致。")
                    count = last - first + 1
                    if length is not None and length != count:
                        raise ValueError(f"{label} 的分段长度不一致。")
                    mode = "ab"
                elif response.status == 200:
                    total = length
                    count = length if length is not None else expected
                    mode = "wb"
                    offset = 0
                else:
                    raise ValueError(f"{label} 返回了 HTTP {response.status}。")
                if expected is not None and total is not None and total != expected:
                    raise ValueError(f"{label} 的远端长度与固定版本不符。")
                if total is not None:
                    expected = total
                received = 0
                with part.open(mode) as output:
                    while block := response.read(CHUNK):
                        if count is not None and received + len(block) > count:
                            raise ValueError(f"{label} 超过声明的下载长度。")
                        output.write(block)
                        received += len(block)
                        if time.monotonic() >= next_report:
                            size = f" / {expected / CHUNK:.0f}" if expected is not None else ""
                            print(f"  {label}  {(offset + received) / CHUNK:.0f}{size} MiB", flush=True)
                            next_report = time.monotonic() + 10
                if count is not None and received != count:
                    raise ConnectionError(f"{label} 分段传输中断。")
                if response.status == 200:
                    return
                failures = 0
        except HTTPError as exc:
            complete = re.fullmatch(r"bytes \*/(\d+)", exc.headers.get("Content-Range", ""))
            exc.close()
            if exc.code == 416 and complete and offset == int(complete[1]) and expected in (None, offset):
                return
            if exc.code not in (403, 408, 429, 500, 502, 503, 504):
                raise OSError(f"{label} 下载失败（HTTP {exc.code}）。") from exc
            failures += 1
        except (ConnectionError, IncompleteRead, TimeoutError, URLError) as exc:
            failures += 1
            if failures >= 4:
                raise OSError(f"{label} 的连接失败，重新运行可续传。") from exc
        if failures:
            if failures >= 4:
                raise OSError(f"{label} 仍无法从发布源下载，文件已保留以供续传。")
            time.sleep(2 ** (failures - 1))


def obtain(row, target):
    if target.is_file():
        print(f"正在核对  {target.name}", flush=True)
    if matches(target, row):
        print(f"已校验  {target.name}", flush=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    part = child(target.parent.resolve(), f".{target.name}.{row['sha256'][:12]}.huiyu-part")
    for attempt in range(2):
        fetch(row["url"], part, row.get("bytes"), target.name)
        if matches(part, row):
            break
        part.unlink(missing_ok=True)
        if attempt:
            raise ValueError(f"{target.name} 的 SHA-256 与固定版本不符。")
        print(f"{target.name} 校验失败，重新获取完整文件。", flush=True)
    previous = None
    if target.exists():
        if not target.is_file():
            raise ValueError(f"安装位置已有同名目录：{target}")
        # Another preparation tool may have completed this file during transfer.
        if matches(target, row):
            part.unlink()
            print(f"已校验  {target.name}", flush=True)
            return
        previous = target.with_name(f"{target.name}.previous-{uuid.uuid4().hex[:12]}")
        target.rename(previous)
    try:
        part.replace(target)
    except BaseException:
        if previous is not None:
            previous.replace(target)
        raise
    if previous is not None:
        print(f"原文件已保存在 {previous}", flush=True)
    print(f"已准备  {target.name}", flush=True)


def install_runner(packages, directory, executable):
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".sd-cpp-", dir=directory.parent) as work:
        staging = Path(work)
        old = staging / "previous"
        old.mkdir()
        names = set()
        changed = []
        for package in packages:
            with ZipFile(package) as archive:
                for entry in archive.infolist():
                    if entry.is_dir():
                        continue
                    name = entry.filename
                    # Both pinned Windows archives ship flat DLLs, binaries and licenses.
                    if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name in (".", "..") or name.casefold() in names:
                        raise ValueError(f"CUDA 压缩包包含不兼容的文件名：{name}")
                    if stat.S_ISLNK(entry.external_attr >> 16):
                        raise ValueError(f"CUDA 压缩包包含链接：{name}")
                    names.add(name.casefold())
                    target = child(directory, name)
                    if target.is_file() and target.stat().st_size == entry.file_size:
                        with target.open("rb") as current, archive.open(entry) as source:
                            if sha256(current) == sha256(source):
                                continue
                    with archive.open(entry) as source, (staging / name).open("xb") as output:
                        shutil.copyfileobj(source, output, length=CHUNK)
                    changed.append(name)
        if executable.casefold() not in names:
            raise ValueError(f"CUDA 压缩包中没有 {executable}。")
        if not changed:
            return
        # Expose the executable only after every dependency is published. Older
        # files stay available for rollback if a running Windows DLL is locked.
        launcher = child(directory, executable)
        binaries_changed = any(Path(name).suffix.lower() in (".dll", ".exe") for name in changed)
        backed_up, published = [], []
        try:
            if binaries_changed and launcher.is_file():
                launcher.rename(old / executable)
                backed_up.append(executable)
            for name in changed:
                if name == executable:
                    continue
                target = child(directory, name)
                if target.exists():
                    if not target.is_file():
                        raise ValueError(f"CUDA 文件位置已有同名目录：{target}")
                    target.rename(old / name)
                    backed_up.append(name)
                (staging / name).replace(target)
                published.append(name)
            if binaries_changed:
                (staging / executable if executable in changed else old / executable).replace(launcher)
        except BaseException:
            for name in reversed(published):
                child(directory, name).unlink(missing_ok=True)
            for name in reversed(backed_up):
                if (old / name).exists():
                    (old / name).replace(child(directory, name))
            raise


def main():
    manifest = json.loads(Path(__file__).with_name("adapter-models.json").read_text(encoding="utf-8"))
    models = {key: value for key, value in manifest["models"].items() if value.get("runner") in ("sd-cpp", "wan-a14b-sd", "musetalk-native")}
    parser = argparse.ArgumentParser(description="按固定 SHA-256 准备本机关键帧、Wan 视频或 MuseTalk 配音对口型模型。")
    parser.add_argument("--models-root", type=Path, required=True, help="绘遇原生模型目录，例如 D:/HuiyuAI/inference/models")
    parser.add_argument("--model", choices=models, action="append", help="只准备指定模型。可重复选择，省略则准备两套关键帧模型。")
    args = parser.parse_args()
    root = args.models_root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    cache = child(root.parent, ".downloads/keyframes").resolve()
    runtime = manifest["keyframeRuntime"]
    with installation_lock(cache):
        selected = list(dict.fromkeys(args.model or [key for key, spec in models.items() if spec["runner"] == "sd-cpp"]))
        if any(models[key]["runner"] != "musetalk-native" for key in selected):
            packages = []
            for row in runtime["archives"]:
                package = child(cache, Path(urlsplit(row["url"]).path).name)
                obtain(row, package)
                packages.append(package)
            install_runner(packages, child(root, runtime["directory"]), runtime["executable"])
        components = dict.fromkeys(asset for model in selected for asset in models[model]["components"].values())
        for asset in components:
            row = manifest["keyframeAssets"][asset]
            obtain(row, child(root, row["path"]))
        print(f"已准备 {', '.join(selected)}，模型目录为 {root}", flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("已暂停。重新运行相同命令可继续下载。")
    except (OSError, ValueError, BadZipFile) as error:
        sys.exit(str(error))
