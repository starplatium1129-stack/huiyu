"""CPU primitives adapted from ComfyUI-MangaScreen, MIT, Copyright (c) 2026 ashukae.
Source: https://github.com/ashukae/ComfyUI-MangaScreen
Revision: d0eb8dcc6c45274e3eee118ff0dabe05b56039b9; see MANGASCREEN_LICENSE.txt.
Local changes: remove Comfy/Torch wrappers; add phase cancellation; fix zero border.
No model execution or automatic resource downloads.
"""
import cv2
import numpy as np
ANGLE = 45.0


def print_screen(cover, pitch):
    """Page-aligned AM dots for a coverage map, rendered 3x supersampled so dots are round."""
    h, w = cover.shape
    s = 3
    hs, ws = h * s, w * s
    a = np.deg2rad(ANGLE)
    scale = (2.0 * np.pi) / (pitch * s)
    alpha = scale * np.cos(a)
    beta = scale * np.sin(a)
    xs = np.arange(ws, dtype=np.float64)
    ys = np.arange(hs, dtype=np.float64)
    c = cv2.resize(cover, (ws, hs), interpolation=cv2.INTER_LINEAR)
    out = np.empty((h, w), dtype=bool)
    band_rows = 128
    if ANGLE == 45.0:
        # cos(k*y + k*x) + cos(k*y - k*x) == 2*cos(k*y)*cos(k*x); avoids 3x*3x 2D trig grids.
        cos_x = np.cos(alpha * xs).astype(np.float32)
        neg_half_cos_y = (-0.5 * np.cos(alpha * ys)).astype(np.float32)
        for y0 in range(0, h, band_rows):
            y1 = min(h, y0 + band_rows)
            spot = np.float32(0.5) + neg_half_cos_y[y0 * s:y1 * s, None] * cos_x[None, :]
            hits = spot < c[y0 * s:y1 * s]
            # Exact 3x3 area average of zeros and ones, rounded to uint8:
            # 0..4 hits become zero and 5..9 become one (no half ties).
            out[y0:y1] = cv2.resize(hits.view(np.uint8), (w, y1 - y0), interpolation=cv2.INTER_AREA)
    else:
        cos_ax = np.cos(alpha * xs).astype(np.float32)
        sin_ax = np.sin(alpha * xs).astype(np.float32)
        cos_bx = np.cos(beta * xs).astype(np.float32)
        sin_bx = np.sin(beta * xs).astype(np.float32)
        cos_ay = np.cos(alpha * ys).astype(np.float32)
        sin_ay = np.sin(alpha * ys).astype(np.float32)
        cos_by = np.cos(beta * ys).astype(np.float32)
        sin_by = np.sin(beta * ys).astype(np.float32)
        for y0 in range(0, h, band_rows):
            y1 = min(h, y0 + band_rows)
            ys_slice = slice(y0 * s, y1 * s)
            cos_sum = (
                cos_by[ys_slice, None] * cos_ax[None, :]
                - sin_by[ys_slice, None] * sin_ax[None, :]
                + cos_ay[ys_slice, None] * cos_bx[None, :]
                + sin_ay[ys_slice, None] * sin_bx[None, :]
            )
            spot = np.float32(0.5) - np.float32(0.25) * cos_sum
            hits = spot < c[ys_slice]
            out[y0:y1] = cv2.resize(hits.view(np.uint8), (w, y1 - y0), interpolation=cv2.INTER_AREA)
    return out


def ink_layer(L, k, solid):
    """Lines and solid blacks as a crisp mask. k is the image scale relative to 1024 px width."""
    Lb = cv2.GaussianBlur(L, (0, 0), 0.7 * k)
    line = (Lb < cv2.blur(Lb, (int(15 * k) | 1,) * 2) - 0.07) & (Lb < 0.65)
    _, lab, st, _ = cv2.connectedComponentsWithStats(line.astype(np.uint8), connectivity=8)
    w, h, area = st[:, cv2.CC_STAT_WIDTH], st[:, cv2.CC_STAT_HEIGHT], st[:, cv2.CC_STAT_AREA]
    # a stroke is long and thin; a dot, or a clump of generated dots, is compact
    keep = (np.maximum(w, h) >= 10 * k) & (area >= 12 * k * k) & (area < 0.6 * w * h + 40 * k * k)
    keep |= area >= 400 * k * k
    keep[0] = False
    ink = solid | keep[lab]
    _, lab, st, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), connectivity=8)
    big = st[:, cv2.CC_STAT_AREA] >= 6 * k * k
    big[0] = False
    return big[lab]


def value_map(L, ink, k):
    """Descreened value with the ink masked out (normalized convolution), so lines leave no dark
    halo for the screen to pick up, then edge-preserving flattening."""
    m = (~ink).astype(np.float32)
    s = 2.5 * k
    V = cv2.GaussianBlur(L * m, (0, 0), s) / np.maximum(cv2.GaussianBlur(m, (0, 0), s), 1e-3)
    for _ in range(2):
        V = cv2.bilateralFilter(V, int(9 * k) | 1, 0.10, 9 * k)
    return V


def tone_plan(V, k, white, split, black, min_region=600):
    """0 white, 1 light tone, 2 dark tone, 3 black. Regions under min_region px (at 1024 px width)
    melt into their surroundings, so every tone is a deliberate flat area."""
    level = cv2.medianBlur(np.digitize(-V, [-white, -split, -black]).astype(np.uint8), int(11 * k) | 1)
    for lv in (1, 2, 3, 0):
        mask = level == lv
        if not mask.any():
            continue
        _, lab, st, _ = cv2.connectedComponentsWithStats(mask.view(np.uint8), connectivity=4)
        small = st[:, cv2.CC_STAT_AREA] < min_region * k * k
        small[0] = False
        hole = small[lab]
        if hole.any():
            fill = cv2.medianBlur(np.where(hole, np.uint8(255), level), int(21 * k) | 1)
            replace = hole & (fill != 255)
            level[replace] = fill[replace]
    return level


def region_spread(level, V):
    """Standard deviation of V inside each flat region of the plan: a region that hides a gradient spreads wide."""
    out = np.zeros(V.shape, dtype=np.float32)
    v_flat = V.ravel()
    v2_flat = v_flat * v_flat
    for lv in range(4):
        mask = level == lv
        if not mask.any():
            continue
        n, lab = cv2.connectedComponents(mask.view(np.uint8), connectivity=4)
        flat = lab.ravel()
        cnt = np.maximum(np.bincount(flat, minlength=n), 1)
        mean = np.bincount(flat, v_flat, minlength=n) / cnt
        std = np.sqrt(np.maximum(np.bincount(flat, v2_flat, minlength=n) / cnt - mean * mean, 0)).astype(np.float32)
        out[mask] = std[lab[mask]]
    return out


def white_cut(candidates, k):
    """The strokes worth keeping in white inside beta: long ones only, thinned, so a dark coat shows
    its main folds and seams instead of looking like an inverted line drawing."""
    _, lab, st, _ = cv2.connectedComponentsWithStats(candidates.astype(np.uint8), connectivity=8)
    keep = np.maximum(st[:, cv2.CC_STAT_WIDTH], st[:, cv2.CC_STAT_HEIGHT]) >= 40 * k
    keep[0] = False
    return cv2.erode(keep[lab].astype(np.uint8), np.ones((2 if k < 1.6 else 3,) * 2, np.uint8)) > 0


def finish(img, lines, white, black, light_tone, dark_tone, gradation, pen, pen_threshold, white_lines, control):
    """pen: line strength map (0..1) drawn on top, or None."""
    L = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255
    k = L.shape[1] / 1024
    control.stage("manga_lines")
    solid = cv2.GaussianBlur(L, (0, 0), 1.5 * k) < 0.22
    ink = ink_layer(L, k, solid)
    strokes = ink & ~solid
    del solid
    if pen is not None:
        strokes |= pen > pen_threshold
    control.stage("manga_values")
    V = value_map(L, ink, k)
    control.stage("manga_tones")
    level = tone_plan(V, k, white, (white + black) / 2, black)
    cover = np.take(np.float32((0.0, light_tone, dark_tone, 1.0)), level)
    if gradation:
        # gradation tone: where a flat region hides a ramp, the dot area follows the darkness instead
        Vs = cv2.GaussianBlur(V, (0, 0), 3 * k)
        a = cv2.GaussianBlur(np.clip((region_spread(level, Vs) - 0.03) / 0.05, 0, 1) * gradation, (0, 0), 4 * k)
        cover = cover * (1 - a) + np.clip((white - Vs) / (white - black), 0, 1) * a
    control.stage("manga_screen")
    page = print_screen(cover, L.shape[1] / lines) | ink | strokes
    control.check()
    if white_lines:
        # black on black is invisible: inside beta the main strokes (folds, seams, zips) are cut out
        # in white, the way a dark coat is inked; the region is shrunk so its outline stays black
        beta = cv2.erode((level == 3).astype(np.uint8), np.ones((int(3 * k) | 1,) * 2, np.uint8)) > 0
        candidates = strokes if pen is None else pen > 1 - white_lines
        page = (page | beta) & ~(beta & white_cut(candidates, k))
    return ~page


FRAMES = {"original": None, "4:3 wide": 4 / 3, "16:9 wide": 16 / 9, "3:4 tall": 3 / 4, "1:1": 1.0}
PAPERS = {"white": ((255, 255, 255), 0.0), "off-white": ((251, 250, 247), 1.5), "cream": ((246, 243, 236), 3.0)}
INK_RGB = np.float32((26, 25, 28))


def noise(h, w, scales, seed):
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32)
    for s, amp in scales:
        nh, nw = max(2, h // s), max(2, w // s)
        n = rng.standard_normal((nh, nw)).astype(np.float32)
        if nh != h or nw != w:
            n = cv2.resize(n, (w, h), interpolation=cv2.INTER_CUBIC)
        out += amp * n
    return out


def cut_panel(ink, ratio, x, y, border, margin):
    """Crop the largest window of the given aspect at (x, y), draw the panel border, add the page margin."""
    h, w = ink.shape
    cw, ch = (w, h) if ratio is None else ((w, round(w / ratio)) if w / h <= ratio else (round(h * ratio), h))
    cw, ch = min(cw, w), min(ch, h)
    x0, y0 = round((w - cw) * x), round((h - ch) * y)
    p = ink[y0:y0 + ch, x0:x0 + cw].copy()
    # Upstream's [-0:] paints the whole panel; zero explicitly means no border.
    if border:
        p[:border] = p[-border:] = True
        p[:, :border] = p[:, -border:] = True
    return np.pad(p, margin, constant_values=False)


def print_look(ink, paper, strength, k):
    """Ink spreads a fraction of a pixel and its density mottles a little; paper colour and fibre."""
    h, w = ink.shape
    a = ink.astype(np.float32)
    if strength:
        a = np.clip((cv2.GaussianBlur(a, (0, 0), 0.6 * k * strength) - 0.35) / 0.4, 0, 1)
        a *= 1 - 0.05 * strength * (0.5 + 0.5 * np.tanh(noise(h, w, [(int(64 * k), 1.0), (int(16 * k), 0.5)], 1)))
    rgb, fibre = PAPERS[paper]
    base = np.float32(rgb)[None, None]
    if fibre:
        base = base + fibre * noise(h, w, [(3, 1.0), (1, 0.6)], 2)[..., None]
    return np.clip(base * (1 - a[..., None]) + INK_RGB * strength * a[..., None], 0, 255)
