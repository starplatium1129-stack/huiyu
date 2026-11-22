"""Pinned, optional CPU enhancement components. Plain editing needs only FFmpeg and Python."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import tempfile
from urllib.request import urlopen
from zipfile import ZipFile

NAME = "studio-export"
SR_FILE = "realesr-animevideov3.pth"
SR_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/" + SR_FILE
SR_SHA = "b8a8376811077954d82ca3fcf476f1ac3da3e8a68a4f4d71363008000a18b75d"
RIFE_DIR = "rife-ncnn-vulkan-20221029-windows"
RIFE_URL = "https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/" + RIFE_DIR + ".zip"
RIFE_ARCHIVE = "d8e4d772d26cd8006ef0ad0bc82eb191b53c68677d1ae2f42506d74cbbbea606"
RIFE = {
    "rife-ncnn-vulkan.exe": "4b970319db2814c82b15fceed8193151560a676a9eb63f20d4877be77b98f44f",
    "rife-v4.6/flownet.bin": "f334ed2260149ce0188a6dcf049844e8b0cdd912e01cbcfb63553157d2508958",
    "rife-v4.6/flownet.param": "28df14d57a225725ee5386f52eba422488450d37c9f40800ed4f62e8ba846692",
    "vcomp140.dll": "54fe6b087528b33c2969143d811eb62f1bd49071d37de9db0745fc079764d698",
    "LICENSE": "de18cbedb0c3b0d1eeb9ccac3988cdf69c21fa89039cd97dd8846cb68f661f81",
}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def valid(path, expected):
    return path.is_file() and digest(path) == expected


def checked_files(root, items):
    if root is None:
        return False
    return all(valid(root / name, checksum) for name, checksum in items.items())


def fetch(url, destination, checksum, maximum):
    with urlopen(url, timeout=90) as source, destination.open("xb") as output:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            if output.tell() + len(chunk) > maximum:
                raise ValueError("增强组件下载超出官方发布大小。")
            output.write(chunk)
    if not valid(destination, checksum):
        raise ValueError("增强组件 SHA-256 与固定发布不匹配。")


def install(root, source_dir=None):
    target = root / NAME
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target) as work:
        temp = Path(work)
        if not checked_files(target, {SR_FILE: SR_SHA}):
            file = temp / SR_FILE
            if source_dir is None:
                fetch(SR_URL, file, SR_SHA, 2504012)
            else:
                shutil.copyfile(source_dir / SR_FILE, file)
            if not valid(file, SR_SHA):
                raise ValueError("Real-ESRGAN 文件校验失败。")
            os.replace(file, target / SR_FILE)
        if not checked_files(target, RIFE):
            if source_dir is None:
                archive = temp / "rife.zip"
                fetch(RIFE_URL, archive, RIFE_ARCHIVE, 431540241)
            else:
                archive = source_dir / "rife.zip"
                if not valid(archive, RIFE_ARCHIVE):
                    raise ValueError("RIFE 官方压缩包校验失败。")
            with ZipFile(archive) as bundle:
                for name, checksum in RIFE.items():
                    file = temp / name
                    file.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(RIFE_DIR + "/" + name) as source, file.open("wb") as output:
                        shutil.copyfileobj(source, output)
                    if not valid(file, checksum):
                        raise ValueError("RIFE 发布组件校验失败：" + name)
                for name in RIFE:
                    (target / name).parent.mkdir(parents=True, exist_ok=True)
                    os.replace(temp / name, target / name)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="准备绘遇整片导出的本机 CPU 增强组件")
    parser.add_argument("--models-root", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, help="复用本地官方 rife.zip 和 Real-ESRGAN 权重")
    args = parser.parse_args()
    print(install(args.models_root.resolve(), args.source_dir))
