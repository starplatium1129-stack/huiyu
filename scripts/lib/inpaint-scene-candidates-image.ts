'use strict';

// inpaint-scene-candidates: mask generation, previews and pixel inspection.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { spawnSync }: typeof import('child_process') = require('child_process');
const { decodePng8, luminance }: typeof import('../maintenance/png-probe.js') = require('../maintenance/png-probe.js');
const { SCENE_INPAINT_CONFIG, PREVIEW_GRID, PREVIEW_SCALE, MASKGEN }: typeof import('./inpaint-scene-candidates-records.js') = require('./inpaint-scene-candidates-records.js');

let _python = '';

function setPython(value: any) {
  _python = value || 'python';
}

function pythonBin() {
  return _python || 'python';
}

// ── previews ───────────────────────────────────────────────────────────────

function generatePreviews(outputDir: any, key: any, sourceFile: any) {
  const cfg = SCENE_INPAINT_CONFIG[key];
  const previewDir = path.join(outputDir, 'inpaint-scene-previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const made: any[] = [];
  for (const op of cfg.ops) {
    const safeKey = key.replace(/[:\/\\]/g, '_');
    const outFile = path.join(previewDir, `${safeKey}_${op.id}_grid.png`);
    const step = PREVIEW_GRID * PREVIEW_SCALE;
    const code = `
from PIL import Image, ImageDraw
img = Image.open(${JSON.stringify(sourceFile)}).convert("RGB")
W, H = img.size
x0 = max(0, ${op.crop.x}); y0 = max(0, ${op.crop.y})
x1 = min(W, x0 + ${op.crop.w}); y1 = min(H, y0 + ${op.crop.h})
crop = img.crop((x0, y0, x1, y1))
scale = ${PREVIEW_SCALE}
crop = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)
d = ImageDraw.Draw(crop)
step = ${step}
for i in range(0, crop.width // step + 1):
    d.line([(i*step, 0), (i*step, crop.height)], fill=(255,0,0,255), width=1)
for j in range(0, crop.height // step + 1):
    d.line([(0, j*step), (crop.width, j*step)], fill=(255,0,0,255), width=1)
for shape in ${JSON.stringify(op.mask)}:
    if shape['kind'] == 'ellipse':
        cxx = (shape['cx'] - x0) * scale; cyy = (shape['cy'] - y0) * scale
        rxx = shape['rx'] * scale; ryy = shape['ry'] * scale
        d.ellipse([cxx - rxx, cyy - ryy, cxx + rxx, cyy + ryy], outline=(0,255,0,255), width=2)
crop.save(${JSON.stringify(outFile)}, "PNG")
print(${JSON.stringify(outFile)})
`;
    const result = spawnSync(pythonBin(), ['-c', code], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) made.push(outFile);
    else console.log(`[preview] ${key} ${op.id} failed: ${result.stderr || result.stdout}`);
  }
  return made;
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
  const cfg = SCENE_INPAINT_CONFIG[key];
  const safeKey = key.replace(/[:\/\\]/g, '_');
  const maskDir = path.join(outputDir, 'inpaint-scene-masks');
  fs.mkdirSync(maskDir, { recursive: true });
  const outFile = path.join(maskDir, `${safeKey}_${op.id}_${denoiseConfig.id}.png`);
  if (fs.existsSync(outFile)) return outFile;
  const result = spawnSync(pythonBin(), [
    MASKGEN, outFile, String(cfg.width), String(cfg.height), ...buildMaskArgs(op),
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`mask generation failed: ${result.stderr || result.stdout || 'unknown'}`);
  }
  return outFile;
}

// ── bounded retry gate: mean luminance delta inside the mask core ───────────

function maskCoreDelta(outputBuffer: any, sourceBuffer: any, shape: any) {
  if (!shape || shape.kind !== 'ellipse') return null;
  const probe = (buffer: any) => {
    const image = decodePng8(buffer);
    if (!image || shape.rx <= 0 || shape.ry <= 0) return null;
    let count = 0;
    let sum = 0;
    for (let y = Math.max(0, shape.cy - shape.ry); y <= Math.min(image.height - 1, shape.cy + shape.ry); y += 1) {
      for (let x = Math.max(0, shape.cx - shape.rx); x <= Math.min(image.width - 1, shape.cx + shape.rx); x += 1) {
        if (((x - shape.cx) / shape.rx) ** 2 + ((y - shape.cy) / shape.ry) ** 2 <= 1) {
          const rgb = image.rgbAt(x, y);
          if (!rgb) continue;
          sum += luminance(rgb);
          count += 1;
        }
      }
    }
    return { count, sum };
  };
  const source = probe(sourceBuffer);
  const output = probe(outputBuffer);
  if (!source || !output || !source.count || !output.count) return null;
  return Math.abs(output.sum / output.count - source.sum / source.count);
}

function opLooksDone(op: any, outputBuffer: any, sourceBuffer: any) {
  // Material/prop replacement ops have no reliable local feature detector;
  // gate on "the masked region actually changed" so an unchanged region
  // triggers the one fixed true-inpaint fallback instead of silently passing.
  const shape = op.mask.find((item: any) => item.kind === 'ellipse');
  if (!shape) return true;
  const delta = maskCoreDelta(outputBuffer, sourceBuffer, shape);
  if (delta === null) return false;
  return delta >= 6;
}

export = { generateMask, opLooksDone, setPython, generatePreviews, buildMaskArgs, maskCoreDelta };
