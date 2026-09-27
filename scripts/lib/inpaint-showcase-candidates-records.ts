'use strict';

// inpaint-showcase-candidates: candidate configuration and persisted record validation.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');

const AI_ROOT = path.resolve(ROOT, '..', 'AI');

const DEFAULT_OUTPUT = path.join(
  AI_ROOT,
  'Reviews',
  'ShowcaseRefresh',
  '2026-08-12_artist_popular_latest-lora',
);

const SCENE_SHOWCASE_DIR = path.resolve(AI_ROOT, 'SceneShowcase');

const MANIFEST_NAME = 'generation-manifest.json';

const REVIEW_INDEX_NAME = 'review-index.json';

const CONTACT_SHEET_NAME = 'contact-sheet.html';

const MASKGEN = path.join(__dirname, '..', 'maintenance', 'inpaint-maskgen.py');

const SOURCE_WIDTH = 960;

const SOURCE_HEIGHT = 1536;

const UPSCALE = 3;

const CROP_SIZE = 300;

const PREVIEW_GRID = 25;

const PREVIEW_SCALE = 4;

const POLL_INTERVAL_MS = 800;

const JOB_TIMEOUT_MS = 8 * 60 * 1000;

// Denoise configs, tried in order. Primary = SetLatentNoiseMask low denoise
// (discussion #639 recommendation for masked img2img). Fallback = "true
// inpainting" VAEEncodeForInpaint @ 1.0 (official inpaint tutorial). Bounded:
// at most 2 fixed configs per op, then stop.
const DENOISE_CONFIGS = Object.freeze([
  { id: 'masked-0.70', mode: 'set-noisy-mask', denoise: 0.7 },
  { id: 'inpaint-1.00', mode: 'vae-inpaint', denoise: 1.0 },
]);

// ── geometry (full-image space, 960x1536) ──────────────────────────────────
// Verified 2026-08-12 against both attempt-4 sources (vision grid previews in
// <output>/inpaint-previews/). Coordinates are in config so they can be nudged
// and the workflow JSON stays fully reproducible.
//
// WAI source: eyes ≈ (510,210) viewer-left / (597,206) viewer-right; red flower
// ornament at ≈ (600-665, 105-165) viewer-right hair; cheek below the eye is
// clean (no mole). The mole goes on the cheek just under the viewer-left eye
// (~(510,233)); the two small parallel red hairclips go on the viewer-right
// temple side-hair (~(598,130)+(612,146)) so the flower itself is not erased.
// Anima source: eyes ≈ (440,192) viewer-left / (537,192) viewer-right; wrong-side
// mole at ≈ (539,213) under viewer-right eye; correct-side target under
// viewer-left eye at ≈ (442,212).
const INPAINT_CONFIG: any = Object.freeze({
  'latest-lora:natsume:sd:fullbody': {
    engine: 'sd',
    checkpoint: 'waiIllustriousSDXL_v170.safetensors',
    lora: { file: 'shiki_natsume_v18_wd14.safetensors', strength: 0.85 },
    steps: 30,
    cfg: 6,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    ops: [
      {
        // Run FIRST on the clean attempt-4 source: crop (470,90,260,180) + masks
        // at (598,130)/(612,146) + true-inpaint fallback = the verified probe
        // that produced exactly two parallel red clips on the viewer-right
        // temple side-hair.
        id: 'add-hairclips',
        kind: 'add',
        // seedBase chosen so the inpaint-1.00 fallback (seedBase + 104729)
        // reproduces the verified probe seed 1629828268 that produced clips.
        seedBase: 1629723539,
        crop: { x: 470, y: 90, w: 260, h: 180 },
        // red-gain band for the clip heuristic; capped left of the flower (whose
        // red mass starts at x615) so the clips' own gain is what passes.
        clipBand: { x0: 581, y0: 116, x1: 613, y1: 160 },
        mask: [
          { kind: 'ellipse', cx: 598, cy: 130, rx: 17, ry: 11, feather: 4 },
          { kind: 'ellipse', cx: 612, cy: 146, rx: 17, ry: 11, feather: 4 },
        ],
        prompt:
          '(bright red hairclips:1.2), exactly two small parallel red hairclips in the hair, two thin crimson red hairpins side by side, small vivid red hair accessories, detailed hair',
        negative:
          'red flower, flower, ribbon, hair ribbon, bow, rose, blossom, single hairclip, no hairclips, hair band, headband, white ribbon, black hairclips, gold hair accessory',
      },
      {
        // Run LAST; tight cheek crop (x440-680,y180-320) that EXCLUDES the clip
        // zone (y119-179) so the clips survive op1 and are never re-encoded.
        id: 'add-mole',
        kind: 'add',
        crop: { x: 440, y: 180, w: 240, h: 140 },
        mask: [
          { kind: 'ellipse', cx: 510, cy: 233, rx: 16, ry: 16, feather: 4 },
        ],
        prompt:
          'single tiny beauty mark directly under the eye, small dark mole on cheek, one tiny mole only, detailed face',
        negative:
          'mole on the other side, multiple moles, big mole, moles under both eyes, freckles, blemish, scar, asymmetric face',
      },
    ],
  },
  'latest-lora:natsume:anima:fullbody': {
    engine: 'anima',
    checkpoint: 'anima-base-v1.0.safetensors',
    unet: 'anima-base-v1.0.safetensors',
    clip: 'qwen_3_06b_base.safetensors',
    vae: 'qwen_image_vae.safetensors',
    lora: { file: 'shiki_natsume_v21_anima.safetensors', strength: 0.85 },
    steps: 24,
    cfg: 3.0,
    sampler: 'res_multistep',
    scheduler: 'simple',
    ops: [
      {
        id: 'remove-wrong-mole',
        kind: 'remove',
        crop: { x: 389, y: 63, w: CROP_SIZE, h: CROP_SIZE },
        mask: [
          { kind: 'ellipse', cx: 539, cy: 213, rx: 18, ry: 18, feather: 4 },
        ],
        prompt:
          'smooth clean cheek, flawless skin, no beauty mark, no mole under eye, plain clean cheek below eye',
        negative:
          'mole, beauty mark, spot, freckle, blemish, mole under eye, dark spot on cheek',
      },
      {
        id: 'add-mole',
        kind: 'add',
        crop: { x: 292, y: 62, w: CROP_SIZE, h: CROP_SIZE },
        mask: [
          { kind: 'ellipse', cx: 442, cy: 212, rx: 16, ry: 16, feather: 4 },
        ],
        prompt:
          'single tiny beauty mark directly under the eye, small dark mole on cheek, one tiny mole only, detailed face',
        negative:
          'mole on the other side, multiple moles, big mole, moles under both eyes, freckles, blemish, scar, asymmetric face',
      },
    ],
  },
});

const KEYS = Object.freeze(Object.keys(INPAINT_CONFIG));

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

function writeJsonAtomic(file: any, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function writeTextAtomic(file: any, content: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function isRecord(value: any) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function imageInfo(buffer: any) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([255, 216, 255]))) return { mime: 'image/jpeg', width: 0, height: 0 };
  return null;
}

function sha256(buffer: any) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function escapeHtml(value: any) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function assertNotShowcase(dir: any) {
  const resolved = path.resolve(dir);
  const showcase = path.resolve(SCENE_SHOWCASE_DIR);
  const rel = path.relative(showcase, resolved);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside) throw new Error(`refusing to write into the public SceneShowcase directory: ${resolved}`);
  return resolved;
}

// ── plan helpers ────────────────────────────────────────────────────────────

function sourceRecordFor(manifest: any, key: any) {
  return manifest.find((record: any) => record.recordId === `${key}@attempt-4`);
}

function validateSourceRecord(record: any, outputDir: any) {
  if (!record) throw new Error('missing attempt-4 source record in manifest');
  if (record.status !== 'succeeded') {
    throw new Error(`attempt-4 source for ${record.key} is not succeeded (${record.status})`);
  }
  if (record.actualWidth !== SOURCE_WIDTH || record.actualHeight !== SOURCE_HEIGHT) {
    throw new Error(`attempt-4 source for ${record.key} is not ${SOURCE_WIDTH}x${SOURCE_HEIGHT} (${record.actualWidth}x${record.actualHeight})`);
  }
  const file = path.join(outputDir, record.image.split('/').join(path.sep));
  if (!fs.existsSync(file)) throw new Error(`attempt-4 source image missing: ${file}`);
  const buffer = fs.readFileSync(file);
  const hash = sha256(buffer);
  if (record.sha256 && hash !== record.sha256) {
    throw new Error(`attempt-4 source hash mismatch for ${record.key}: manifest ${record.sha256} != file ${hash}`);
  }
  return { buffer, file, hash };
}

function attemptFiveRecordId(key: any) {
  return `${key}@attempt-5`;
}

function outputImageRel(key: any) {
  const safe = key.replace(/[:\/\\]/g, '_');
  return `images/latest-lora/${safe}_attempt-5-inpaint.png`;
}

function shouldReuse(record: any, imageFile: any, force: any) {
  if (force) return false;
  if (!record || record.status !== 'succeeded' || !record.image) return false;
  if (!fs.existsSync(imageFile)) return false;
  const buffer = fs.readFileSync(imageFile);
  if (buffer.length < 1000) return false;
  const info = imageInfo(buffer);
  if (!info || info.width !== SOURCE_WIDTH || info.height !== SOURCE_HEIGHT) return false;
  if (record.sha256 && sha256(buffer) !== record.sha256) return false;
  return true;
}

export = {
  KEYS, INPAINT_CONFIG, CROP_SIZE, PREVIEW_GRID, PREVIEW_SCALE, JOB_TIMEOUT_MS, POLL_INTERVAL_MS,
  UPSCALE, MASKGEN, SOURCE_WIDTH, SOURCE_HEIGHT, attemptFiveRecordId, outputImageRel, sha256,
  MANIFEST_NAME, readJson, imageInfo, writeJsonAtomic, REVIEW_INDEX_NAME, escapeHtml, writeTextAtomic,
  CONTACT_SHEET_NAME, sourceRecordFor, validateSourceRecord, shouldReuse, DENOISE_CONFIGS, argument,
  DEFAULT_OUTPUT, assertNotShowcase, splitList, isRecord, ROOT, AI_ROOT,
};
