'use strict';

// inpaint-showcase-candidates: mask generation, previews and pixel inspection.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { spawnSync }: typeof import('child_process') = require('child_process');
const { decodePng8, luminance }: typeof import('../maintenance/png-probe.js') = require('../maintenance/png-probe.js');
const {
  KEYS, INPAINT_CONFIG, CROP_SIZE, PREVIEW_GRID, PREVIEW_SCALE, MASKGEN, SOURCE_WIDTH, SOURCE_HEIGHT,
}: typeof import('./inpaint-showcase-candidates-records.js') = require('./inpaint-showcase-candidates-records.js');

// ── preview generation ──────────────────────────────────────────────────────

function generatePreviews(outputDir: any, sourceRecords: any) {
  const previewDir = path.join(outputDir, 'inpaint-previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const made: any[] = [];
  for (const key of KEYS) {
    const record = sourceRecords[key];
    if (!record) continue;
    const cfg = INPAINT_CONFIG[key];
    const cx = cfg.ops[0].crop.x + CROP_SIZE / 2;
    const cy = cfg.ops[0].crop.y + CROP_SIZE / 2;
    const outFile = path.join(previewDir, `face-crop_${key.replace(/[:\/\\]/g, '_')}.png`);
    const half = Math.floor(CROP_SIZE / 2);
    const step = PREVIEW_GRID * PREVIEW_SCALE;
    const code = `
from PIL import Image, ImageDraw
img = Image.open(${JSON.stringify(record.file)}).convert("RGB")
W, H = img.size
half = ${half}
x0 = max(0, ${cx} - half); y0 = max(0, ${cy} - half)
x1 = min(W, x0 + half * 2); y1 = min(H, y0 + half * 2)
crop = img.crop((x0, y0, x1, y1))
scale = ${PREVIEW_SCALE}
crop = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)
d = ImageDraw.Draw(crop)
step = ${step}
for i in range(0, crop.width // step + 1):
    d.line([(i*step, 0), (i*step, crop.height)], fill=(255,0,0,255), width=1)
for j in range(0, crop.height // step + 1):
    d.line([(0, j*step), (crop.width, j*step)], fill=(255,0,0,255), width=1)
d.line([(crop.width//2-15, crop.height//2), (crop.width//2+15, crop.height//2)], fill=(0,255,0,255), width=2)
d.line([(crop.width//2, crop.height//2-15), (crop.width//2, crop.height//2+15)], fill=(0,255,0,255), width=2)
crop.save(${JSON.stringify(outFile)}, "PNG")
print(${JSON.stringify(outFile)})
`;
    const result = spawnSync(pythonBin(), ['-c', code], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) made.push(outFile);
  }
  return made;
}

let _python = '';

function setPython(value: any) {
  _python = value || 'python';
}

function pythonBin() {
  return _python || 'python';
}

// ── mask generation ─────────────────────────────────────────────────────────

function buildMaskArgs(op: any) {
  const args: any[] = [];
  for (const shape of op.mask) {
    if (shape.kind === 'ellipse') {
      args.push('--ellipse', String(shape.cx), String(shape.cy), String(shape.rx), String(shape.ry), String(shape.feather));
    } else if (shape.kind === 'rect') {
      args.push('--rect', String(shape.x0), String(shape.y0), String(shape.x1), String(shape.y1), String(shape.feather));
    }
  }
  return args;
}

function generateMask(outputDir: any, key: any, op: any, denoiseConfig: any) {
  const safeKey = key.replace(/[:\/\\]/g, '_');
  const maskDir = path.join(outputDir, 'inpaint-masks');
  fs.mkdirSync(maskDir, { recursive: true });
  const outFile = path.join(maskDir, `${safeKey}_${op.id}_${denoiseConfig.id}.png`);
  if (fs.existsSync(outFile)) return outFile;
  const result = spawnSync(pythonBin(), [
    MASKGEN, outFile, String(SOURCE_WIDTH), String(SOURCE_HEIGHT), ...buildMaskArgs(op),
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`mask generation failed: ${result.stderr || result.stdout || 'unknown'}`);
  }
  return outFile;
}

// ── feature heuristics (bounded retry gate) ────────────────────────────────

function sampleRegion(buffer: any, cx: any, cy: any, radius: any) {
  // decode PNG, sample mean luminance in a radius circle; returns {mean, min}
  const image = decodePng8(buffer);
  if (!image || radius < 0) return null;
  let count = 0;
  let min = 255;
  let sum = 0;
  for (let y = Math.max(0, cy - radius); y <= Math.min(image.height - 1, cy + radius); y += 1) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(image.width - 1, cx + radius); x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
      const rgb = image.rgbAt(x, y);
      if (!rgb) continue;
      const value = luminance(rgb);
      min = Math.min(min, value);
      sum += value;
      count += 1;
    }
  }
  return count ? { count, min, mean: sum / count } : null;
}

function countRedPixels(buffer: any, x0: any, y0: any, x1: any, y1: any) {
  const image = decodePng8(buffer);
  if (!image) return 0;
  let count = 0;
  for (let y = Math.max(0, y0); y < Math.min(image.height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(image.width, x1); x += 1) {
      const rgb = image.rgbAt(x, y);
      if (!rgb) continue;
      const [red, green, blue] = rgb;
      if (red > 120 && red > green + 40 && red > blue + 40) count += 1;
    }
  }
  return count;
}

function opLooksDone(op: any, outputBuffer: any, sourceBuffer: any) {
  // compare the OUTPUT against the op's INPUT (stage source): a mole removed
  // must lighten the mask core, a mole added must darken it, hairclips must add
  // red pixels. Relative-to-source checks are robust to the tiny feature sizes.
  if (op.kind === 'remove') {
    const shape = op.mask[0];
    if (!shape || shape.kind !== 'ellipse') return true;
    const srcProbe = sourceBuffer ? sampleRegion(sourceBuffer, shape.cx, shape.cy, 6) : null;
    const outProbe = sampleRegion(outputBuffer, shape.cx, shape.cy, 6);
    if (!outProbe || !outProbe.count) return false;
    if (srcProbe && srcProbe.count) {
      // the mole should get notably lighter than it was
      return outProbe.min > srcProbe.min + 25;
    }
    // no baseline: plain skin check on a tight core (avoid lash/eye shadow)
    return outProbe.min > 140 && outProbe.mean > 180;
  }
  if (op.id === 'add-hairclips') {
    // the two clips land near/around the mask centers; the surrounding flower
    // bleeds red into individual mask boxes, so judge a single band spanning the
    // mask centers instead. op.clipBand (full-image coords) overrides the derived
    // band when a flower sits directly beside the clip zone.
    const ellipses = op.mask.filter((shape: any) => shape.kind === 'ellipse');
    if (!ellipses.length) return false;
    const xs = ellipses.map((shape: any) => shape.cx);
    const ys = ellipses.map((shape: any) => shape.cy);
    const band = op.clipBand || {
      x0: Math.min(...xs) - 17,
      y0: Math.min(...ys) - 14,
      x1: Math.max(...xs) + 17,
      y1: Math.max(...ys) + 14,
    };
    const outRed = countRedPixels(outputBuffer, band.x0, band.y0, band.x1, band.y1);
    if (outRed < 40) return false;
    if (!sourceBuffer) return true;
    const srcRed = countRedPixels(sourceBuffer, band.x0, band.y0, band.x1, band.y1);
    return outRed - srcRed >= 30;
  }
  // add-mole: the mask core must get darker than the op's input
  const shape = op.mask[0];
  if (!shape || shape.kind !== 'ellipse') return true;
  const srcProbe = sourceBuffer ? sampleRegion(sourceBuffer, shape.cx, shape.cy, 6) : null;
  const outProbe = sampleRegion(outputBuffer, shape.cx, shape.cy, 6);
  if (!outProbe || !outProbe.count) return false;
  if (srcProbe && srcProbe.count) {
    return outProbe.min < srcProbe.min - 20;
  }
  return outProbe.min < 110;
}

export = { generateMask, opLooksDone, setPython, generatePreviews, buildMaskArgs };
