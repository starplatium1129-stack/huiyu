#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * ComfyUI local Anima masked repair for the two 2026-08-12 scene candidates
 * that still fail after the current production prompt (attempt-8 review):
 *
 *   - scene:sc037 (四季夏目 古寺御守, 832x1216): the charm reads as a modern
 *     cat trinket and the gripping hand is fused. Replace only the hand/charm
 *     region with one small rectangular cloth omamori.
 *   - scene:sc280 (杯架前递来的点心, 1216x832): the transparent cellophane bag
 *     must become an opaque folded kraft-paper pouch. attempt-6 is the source
 *     because its hands and cup racks are clean and the wrapper region never
 *     overlaps the fingers, so a tight mask can replace the wrapper without
 *     touching anatomy (cross-audit conclusion).
 *
 * Same verified official ComfyUI masked img2img recipe as
 * inpaint-showcase-candidates.js (docs.comfy.org/tutorials/basic/inpaint +
 * Comfy-Org discussion #639 — SetLatentNoiseMask with a LOW denoise for
 * "img2img but only on the masked part"):
 *
 *   LoadImage source ─► ImageCrop(region) ─► ImageScale(upscale ×3)
 *        ─► VAEEncode ─► SetLatentNoiseMask ─► KSampler(denoise 0.70)
 *        ─► VAEDecode ─► ImageScale(back to crop size)
 *        ─► ImageCompositeMasked(destination=full source, x/y=crop origin)
 *        ─► SaveImage
 *
 * Denoise configs are bounded: primary masked-0.70, one fixed fallback
 * VAEEncodeForInpaint @ 1.0 ("true inpainting" per #639). No loop. The mask
 * alone decides position, so prompts stay position-agnostic.
 *
 * Output contract (independent of the plain attempt numbering):
 *   - final image  images/<sceneId>/attempt-9.png
 *   - manifest record recordId "scene:<id>@attempt-9", supersedes the source
 *     record, full inpaint provenance (sourceRecordId, workflow files,
 *     operations, crop/mask coordinates, seed, denoise, prompt_id, sha256)
 *   - workflows written to <output>/workflows/scene/<key>/
 *   - NEVER writes into the public SceneShowcase directory
 *
 * Usage:
 *   node scripts/maintenance/inpaint-scene-candidates.js \
 *       [--manifest <path>] [--output <dir>] [--comfy http://127.0.0.1:8188] \
 *       [--python <python>] [--dry-run] [--force] [--keys scene:sc037,scene:sc280]
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const { spawnSync }: typeof import('child_process') = require('child_process');
const { decodePng8, luminance }: typeof import('./png-probe.js') = require('./png-probe.js');

const ROOT = path.resolve(__dirname, '..', '..');
const AI_ROOT = path.resolve(ROOT, '..', 'AI');
const DEFAULT_OUTPUT = path.join(AI_ROOT, 'Reviews', 'SceneShowcaseRefresh', '2026-08-12_current-prompts');
const SCENE_SHOWCASE_DIR = path.resolve(AI_ROOT, 'SceneShowcase');
const MANIFEST_NAME = 'generation-manifest.json';
const MASKGEN = path.join(__dirname, 'inpaint-maskgen.py');
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
const SCENE_INPAINT_CONFIG = Object.freeze({
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

function attemptFor(key) {
  const cfg = SCENE_INPAINT_CONFIG[key];
  return cfg && Number.isInteger(cfg.attempt) ? cfg.attempt : ATTEMPT;
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function splitList(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}
function imageInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return null;
}
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function assertNotShowcase(dir) {
  const resolved = path.resolve(dir);
  const showcase = path.resolve(SCENE_SHOWCASE_DIR);
  const rel = path.relative(showcase, resolved);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside) throw new Error(`refusing to write into the public SceneShowcase directory: ${resolved}`);
  return resolved;
}

let _python = '';
function setPython(value) {
  _python = value || 'python';
}
function pythonBin() {
  return _python || 'python';
}

// ── source records ─────────────────────────────────────────────────────────

function sourceRecordFor(manifest, key) {
  const attempt = SCENE_INPAINT_CONFIG[key].sourceAttempt;
  return manifest.find(record => record.recordId === `${key}@attempt-${attempt}`);
}

function validateSourceRecord(key, record, outputDir) {
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

function attemptRecordId(key) {
  return `${key}@attempt-${attemptFor(key)}`;
}

function outputImageRel(key) {
  const sceneId = key.split(':')[1];
  return `images/${sceneId}/attempt-${attemptFor(key)}.png`;
}

function shouldReuse(key, record, imageFile, force) {
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

// ── previews ───────────────────────────────────────────────────────────────

function generatePreviews(outputDir, key, sourceFile) {
  const cfg = SCENE_INPAINT_CONFIG[key];
  const previewDir = path.join(outputDir, 'inpaint-scene-previews');
  fs.mkdirSync(previewDir, { recursive: true });
  const made = [];
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

// ── ComfyUI client (mirrors inpaint-showcase-candidates.js) ────────────────

function comfyJson(base, method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(base.replace(/\/$/, '') + pathname);
    const client = url.protocol === 'https:' ? (require('https') as typeof import('https')) : (require('http') as typeof import('http'));
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const request = client.request({
      hostname: url.hostname, port: url.port, method,
      path: url.pathname + url.search, timeout: timeoutMs || 30000,
      headers: Object.assign({ Accept: 'application/json' }, payload ? {
        'Content-Type': 'application/json', 'Content-Length': payload.length,
      } : {}),
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const rawBuffer = Buffer.concat(chunks);
        const raw = rawBuffer.toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (error) { /* keep null */ }
        resolve({ status: response.statusCode || 0, data, raw, rawBuffer });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('ComfyUI request timeout')));
    if (payload) request.write(payload);
    request.end();
  });
}

async function uploadImage(comfyBase, filename, buffer) {
  const boundary = `----aics${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([prefix, buffer, suffix]);
  const url = new URL(comfyBase.replace(/\/$/, '') + '/upload/image');
  const client = url.protocol === 'https:' ? (require('https') as typeof import('https')) : (require('http') as typeof import('http'));
  return new Promise((resolve, reject) => {
    const request = client.request({
      hostname: url.hostname, port: url.port, method: 'POST', timeout: 60000,
      path: url.pathname + '?overwrite=true',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch (error) { /* keep null */ }
        resolve({ status: response.statusCode || 0, data, raw });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('ComfyUI upload timeout')));
    request.write(payload);
    request.end();
  });
}

function resolveUploadName(requested, uploaded) {
  const serverName = uploaded && uploaded.data && uploaded.data.name;
  return serverName || requested;
}

async function submitAndWait(comfyBase, workflow) {
  const submitted = await comfyJson(comfyBase, 'POST', '/prompt', { prompt: workflow, client_id: `aics-scene-inpaint-${process.pid}` }, 30000);
  if (submitted.status < 200 || submitted.status >= 300 || !submitted.data || !submitted.data.prompt_id) {
    throw new Error(`ComfyUI prompt submission failed (HTTP ${submitted.status}): ${submitted.raw || JSON.stringify(submitted.data)}`);
  }
  const promptId = submitted.data.prompt_id;
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const history = await comfyJson(comfyBase, 'GET', `/history/${encodeURIComponent(promptId)}`, null, 15000);
    const entry = history.data && history.data[promptId];
    if (entry) {
      const status = entry.status && entry.status.status_str;
      if (status === 'error' || status === 'failed') {
        const messages = (entry.status && entry.status.messages || [])
          .filter(([, value]) => value && value.exception_message)
          .map(([, value]) => value.exception_message);
        throw new Error(`ComfyUI execution failed for ${promptId}: ${messages.join(' | ') || JSON.stringify(entry.status)}`);
      }
      if (status === 'success') return { promptId, entry };
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`ComfyUI execution timed out for ${promptId}`);
}

async function fetchOutputImage(comfyBase, image) {
  const query = `?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || '')}&type=output`;
  const response = await comfyJson(comfyBase, 'GET', '/view' + query, null, 60000);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`ComfyUI /view failed (HTTP ${response.status})`);
  }
  return response.rawBuffer;
}

// ── workflow builder (mirrors routes/anima.js Anima chain) ─────────────────

function modelNodes(cfg, graph, startId) {
  let next = startId;
  const node = (classType, inputs) => {
    const id = String(next);
    next += 1;
    graph[id] = { class_type: classType, inputs };
    return id;
  };
  const unet = node('UNETLoader', { unet_name: cfg.unet, weight_dtype: 'default' });
  const clip = node('CLIPLoader', { clip_name: cfg.clip, type: 'qwen_image' });
  const vae = node('VAELoader', { vae_name: cfg.vae });
  const lora = node('LoraLoader', {
    model: [unet, 0], clip: [clip, 0],
    lora_name: cfg.lora.file, strength_model: cfg.lora.strength, strength_clip: cfg.lora.strength,
  });
  const pos = node('CLIPTextEncode', { clip: [lora, 1], text: '' });
  const neg = node('CLIPTextEncode', { clip: [lora, 1], text: '' });
  return { model: [lora, 0], pos, neg, vae: [vae, 0], next };
}

function buildOpWorkflow(cfg, op, denoiseConfig, prompt, negative, sourceImageName, maskImageName, crop) {
  const graph = {};
  let next = 1;
  const add = (classType, inputs) => {
    const id = String(next);
    next += 1;
    graph[id] = { class_type: classType, inputs };
    return id;
  };
  const loadSource = add('LoadImage', { image: sourceImageName });
  const loadMask = add('LoadImage', { image: maskImageName });

  const cropImage = add('ImageCrop', {
    image: [loadSource, 0],
    width: crop.w, height: crop.h, x: crop.x, y: crop.y,
  });
  const upImage = add('ImageScale', {
    image: [cropImage, 0], upscale_method: 'lanczos',
    width: crop.w * UPSCALE, height: crop.h * UPSCALE, crop: 'disabled',
  });
  const cropMask = add('ImageCrop', {
    image: [loadMask, 0],
    width: crop.w, height: crop.h, x: crop.x, y: crop.y,
  });
  const upMask = add('ImageScale', {
    image: [cropMask, 0], upscale_method: 'nearest-exact',
    width: crop.w * UPSCALE, height: crop.h * UPSCALE, crop: 'disabled',
  });
  const maskTensor = add('ImageToMask', { image: [upMask, 0], channel: 'red' });

  const models = modelNodes(cfg, graph, next);
  next = models.next;
  graph[models.pos].inputs.text = prompt;
  graph[models.neg].inputs.text = negative;

  let latentInput;
  if (denoiseConfig.mode === 'vae-inpaint') {
    const encodeInpaint = add('VAEEncodeForInpaint', {
      pixels: [upImage, 0], vae: models.vae, mask: [maskTensor, 0], grow_mask_by: 6,
    });
    latentInput = [encodeInpaint, 0];
  } else {
    const encode = add('VAEEncode', { pixels: [upImage, 0], vae: models.vae });
    const setMask = add('SetLatentNoiseMask', { samples: [encode, 0], mask: [maskTensor, 0] });
    latentInput = [setMask, 0];
  }

  const sample = add('KSampler', {
    model: models.model, positive: [models.pos, 0], negative: [models.neg, 0],
    latent_image: latentInput,
    seed: 0, steps: cfg.steps, cfg: cfg.cfg,
    sampler_name: cfg.sampler, scheduler: cfg.scheduler,
    denoise: denoiseConfig.denoise,
  });
  const decode = add('VAEDecode', { samples: [sample, 0], vae: models.vae });
  const downImage = add('ImageScale', {
    image: [decode, 0], upscale_method: 'lanczos',
    width: crop.w, height: crop.h, crop: 'disabled',
  });
  const composite = add('ImageCompositeMasked', {
    destination: [loadSource, 0], source: [downImage, 0],
    x: crop.x, y: crop.y, resize_source: false,
  });
  add('SaveImage', { images: [composite, 0], filename_prefix: `aics_scene_inpaint_${op.id}_${denoiseConfig.id}` });

  return graph;
}

// ── mask generation ─────────────────────────────────────────────────────────

function buildMaskArgs(op) {
  const args = [];
  for (const shape of op.mask) {
    if (shape.kind === 'ellipse') {
      args.push('--ellipse', String(shape.cx), String(shape.cy), String(shape.rx), String(shape.ry), String(shape.feather));
    } else if (shape.kind === 'rect') {
      args.push('--rect', String(shape.x0), String(shape.y0), String(shape.x1), String(shape.y1), String(shape.feather));
    }
  }
  return args;
}

function generateMask(outputDir, key, op, denoiseConfig) {
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

function maskCoreDelta(outputBuffer, sourceBuffer, shape) {
  if (!shape || shape.kind !== 'ellipse') return null;
  const probe = (buffer) => {
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

function opLooksDone(op, outputBuffer, sourceBuffer) {
  // Material/prop replacement ops have no reliable local feature detector;
  // gate on "the masked region actually changed" so an unchanged region
  // triggers the one fixed true-inpaint fallback instead of silently passing.
  const shape = op.mask.find(item => item.kind === 'ellipse');
  if (!shape) return true;
  const delta = maskCoreDelta(outputBuffer, sourceBuffer, shape);
  if (delta === null) return false;
  return delta >= 6;
}

// ── manifest record ─────────────────────────────────────────────────────────

function buildAttemptRecord(key, sourceRecord, config, results, workflowFiles) {
  const finalOutput = results[results.length - 1];
  const inpaint = {
    sourceRecordId: sourceRecord.recordId,
    engine: config.engine,
    workflowFiles,
    operations: results.map(result => ({
      id: result.op.id,
      denoiseConfig: result.denoiseConfig.id,
      mode: result.denoiseConfig.mode,
      denoise: result.denoiseConfig.denoise,
      seed: result.seed,
      steps: config.steps,
      cfg: config.cfg,
      sampler: config.sampler,
      scheduler: config.scheduler,
      crop: result.op.crop,
      mask: result.op.mask,
      maskImage: result.maskImage,
      prompt: result.prompt,
      negative: result.negative,
      promptId: result.promptId,
      output: result.outputImage,
      outputSha256: result.outputSha256,
      heuristic: result.heuristic,
    })),
  };
  const sceneId = key.split(':')[1];
  const record = Object.assign({}, sourceRecord, {
    attempt: attemptFor(key),
    recordId: attemptRecordId(key),
    supersedes: sourceRecord.recordId,
    reviewReason: sceneId === 'sc037'
      ? 'ComfyUI Anima masked 局部修复：把猫形挂件替换为小型矩形日式布御守并重绘抓握手部（官方 inpaint 教程 + discussion #639 SetLatentNoiseMask 低 denoise）'
      : 'ComfyUI Anima masked 局部修复：把透明玻璃纸包装替换为顶部折叠封闭的不透明棕色牛皮纸包（官方 inpaint 教程 + discussion #639 SetLatentNoiseMask 低 denoise）',
    status: 'succeeded',
    error: '',
    generatedAt: new Date().toISOString(),
    image: outputImageRel(key),
    bytes: finalOutput.buffer.length,
    mime: 'image/png',
    actualWidth: config.width,
    actualHeight: config.height,
    sha256: sha256(finalOutput.buffer),
    jobId: finalOutput.promptId,
    provider: 'comfy',
    actualSeed: sourceRecord.actualSeed ?? sourceRecord.seed,
    seed: sourceRecord.actualSeed ?? sourceRecord.seed,
    postprocess: { kind: 'inpaint', sourceRecordId: sourceRecord.recordId, ...inpaint },
    inpaint,
  });
  delete record.infotexts;
  delete record.image_extra;
  return record;
}

// ── runner ──────────────────────────────────────────────────────────────────

async function runKey(key, manifest, outputDir, comfyBase, force) {
  const config = SCENE_INPAINT_CONFIG[key];
  const sourceRecord = sourceRecordFor(manifest, key);
  const validated = validateSourceRecord(key, sourceRecord, outputDir);
  const outImageRel = outputImageRel(key);
  const outImageFile = path.join(outputDir, outImageRel.split('/').join(path.sep));
  const recordId = attemptRecordId(key);
  const existing = manifest.find(record => record.recordId === recordId);
  if (shouldReuse(key, existing, outImageFile, force)) {
    console.log(`[reuse] ${key} -> ${outImageRel} (${existing.sha256})`);
    return { key, status: 'reused', record: existing };
  }

  const workflowDir = path.join(outputDir, 'workflows', 'scene', key.replace(/[:\/\\]/g, '_'));
  fs.mkdirSync(workflowDir, { recursive: true });

  const results = [];
  const workflowFiles = [];
  let currentBuffer = validated.buffer;
  const runId = `${Date.now()}-${process.pid}`;

  for (let index = 0; index < config.ops.length; index += 1) {
    const op = config.ops[index];
    const stageBuffer = currentBuffer;
    let done = false;
    const denoiseConfigs = op.denoiseOrder
      ? op.denoiseOrder.map(id => DENOISE_CONFIGS.find(item => item.id === id)).filter(Boolean)
      : DENOISE_CONFIGS;
    for (let attemptIndex = 0; attemptIndex < denoiseConfigs.length && !done; attemptIndex += 1) {
      const denoiseConfig = denoiseConfigs[attemptIndex];
      const sourceRequested = `aics_scene_${key.replace(/[:\/\\]/g, '_')}_${runId}_stage${index}.png`;
      const sourceUpload = await uploadImage(comfyBase, sourceRequested, currentBuffer);
      if (sourceUpload.status < 200 || sourceUpload.status >= 300) {
        throw new Error(`stage source upload failed for ${key} op ${op.id} (HTTP ${sourceUpload.status}): ${sourceUpload.raw || sourceUpload.data}`);
      }
      const sourceName = resolveUploadName(sourceRequested, sourceUpload);
      const maskFile = generateMask(outputDir, key, op, denoiseConfig);
      const maskRequested = `aics_scene_mask_${runId}_${op.id}_${denoiseConfig.id}.png`;
      const maskUpload = await uploadImage(comfyBase, maskRequested, fs.readFileSync(maskFile));
      if (maskUpload.status < 200 || maskUpload.status >= 300) {
        throw new Error(`mask upload failed for ${key} ${op.id} (HTTP ${maskUpload.status}): ${maskUpload.raw || maskUpload.data}`);
      }
      const maskName = resolveUploadName(maskRequested, maskUpload);
      const seed = (sourceRecord.actualSeed ?? sourceRecord.seed)
        + index * 7919 + attemptIndex * 104729;
      const workflow = buildOpWorkflow(config, op, denoiseConfig, op.prompt, op.negative, sourceName, maskName, op.crop);
      const sampleNode = Object.keys(workflow).find(id => workflow[id].class_type === 'KSampler');
      workflow[sampleNode].inputs.seed = seed;
      const workflowFile = path.join(workflowDir, `${op.id}_${denoiseConfig.id}.json`);
      writeJsonAtomic(workflowFile, workflow);
      workflowFiles.push(workflowFile.replace(/\\/g, '/'));
      console.log(`[${key}] op ${op.id} config ${denoiseConfig.id} submit...`);

      let outputBuffer;
      let promptId = `${key.replace(/[:\/\\]/g, '_')}-${op.id}-${denoiseConfig.id}`;
      try {
        const promptResult = await submitAndWait(comfyBase, workflow);
        const outputNode = Object.keys(workflow).find(id => workflow[id].class_type === 'SaveImage');
        const images = promptResult.entry.outputs && promptResult.entry.outputs[outputNode]
          && promptResult.entry.outputs[outputNode].images;
        if (!Array.isArray(images) || !images.length) {
          throw new Error(`ComfyUI returned no image for ${key} ${op.id}`);
        }
        outputBuffer = await fetchOutputImage(comfyBase, images[0]);
        promptId = promptResult.promptId;
      } catch (error) {
        console.log(`[${key}] op ${op.id} config ${denoiseConfig.id} FAILED: ${runtimeErrorMessage(error)}`);
        if (attemptIndex === denoiseConfigs.length - 1) {
          throw new Error(`${key} ${op.id} failed after ${denoiseConfigs.length} fixed configs — stopping (official references: https://docs.comfy.org/tutorials/basic/inpaint, Comfy-Org discussion #639)`);
        }
        continue;
      }
      const info = imageInfo(outputBuffer);
      if (!info || info.width !== config.width || info.height !== config.height) {
        throw new Error(`${key} ${op.id} output invalid dimensions: ${info ? `${info.width}x${info.height}` : 'non-image'}`);
      }
      const opImageRel = `images/${key.split(':')[1]}/${key.replace(/[:\/\\]/g, '_')}_${op.id}_${denoiseConfig.id}.png`;
      const opImageFile = path.join(outputDir, opImageRel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(opImageFile), { recursive: true });
      fs.writeFileSync(opImageFile, outputBuffer);

      const heuristic = opLooksDone(op, outputBuffer, stageBuffer);
      results.push({
        op, denoiseConfig, seed, promptId, buffer: outputBuffer,
        outputImage: opImageRel, outputSha256: sha256(outputBuffer),
        maskImage: maskName, prompt: op.prompt, negative: op.negative, heuristic,
      });
      console.log(`[${key}] op ${op.id} config ${denoiseConfig.id} -> ${opImageRel} (region delta heuristic ${heuristic ? 'PASS' : 'FAIL'})`);
      if (heuristic) {
        done = true;
        currentBuffer = outputBuffer;
        break;
      }
      if (attemptIndex === denoiseConfigs.length - 1) {
        currentBuffer = outputBuffer;
      }
    }
  }

  const finalBuffer = results[results.length - 1].buffer;
  fs.mkdirSync(path.dirname(outImageFile), { recursive: true });
  fs.writeFileSync(outImageFile, finalBuffer);
  const record = buildAttemptRecord(key, sourceRecord, config, results, workflowFiles);
  console.log(`[ok] ${key} -> ${outImageRel} (${record.bytes} bytes, ${record.sha256})`);
  return { key, status: 'generated', record, results };
}

async function main() {
  const manifestPath = path.resolve(argument('--manifest', path.join(DEFAULT_OUTPUT, MANIFEST_NAME)));
  const outputDir = assertNotShowcase(path.resolve(argument('--output', path.dirname(manifestPath))));
  const comfyBase = argument('--comfy', 'http://127.0.0.1:8188');
  setPython(argument('--python', 'python'));
  const keys = splitList(argument('--keys', KEYS.join(',')));
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');

  for (const key of keys) {
    if (!SCENE_INPAINT_CONFIG[key]) throw new Error(`unsupported inpaint key: ${key} (allowed: ${KEYS.join(', ')})`);
  }
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const manifest = readJson(manifestPath);

  const plan = [];
  const previews = [];
  for (const key of keys) {
    const source = sourceRecordFor(manifest, key);
    const validated = validateSourceRecord(key, source, outputDir);
    previews.push(...generatePreviews(outputDir, key, validated.file));
    plan.push({ key, recordId: attemptRecordId(key), source: source ? source.recordId : '', ops: SCENE_INPAINT_CONFIG[key].ops.map(op => op.id) });
  }

  if (dryRun) {
    console.log(JSON.stringify({ manifest: manifestPath, output: outputDir, comfy: comfyBase, plan, previews }, null, 2));
    return;
  }

  const stats = await comfyJson(comfyBase, 'GET', '/system_stats', null, 5000);
  if (stats.status < 200 || stats.status >= 300) {
    throw new Error(`ComfyUI not reachable at ${comfyBase} (HTTP ${stats.status})`);
  }

  const outcomes = [];
  for (const key of keys) {
    outcomes.push(await runKey(key, manifest, outputDir, comfyBase, force));
  }

  const current = readJson(manifestPath);
  for (const outcome of outcomes) {
    if (outcome.status === 'generated') {
      const idx = current.findIndex(record => record.recordId === outcome.record.recordId);
      if (idx >= 0) current.splice(idx, 1);
      current.push(outcome.record);
    }
  }
  const normalized = current
    .map(record => (record.attempt ? record : Object.assign({}, record, { attempt: 1 })))
    .sort((a, b) => (a.recordId || a.key || '').localeCompare(b.recordId || b.key || ''));
  writeJsonAtomic(manifestPath, normalized);

  console.log(JSON.stringify({
    output: outputDir,
    comfy: comfyBase,
    outcomes: outcomes.map(outcome => ({
      key: outcome.key,
      status: outcome.status,
      recordId: outcome.record ? outcome.record.recordId : '',
      image: outcome.record ? outcome.record.image : '',
      sha256: outcome.record ? outcome.record.sha256 : '',
      operations: outcome.results ? outcome.results.map(r => ({ id: r.op.id, config: r.denoiseConfig.id, heuristic: r.heuristic, promptId: r.promptId })) : [],
    })),
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

export = {
  SCENE_INPAINT_CONFIG, KEYS, DENOISE_CONFIGS, ATTEMPT,
  argument, splitList, readJson, writeJsonAtomic, imageInfo, sha256, assertNotShowcase,
  sourceRecordFor, validateSourceRecord, attemptRecordId, outputImageRel, shouldReuse,
  buildOpWorkflow, buildMaskArgs, generateMask, maskCoreDelta, opLooksDone,
  buildAttemptRecord, resolveUploadName,
  constants: {
    ROOT, AI_ROOT, DEFAULT_OUTPUT, MANIFEST_NAME, SCENE_SHOWCASE_DIR,
    MASKGEN, UPSCALE, POLL_INTERVAL_MS, JOB_TIMEOUT_MS,
  },
};
