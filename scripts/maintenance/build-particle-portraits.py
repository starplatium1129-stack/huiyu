# -*- coding: utf-8 -*-
"""
build-particle-portraits.py — 角色图片点阵生成器（2026-08-16，v3 整图复刻）

把 assets/characters/ 下的角色图**整图**（不抠背景，对标 Arknights-FlowingPoints
的完整图片复刻）降采样成点阵网格，写入 assets/particles/p_<角色id>.json，供前端
SemanticParticleField 的 portraitId 重组为完整图片的点阵成像。

依赖（一次性，本机维护用，不入前端包）：
    pip install numpy pillow                # 本机 PyPI 官方源慢且损坏时用镜像：
    pip install -i https://pypi.tuna.tsinghua.edu.cn/simple numpy pillow
    （v3 起不再需要 rembg/rembg 模型；v1/v2 的人物抠像管线见 git 历史）

用法：
    python scripts/maintenance/build-particle-portraits.py            # 全量
    python scripts/maintenance/build-particle-portraits.py rem_rezero # 指定角色

产物格式（见 src/utils/particlePortrait.ts 的 PortraitCloud）：
    { "id": "...", "aspect": <宽/高>, "palette": ["#rrggbb", ...32色],
      "grid": { "w": int, "h": int, "cells": "行拼接字符画" } }
    cells 每字符一个网格：'.'=透明，其余为 base36 调色板序号（0-9a-v）。
    前端按场域实际尺寸重建等距点阵（均匀点距 + 统一点径 + 参考实现物理）。

管线：
    整图 LANCZOS 降到 200px 宽 → k-means 32 主色（确定性初始化）→
    每格最近主色量化 → base36 字符画输出。
"""
import json
import hashlib
import sys
from pathlib import Path

from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CHAR_DIR = ROOT / "assets" / "characters"
OUT_DIR = ROOT / "assets" / "particles"
# 源网格宽：前端点阵 ≤ ~110×160，200px 源网格足够无混叠采样
SOURCE_WIDTH = 200
# 36 色 = base36 索引上限，比 32 色再压回一档量化断层
PALETTE_SIZE = 36
BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"
# 边缘羽化：外圈按概率渐剔除点，只软化矩形边框线（2026-08-16 用户反馈
# 14% 削太多"像没拼完的拼图"，收敛到 5% 仅作边界过渡）
FEATHER_RATIO = 0.05

# 工作室角色立绘文件名与角色 id 的对应（热门角色固定 popular-<id>.png）
STUDIO_PORTRAITS = {"nene": "nene-portrait.webp", "natsume": "natsume-portrait.webp"}


def kmeans_palette(pixels: np.ndarray, k: int, seed: str) -> list[tuple[int, int, int]]:
    """全图像素 k-means（确定性初始化），返回按占比降序的主色——
    32 色足够保留背景/服饰/发色的层次（8 色会明显断层）。"""
    rng = np.random.default_rng(sum(ord(c) for c in seed) % (2 ** 32))
    pixels = pixels.astype(float)
    centers = pixels[rng.choice(len(pixels), size=k, replace=False)]
    assign = None
    for _ in range(12):
        dists = ((pixels[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        assign = dists.argmin(axis=1)
        for i in range(k):
            sel = pixels[assign == i]
            if len(sel):
                centers[i] = sel.mean(axis=0)
    counts = [(assign == i).sum() for i in range(k)]
    ranked = sorted(range(k), key=lambda i: -counts[i])
    return [tuple(int(round(v)) for v in centers[i]) for i in ranked]


def grid_from_image(image: Image.Image, char_id: str) -> tuple[str, int, int, float, list[str]] | None:
    """返回 (cells, 网格宽, 网格高, 宽高比, 调色板)。整图量化，无抠像。

    边缘羽化：四边 FEATHER_RATIO 区域按 smoothstep 概率保留，仅软化矩形
    边界（过大羽化+暗部剔除会让图像"像没拼完的拼图"，2026-08-16 用户
    反馈后收敛为只做边界过渡，不再剔除暗部）。"""
    w0, h0 = image.size
    scale = SOURCE_WIDTH / w0
    small = image.resize((SOURCE_WIDTH, max(1, round(h0 * scale))), Image.LANCZOS).convert("RGBA")
    arr = np.array(small)
    alpha = arr[..., 3]
    rgb = arr[..., :3]
    mask = alpha > 60  # 无透明通道的图全为 True；带透明的立绘 '.' 透出画布底

    palette_rgb = kmeans_palette(rgb[mask], PALETTE_SIZE, char_id)
    palette_arr = np.array(palette_rgb, dtype=float)
    flat = rgb[mask].astype(float)
    dists = ((flat[:, None, :] - palette_arr[None, :, :]) ** 2).sum(axis=2)
    nearest = dists.argmin(axis=1)
    color_index = np.full(mask.shape, -1, dtype=int)
    color_index[mask] = nearest

    # 边缘羽化：确定性 smoothstep 概率（到最近边的距离归一后平滑过渡）
    gh, gw = mask.shape
    rng = np.random.default_rng(sum(ord(c) for c in char_id) % (2 ** 32))
    xs = np.arange(gw) / max(1, gw - 1)
    ys = np.arange(gh) / max(1, gh - 1)
    fx = np.clip(np.minimum(xs, 1 - xs) / FEATHER_RATIO, 0, 1)
    fy = np.clip(np.minimum(ys, 1 - ys) / FEATHER_RATIO, 0, 1)
    fx = fx * fx * (3 - 2 * fx)  # smoothstep
    fy = fy * fy * (3 - 2 * fy)
    keep = rng.random(mask.shape) < fy[:, None] * fx[None, :]
    mask &= keep

    rows = [
        "".join(
            "." if color_index[y, x] < 0 or not mask[y, x] else BASE36[color_index[y, x]]
            for x in range(gw)
        )
        for y in range(gh)
    ]
    aspect = gw / gh
    palette = ["#%02x%02x%02x" % c for c in palette_rgb]
    return "".join(rows), int(gw), int(gh), aspect, palette


def build_one(char_id: str, source: Path) -> bool:
    image = Image.open(source)
    result = grid_from_image(image, char_id)
    if result is None:
        print(f"[skip] {char_id}: 生成失败（{source.name}）")
        return False
    cells, grid_w, grid_h, aspect, palette = result
    filled = len(cells) - cells.count(".")
    if filled < 200:
        print(f"[skip] {char_id}: 有效网格不足（{filled}）")
        return False

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"p_{char_id}.json"
    payload = {
        "id": char_id,
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "aspect": round(aspect, 4),
        "palette": palette,
        "grid": {"w": int(grid_w), "h": int(grid_h), "cells": cells},
    }
    out.write_bytes((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
    print(f"[ok] {char_id}: 网格 {grid_w}x{grid_h}（{filled} 格）{len(palette)} 色 → {out.relative_to(ROOT)} ({out.stat().st_size // 1024}KB)")
    return True


def main() -> None:
    only = set(sys.argv[1:])
    targets: dict[str, Path] = {}
    for path in sorted(CHAR_DIR.glob("popular-*.png")):
        char_id = path.stem.removeprefix("popular-")
        targets[char_id] = path
    for char_id, name in STUDIO_PORTRAITS.items():
        path = CHAR_DIR / name
        if path.exists():
            targets[char_id] = path
    if only:
        targets = {k: v for k, v in targets.items() if k in only}
    if not targets:
        print("没有可处理的图片")
        return
    ok = 0
    for char_id, source in targets.items():
        try:
            ok += build_one(char_id, source)
        except Exception as error:  # 单张失败不阻断批量
            print(f"[fail] {char_id}: {error}")
    print(f"完成 {ok}/{len(targets)}")


if __name__ == "__main__":
    main()
