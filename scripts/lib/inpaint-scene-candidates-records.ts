'use strict';

// inpaint-scene-candidates: candidate configuration and persisted record validation.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');

const AI_ROOT = path.resolve(ROOT, '..', 'AI');

const DEFAULT_OUTPUT = path.join(AI_ROOT, 'Reviews', 'SceneShowcaseRefresh', '2026-08-12_current-prompts');

const SCENE_SHOWCASE_DIR = path.resolve(AI_ROOT, 'SceneShowcase');

const MANIFEST_NAME = 'generation-manifest.json';

const MASKGEN = path.join(__dirname, '..', 'maintenance', 'inpaint-maskgen.py');

const UPSCALE = 3;

const POLL_INTERVAL_MS = 800;

const JOB_TIMEOUT_MS = 8 * 60 * 1000;

const PREVIEW_GRID = 25;

const PREVIEW_SCALE = 3;

// Bounded denoise configs, tried in order. Primary = SetLatentNoiseMask low
// denoise (discussion #639 recommendation for masked img2img). Fallback =
// "true inpainting" VAEEncodeForInpaint @ 1.0 (official inpaint tutorial).
const DENOISE_CONFIGS = Object.freeze([
  { id: 'masked-0.70', mode: 'set-noisy-mask', denoise: 0.7 },
  { id: 'inpaint-1.00', mode: 'vae-inpaint', denoise: 1.0 },
]);

// ── geometry (full-image space) ──────────────────────────────────────────
// Coordinates were measured against the source images with the local vision
// pipeline (grid-labeled crop previews land in <output>/inpaint-scene-previews/
// on every run; adjust here and re-run if a preview shows drift).
//
// sc037 source attempt-8 (832x1216): gripping hand ≈ x400-430 y522-555, cat
// charm ≈ x413-435 y530-590. One ellipse covers hand + charm; the face
// (y295-400), hair, and clothing stay outside the crop/mask.
//
// sc280 source attempt-6 (1216x832): cellophane wrapper + top knot ≈
// x550-660 y549-635, hands start below y635. The mask covers only the wrapper
// so the clean palms and fingers are preserved verbatim (verified against the
// grid preview, 2026-08-12).
const SCENE_INPAINT_CONFIG: any = Object.freeze({
  'scene:sc037': {
    sourceAttempt: 8,
    width: 832,
    height: 1216,
    engine: 'anima',
    unet: 'anima-base-v1.0.safetensors',
    clip: 'qwen_3_06b_base.safetensors',
    vae: 'qwen_image_vae.safetensors',
    lora: { file: 'shiki_natsume_v21_anima.safetensors', strength: 0.85 },
    steps: 30,
    cfg: 4.5,
    sampler: 'res_multistep',
    scheduler: 'simple',
    ops: [
      {
        id: 'replace-charm',
        crop: { x: 350, y: 480, w: 140, h: 150 },
        mask: [
          { kind: 'ellipse', cx: 418, cy: 555, rx: 28, ry: 46, feather: 10 },
        ],
        prompt:
          '(a small rectangular Japanese cloth omamori:1.2), embroidered brocade pouch, woven fabric texture, braided knot hanging loop, tiny tassel, one hand holding a fabric amulet, clean fingers',
        negative:
          'cat charm, porcelain cat, white cat figurine, plastic figurine, keychain, cat ears, cat face, extra fingers, deformed hand, fused fingers, blurred fingers',
      },
    ],
  },
  'scene:sc280': {
    sourceAttempt: 6,
    width: 1216,
    height: 832,
    engine: 'anima',
    unet: 'anima-base-v1.0.safetensors',
    clip: 'qwen_3_06b_base.safetensors',
    vae: 'qwen_image_vae.safetensors',
    lora: { file: 'shiki_natsume_v21_anima.safetensors', strength: 0.85 },
    steps: 30,
    cfg: 4.5,
    sampler: 'res_multistep',
    scheduler: 'simple',
    ops: [
      {
        id: 'replace-wrapper',
        crop: { x: 480, y: 530, w: 280, h: 180 },
        mask: [
          { kind: 'ellipse', cx: 605, cy: 592, rx: 55, ry: 43, feather: 10 },
        ],
        prompt:
          '(an opaque brown kraft paper bag with a folded top closure:1.3), sealed kraft pouch, matte brown paper, folded paper top, natural paper creases, a pastry wrapped in opaque folded kraft paper',
        negative:
          'transparent plastic bag, clear cellophane, glassine, see-through wrapper, shiny plastic reflection, visible pastry inside, open bag, glossy surface, extra fingers, deformed hand',
      },
      {
        // attempt-9 masked-0.70 kept the transparent bag (review 2026-08-12);
        // this stage forces the bounded true-inpaint fallback with a heavier
        // material rewrite on the already-masked region only.
        id: 'replace-wrapper-inpaint',
        denoiseOrder: ['inpaint-1.00'],
        crop: { x: 480, y: 530, w: 280, h: 180 },
        mask: [
          { kind: 'ellipse', cx: 605, cy: 592, rx: 55, ry: 43, feather: 10 },
        ],
        prompt:
          '(a small pastry wrapped in an opaque brown kraft paper pouch:1.4), sealed folded top, matte kraft paper texture, paper creases, no transparency, warm indoor lighting',
        negative:
          'transparent plastic bag, clear cellophane, glassine, see-through wrapper, shiny plastic reflection, glossy highlight, visible pastry through packaging, open bag, extra fingers, deformed hand',
      },
      {
        // attempt-9 v2 review (2026-08-12): kraft paper landed but the lower
        // left edge still leaks pastry and the pouch floats over the palms.
        // One bounded low-denoise blend stage over the wrapper bottom and the
        // palm contact band for occlusion shadow + seam removal.
        id: 'replace-wrapper-blend',
        denoiseOrder: ['masked-0.70'],
        crop: { x: 480, y: 530, w: 280, h: 180 },
        mask: [
          { kind: 'ellipse', cx: 605, cy: 612, rx: 62, ry: 60, feather: 10 },
        ],
        prompt:
          '(an opaque brown kraft paper pouch with a folded top:1.2), matte paper, natural creases, soft contact shadow where the pouch rests on the palms, seamless integration with the hands',
        negative:
          'transparent plastic, plastic shine, glassine, visible pastry through packaging, white spots, floating object, hard seam, harsh edge, glossy highlight, extra fingers, deformed hand',
      },
    ],
  },
  'scene:sc214': {
    sourceAttempt: 15,
    attempt: 16,
    width: 832,
    height: 1216,
    engine: 'anima',
    unet: 'anima-base-v1.0.safetensors',
    clip: 'qwen_3_06b_base.safetensors',
    vae: 'qwen_image_vae.safetensors',
    lora: { file: 'shiki_natsume_v21_anima.safetensors', strength: 0.85 },
    steps: 30,
    cfg: 4.5,
    sampler: 'res_multistep',
    scheduler: 'simple',
    ops: [
      {
        // 6 次全量重出（attempt-10..15）背景始终是普通储物间；
        // 改用局部修复只重绘四块纯背景区域为步入式冷库（人物完全排除）。
        id: 'replace-background-freezer',
        denoiseOrder: ['masked-0.70'],
        crop: { x: 0, y: 0, w: 832, h: 1216 },
        mask: [
          { kind: 'rect', x0: 0, y0: 0, x1: 190, y1: 240, feather: 8 },
          { kind: 'rect', x0: 0, y0: 240, x1: 75, y1: 650, feather: 8 },
          { kind: 'rect', x0: 700, y0: 0, x1: 832, y1: 220, feather: 8 },
          { kind: 'rect', x0: 780, y0: 220, x1: 832, y1: 450, feather: 6 },
        ],
        prompt:
          'walk-in freezer, industrial cold room, stainless steel metal shelving, frosted metal surfaces, heavy ice crystals, frozen storage boxes, cold blue ambient lighting, dense white mist, icy frost on wall, detailed background',
        negative:
          'wooden closet, wooden cabinet, shutters, dark storage room, clutter, cardboard boxes, text, watermark, signature, warm lighting, orange glow, blur, low resolution, human, body parts, girl',
      },
    ],
  },
});

const KEYS = Object.freeze(Object.keys(SCENE_INPAINT_CONFIG));

const ATTEMPT = 9;

function attemptFor(key: any) {
  const cfg = SCENE_INPAINT_CONFIG[key];
  return cfg && Number.isInteger(cfg.attempt) ? cfg.attempt : ATTEMPT;
}

function argument(name: any, fallback: any = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function splitList(value: any) {
  return String(value || '')
    .split(',')
    .map((part: any) => part.trim())
    .filter(Boolean);
}

function readJson(file: any) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}



function imageInfo(buffer: any) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return null;
}

function sha256(buffer: any) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertNotShowcase(dir: any) {
  const resolved = path.resolve(dir);
  const showcase = path.resolve(SCENE_SHOWCASE_DIR);
  const rel = path.relative(showcase, resolved);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside) throw new Error(`refusing to write into the public SceneShowcase directory: ${resolved}`);
  return resolved;
}

// ── source records ─────────────────────────────────────────────────────────

function sourceRecordFor(manifest: any, key: any) {
  const attempt = SCENE_INPAINT_CONFIG[key].sourceAttempt;
  return manifest.find((record: any) => record.recordId === `${key}@attempt-${attempt}`);
}

function validateSourceRecord(key: any, record: any, outputDir: any) {
  const cfg = SCENE_INPAINT_CONFIG[key];
  if (!record) throw new Error(`missing attempt-${cfg.sourceAttempt} source record for ${key}`);
  if (record.status !== 'succeeded') {
    throw new Error(`attempt-${cfg.sourceAttempt} source for ${key} is not succeeded (${record.status})`);
  }
  const file = path.join(outputDir, String(record.image || '').split('/').join(path.sep));
  if (!fs.existsSync(file)) throw new Error(`source image missing for ${key}: ${file}`);
  const buffer = fs.readFileSync(file);
  const hash = sha256(buffer);
  if (record.sha256 && hash !== record.sha256) {
    throw new Error(`source hash mismatch for ${key}: manifest ${record.sha256} != file ${hash}`);
  }
  const info = imageInfo(buffer);
  if (!info || info.width !== cfg.width || info.height !== cfg.height) {
    throw new Error(`source for ${key} is not ${cfg.width}x${cfg.height} (${info ? `${info.width}x${info.height}` : 'non-image'})`);
  }
  return { buffer, file, hash };
}

function attemptRecordId(key: any) {
  return `${key}@attempt-${attemptFor(key)}`;
}

function outputImageRel(key: any) {
  const sceneId = key.split(':')[1];
  return `images/${sceneId}/attempt-${attemptFor(key)}.png`;
}

function shouldReuse(key: any, record: any, imageFile: any, force: any) {
  const cfg = SCENE_INPAINT_CONFIG[key];
  if (force) return false;
  if (!record || record.status !== 'succeeded' || !record.image) return false;
  if (!fs.existsSync(imageFile)) return false;
  const buffer = fs.readFileSync(imageFile);
  if (buffer.length < 1000) return false;
  const info = imageInfo(buffer);
  if (!info || info.width !== cfg.width || info.height !== cfg.height) return false;
  if (record.sha256 && sha256(buffer) !== record.sha256) return false;
  return true;
}

export = {
  SCENE_INPAINT_CONFIG, PREVIEW_GRID, PREVIEW_SCALE, JOB_TIMEOUT_MS, POLL_INTERVAL_MS, UPSCALE,
  MASKGEN, attemptFor, attemptRecordId, outputImageRel, sha256, sourceRecordFor, validateSourceRecord,
  shouldReuse, DENOISE_CONFIGS, imageInfo, argument, DEFAULT_OUTPUT, MANIFEST_NAME,
  assertNotShowcase, splitList, KEYS, readJson, ATTEMPT, ROOT, AI_ROOT, SCENE_SHOWCASE_DIR,
};
