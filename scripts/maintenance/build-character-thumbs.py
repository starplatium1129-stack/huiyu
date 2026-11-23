#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-character-thumbs.py — 热门角色立绘横条缩略图生成（2026-08-21）

背景：首页「热门角色」横条卡片仅 ~180px 宽，但直接加载
assets/characters/popular-<id>.png 原图（1024px+，单张 ~1.2MB）。
懒加载后首屏仍会拉 13 张 ≈ 15MB，把首页资源预算（3.25MB）打爆 5 倍。
本脚本为全部立绘生成 320px 宽 WebP 缩略图（约 13KB/张），
HomeView 的 portraitSrc 改用 thumbs 后单张体积降 ~99%。

用法：
    python scripts/maintenance/build-character-thumbs.py            # 全量重建缺失/过期
    python scripts/maintenance/build-character-thumbs.py --force    # 无条件重建

约定：
- 输出 assets/characters/thumbs/popular-<id>.webp（源文件同名替换扩展名）
- 源 PNG 更新（如 publish-popular-showcase.js 重发立绘）后需重跑本脚本，
  否则横条显示旧图（mtime 判过期会自动重建）
- 与 build-particle-portraits.py 同样的离线预生成模式：前端零改动、零运行时开销
"""

from concurrent.futures import ThreadPoolExecutor
import os
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "assets" / "characters"
THUMB_DIR = SRC_DIR / "thumbs"
THUMB_WIDTH = 320
WEBP_QUALITY = 72


def build_one(src: Path, dst: Path, force: bool) -> str:
    if not force and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return "skip"
    with Image.open(src) as im:
        ratio = THUMB_WIDTH / im.width
        target = (THUMB_WIDTH, max(1, round(im.height * ratio)))
        converted = im.convert("RGBA") if im.mode not in ("RGB", "RGBA") else im
        resized = converted.resize(target, Image.LANCZOS)
        dst.parent.mkdir(parents=True, exist_ok=True)
        resized.save(dst, "WEBP", quality=WEBP_QUALITY, method=4)
    return "built"


def main() -> int:
    force = "--force" in sys.argv
    sources = sorted(SRC_DIR.glob("popular-*.png"))
    if not sources:
        print(f"no popular-*.png under {SRC_DIR}")
        return 1
    pending: list[tuple[Path, Path]] = []
    skipped = 0
    for src in sources:
        dst = THUMB_DIR / (src.stem + ".webp")
        if not force and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            skipped += 1
        else:
            pending.append((src, dst))

    built = 0
    total_src = total_thumb = 0
    if pending:
        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        if len(pending) == 1:
            src, dst = pending[0]
            if build_one(src, dst, True) == "built":
                built = 1
                total_src = src.stat().st_size
                total_thumb = dst.stat().st_size
        else:
            workers = min(os.cpu_count() or 1, 8, len(pending))

            def run_pair(pair: tuple[Path, Path]) -> tuple[int, int]:
                src, dst = pair
                build_one(src, dst, True)
                return src.stat().st_size, dst.stat().st_size

            with ThreadPoolExecutor(max_workers=workers) as pool:
                for src_bytes, thumb_bytes in pool.map(run_pair, pending):
                    built += 1
                    total_src += src_bytes
                    total_thumb += thumb_bytes
    print(f"built={built} skipped={skipped}")
    if built:
        print(
            f"src {total_src // 1024}KB -> thumbs {total_thumb // 1024}KB "
            f"({round(100 * total_thumb / max(1, total_src))}% of source)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
