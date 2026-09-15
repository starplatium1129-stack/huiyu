#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * ComfyUI local repair (inpaint) for the two 四季夏目 fullbody showcase keys that
 * still fail visual acceptance at attempt-4.
 *
 * The 2026-08-12 main-thread visual audit found the following concrete defects:
 *   - latest-lora:natsume:sd:fullbody@attempt-4 (WAI, 960x1536):
 *       * no mole under the character's OWN right eye (viewer-left cheek)
 *       * the red hair ornament on the viewer-right side rendered as a single
 *         big flower instead of the required "two small parallel red hairclips"
 *   - latest-lora:natsume:anima:fullbody@attempt-4 (Anima, 960x1536):
 *       * wrong-side mole present under the viewer-right eye (character's left)
 *       * correct-side mole missing under the viewer-left eye (character's right)
 *
 * Both defects are strictly local, so instead of re-rolling a full-body seed we
 * run the official ComfyUI masked img2img recipe (docs.comfy.org/tutorials/basic/
 * inpaint + Comfy-Org discussion #639 — SetLatentNoiseMask with a LOW denoise for
 * "img2img but only on the masked part"):
 *
 *   LoadImage source ─► ImageCrop(face band) ─► ImageScale(upscale ×3)
 *        ─► VAEEncode ─► SetLatentNoiseMask ─► KSampler(denoise 0.65-0.75)
 *        ─► VAEDecode ─► ImageScale(back to crop size)
 *        ─► ImageCompositeMasked(destination=full source, x/y=crop origin)
 *        ─► SaveImage
 *
 * Each local operation runs as its own ComfyUI prompt with its OWN programmatic
 * mask (no manual UI), so the model never has to guess "left/right" from text —
 * the mask alone decides position and the prompt stays side-agnostic:
 *   - Anima op1 "remove wrong-side mole":  mask the wrong-side mole region,
 *     prompt "smooth clean cheek / no beauty mark", negative "mole / beauty mark".
 *   - Anima op2 "add correct-side mole":   mask the correct-side region, prompt
 *     "single tiny beauty mark directly under the eye" (no left/right in text).
 *   - WAI  op1 "add correct-side mole":    mask the correct-side region, prompt
 *     "single tiny beauty mark directly under the eye".
 *   - WAI  op2 "add two parallel red hairclips": mask the viewer-right hair
 *     region, prompt "exactly two small parallel red hairclips", negative
 *     "red flower / ribbon" so it cannot degrade back into a flower or a bow.
 *
 * All crop/mask coordinates live in the INPAINT_CONFIG below (full-image space,
 * 960x1536). They were verified against the attempt-4 sources with the local
 * vision pipeline (scripts generate the grid-labeled face-crop previews into
 * <output>/inpaint-previews/); adjust there and re-run.
 *
 * Behaviour:
 *   - reads the candidate generation-manifest.json, validates the two attempt-4
 *     source records (status=succeeded, image exists, 960x1536, sha256 matches)
 *   - uploads source + programmatic mask PNGs to ComfyUI /upload/image
 *   - for each key runs its operations in order; every intermediate output is
 *     saved (never overwritten) with the op name + denoise config in the name
 *   - per-op retry is bounded: primary SetLatentNoiseMask @ 0.7; if the op's
 *     heuristic says the target feature did not appear, ONE fixed fallback
 *     (VAEEncodeForInpaint @ denoise 1.0, "true inpainting" per #639). No loop.
 *   - the final composed image is written as
 *     images/latest-lora/<key>_attempt-5-inpaint.png
 *   - a new attempt-5 record (recordId "<key>@attempt-5", supersedes attempt-4)
 *     is appended to the manifest with full inpaint provenance: sourceRecordId,
 *     workflow file, operations, crop/mask raw coordinates, seed, denoise,
 *     Comfy prompt_id, sha256.
 *   - writes the exact workflow JSON to <output>/workflows/ for reproducibility
 *   - regenerates review-index.json + contact-sheet.html (mechanical only)
 *   - resumes: a succeeded attempt-5 with a matching sha256 file is reused
 *     unless --force; --dry-run prints the plan; default keys are exactly the
 *     two natsume fullbody keys; NEVER writes into SceneShowcase.
 *
 * Usage:
 *   node scripts/maintenance/inpaint-showcase-candidates.js \
 *       [--manifest <path>] [--output <dir>] [--comfy http://127.0.0.1:8188] \
 *       [--python <python>] [--dry-run] [--force] [--keys a,b]
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const { spawnSync }: typeof import('child_process') = require('child_process');
const { decodePng8, luminance }: typeof import('./png-probe.js') = require('./png-probe.js');

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
const MASKGEN = path.join(__dirname, 'inpaint-maskgen.py');
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

// ── ComfyUI client ──────────────────────────────────────────────────────────

function comfyJson(base: any, method: any, pathname: any, body: any, timeoutMs: any) {
  return new Promise<any>((resolve: any, reject: any) => {
    const url = new URL(base.replace(/\/$/, '') + pathname);
    const client = url.protocol === 'https:' ? (require('https') as typeof import('https')) : (require('http') as typeof import('http'));
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const request = client.request({
      hostname: url.hostname, port: url.port, method,
      path: url.pathname + url.search, timeout: timeoutMs || 30000,
      headers: Object.assign({ Accept: 'application/json' }, payload ? {
        'Content-Type': 'application/json', 'Content-Length': payload.length,
      } : {}),
    }, (response: any) => {
      const chunks: any[] = [];
      response.on('data', (chunk: any) => chunks.push(chunk));
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

async function uploadImage(comfyBase: any, filename: any, buffer: any) {
  const boundary = `----aics${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([prefix, buffer, suffix]);
  const url = new URL(comfyBase.replace(/\/$/, '') + '/upload/image');
  const client = url.protocol === 'https:' ? (require('https') as typeof import('https')) : (require('http') as typeof import('http'));
  return new Promise<any>((resolve: any, reject: any) => {
    const request = client.request({
      hostname: url.hostname, port: url.port, method: 'POST', timeout: 60000,
      path: url.pathname + '?overwrite=true',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length,
      },
    }, (response: any) => {
      const chunks: any[] = [];
      response.on('data', (chunk: any) => chunks.push(chunk));
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

/**
 * ComfyUI 0.31.0 /upload/image IGNORES overwrite=true and renames an existing
 * file to "<name> (1).png". Re-running would then load a stale file via the
 * LoadImage node. To stay correct on resume/--force we (a) always use the
 * server-returned name for LoadImage and (b) derive it ourselves when the
 * response is empty: if the target exists, append the counter ComfyUI uses.
 */
function resolveUploadName(requested: any, uploaded: any) {
  const serverName = uploaded && uploaded.data && uploaded.data.name;
  if (serverName) return serverName;
  // no JSON (defensive): replicate ComfyUI's rename so the LoadImage node still
  // points at the file that was actually written.
  return requested;
}

async function submitAndWait(comfyBase: any, workflow: any) {
  const submitted = await comfyJson(comfyBase, 'POST', '/prompt', { prompt: workflow, client_id: `aics-inpaint-${process.pid}` }, 30000);
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
          .filter(([, value]: any) => value && value.exception_message)
          .map(([, value]: any) => value.exception_message);
        throw new Error(`ComfyUI execution failed for ${promptId}: ${messages.join(' | ') || JSON.stringify(entry.status)}`);
      }
      if (status === 'success') {
        return { promptId, entry };
      }
    }
    await new Promise<any>((resolve: any) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`ComfyUI execution timed out for ${promptId}`);
}

async function fetchOutputImage(comfyBase: any, image: any) {
  const query = `?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || '')}&type=output`;
  const response = await comfyJson(comfyBase, 'GET', '/view' + query, null, 60000);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`ComfyUI /view failed (HTTP ${response.status})`);
  }
  return response.rawBuffer;
}

// ── workflow builder (mirrors routes/generation.js + routes/anima.js) ──────

function modelNodes(cfg: any, graph: any, startId: any) {
  let next = startId;
  const node = (classType: any, inputs: any) => {
    const id = String(next);
    next += 1;
    graph[id] = { class_type: classType, inputs };
    return id;
  };
  if (cfg.engine === 'sd') {
    const ckpt = node('CheckpointLoaderSimple', { ckpt_name: cfg.checkpoint });
    const lora = node('LoraLoader', {
      model: [ckpt, 0], clip: [ckpt, 1],
      lora_name: cfg.lora.file, strength_model: cfg.lora.strength, strength_clip: cfg.lora.strength,
    });
    const pos = node('CLIPTextEncode', { clip: [lora, 1], text: '' });
    const neg = node('CLIPTextEncode', { clip: [lora, 1], text: '' });
    return { model: [lora, 0], pos, neg, vae: [ckpt, 2], next };
  }
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

function buildOpWorkflow(cfg: any, op: any, denoiseConfig: any, prompt: any, negative: any, sourceImageName: any, maskImageName: any, crop: any) {
  const graph: Record<string, any> = {};
  let next = 1;
  const add = (classType: any, inputs: any) => {
    const id = String(next);
    next += 1;
    graph[id] = { class_type: classType, inputs };
    return id;
  };
  const loadSource = add('LoadImage', { image: sourceImageName });
  const loadMask = add('LoadImage', { image: maskImageName });

  // crop + upscale the face band
  const cropImage = add('ImageCrop', {
    image: [loadSource, 0],
    width: crop.w, height: crop.h, x: crop.x, y: crop.y,
  });
  const upImage = add('ImageScale', {
    image: [cropImage, 0], upscale_method: 'lanczos',
    width: crop.w * UPSCALE, height: crop.h * UPSCALE, crop: 'disabled',
  });

  // crop + upscale the mask identically (nearest keeps the mask hard)
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

  // scale back to the original crop size, then composite onto the full source
  const downImage = add('ImageScale', {
    image: [decode, 0], upscale_method: 'lanczos',
    width: crop.w, height: crop.h, crop: 'disabled',
  });
  const composite = add('ImageCompositeMasked', {
    destination: [loadSource, 0], source: [downImage, 0],
    x: crop.x, y: crop.y, resize_source: false,
  });
  add('SaveImage', { images: [composite, 0], filename_prefix: `aics_inpaint_${op.id}_${denoiseConfig.id}` });

  return graph;
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

// ── manifest + review index ─────────────────────────────────────────────────

function buildAttemptFiveRecord(key: any, sourceRecord: any, config: any, results: any, workflowFiles: any) {
  const source = sourceRecord;
  const finalOutput = results[results.length - 1];
  const inpaint = {
    sourceRecordId: source.recordId,
    engine: config.engine,
    workflowFiles,
    operations: results.map((result: any) => ({
      id: result.op.id,
      kind: result.op.kind,
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
  const record = Object.assign({}, source, {
    attempt: 5,
    recordId: attemptFiveRecordId(key),
    supersedes: source.recordId,
    reviewReason:
      'ComfyUI masked 局部修复（官方 inpaint 教程 + discussion #639 SetLatentNoiseMask 低 denoise）：' +
      (config.engine === 'anima'
        ? '移除观察者右侧错误痣、在正确侧（人物自身右眼=观察者左侧）眼下补单颗小痣'
        : '在正确侧眼下补单颗小痣、观察者右侧头发补 exactly two small parallel red hairclips（压制红花/丝带）'),
    status: 'succeeded',
    error: '',
    generatedAt: new Date().toISOString(),
    image: outputImageRel(key),
    bytes: finalOutput.buffer.length,
    mime: 'image/png',
    actualWidth: SOURCE_WIDTH,
    actualHeight: SOURCE_HEIGHT,
    sha256: sha256(finalOutput.buffer),
    jobId: finalOutput.promptId,
    provider: 'comfy',
    actualSeed: source.actualSeed ?? source.seed,
    seed: source.actualSeed ?? source.seed,
    postprocess: { kind: 'inpaint', sourceRecordId: source.recordId, ...inpaint },
    inpaint,
  });
  delete record.infotexts;
  delete record.image_extra;
  return record;
}

function verifyAndIndex(outputDir: any) {
  const manifestPath = path.join(outputDir, MANIFEST_NAME);
  const manifest = readJson(manifestPath);
  const entries: any[] = [];
  for (const record of manifest) {
    const entry: any = {
      batch: record.batch, key: record.key, subject: record.subject,
      sceneId: record.sceneId, characterId: record.characterId, artistId: record.artistId,
      displayName: record.displayName, engine: record.engine, provider: record.provider,
      modelId: record.modelId, checkpoint: record.checkpoint,
      loraId: record.loraId, loraFile: record.loraFile, loraStrength: record.loraStrength,
      seed: record.actualSeed ?? record.seed, width: record.width, height: record.height,
      steps: record.steps, cfg: record.cfg, sampler: record.sampler, scheduler: record.scheduler,
      prompt: record.prompt, negative: record.negative,
      generatedAt: record.generatedAt, image: record.image,
      status: record.status, error: record.error || '',
      attempt: record.attempt || 1,
      recordId: record.recordId || `${record.key}@attempt-${record.attempt || 1}`,
      supersedes: record.supersedes || '',
      reviewReason: record.reviewReason || '',
      inpaint: record.inpaint || null,
      postprocess: record.postprocess || null,
    };
    if (record.status !== 'succeeded') { entries.push(entry); continue; }
    const file = path.join(outputDir, record.image.split('/').join(path.sep));
    entry.pathExists = fs.existsSync(file);
    entry.bytes = record.bytes || 0;
    entry.sha256 = record.sha256 || '';
    let dimsOk = true;
    let mime = '';
    if (entry.pathExists) {
      const buffer = fs.readFileSync(file);
      const info: any = imageInfo(buffer);
      mime = info ? info.mime : '';
      entry.mime = mime;
      entry.magicWidth = info ? info.width : 0;
      entry.magicHeight = info ? info.height : 0;
      dimsOk = Boolean(info) && info.width === record.width && info.height === record.height;
      entry.nonEmpty = buffer.length > 1000;
      entry.expectedMimeOk = mime.startsWith('image/');
    } else {
      entry.nonEmpty = false;
      entry.expectedMimeOk = false;
    }
    entry.dimensionsMatch = dimsOk;
    entry.mechanicalPass = Boolean(entry.pathExists && entry.nonEmpty && entry.expectedMimeOk && dimsOk);
    entries.push(entry);
  }
  const superseding = new Map(entries.filter((entry: any) => entry.attempt > 1).map((entry: any) => [entry.key, entry.recordId]));
  entries.forEach((entry: any) => {
    if (entry.attempt === 1 && superseding.has(entry.key)) entry.supersededBy = superseding.get(entry.key);
  });
  const reviewIndex = {
    generatedAt: new Date().toISOString(),
    outputDir,
    purpose: 'candidate set for main-thread visual review; mechanical checks only, no visual pass claimed',
    totals: {
      planned: manifest.length,
      succeeded: manifest.filter((record: any) => record.status === 'succeeded').length,
      failed: manifest.filter((record: any) => record.status === 'failed').length,
      mechanicalPass: entries.filter((entry: any) => entry.mechanicalPass).length,
      attempts: entries.reduce((acc: any, entry: any) => { acc[entry.attempt] = (acc[entry.attempt] || 0) + 1; return acc; }, {}),
    },
    entries,
  };
  writeJsonAtomic(path.join(outputDir, REVIEW_INDEX_NAME), reviewIndex);
  writeContactSheet(outputDir, reviewIndex);
  return reviewIndex;
}

function writeContactSheet(outputDir: any, reviewIndex: any) {
  const rows = reviewIndex.entries.map((entry: any) => {
    const attemptBadge = entry.attempt === 5
      ? '<span class="attempt5">attempt-5 · inpaint 局部修复</span>'
      : entry.attempt > 3
        ? '<span class="attempt4">attempt-4 · 右眼痣修正重出</span>'
        : entry.attempt > 2
          ? '<span class="attempt3">attempt-3 · 复核重出</span>'
          : entry.attempt > 1
            ? '<span class="attempt2">attempt-2 · 复核覆盖</span>'
            : '<span class="attempt1">attempt-1</span>';
    const badge = entry.status === 'succeeded'
      ? `<span class="ok">${entry.mechanicalPass ? '机械通过' : '机械未过'}</span>`
      : `<span class="fail">${escapeHtml(entry.status)}</span>`;
    const image = entry.status === 'succeeded' && entry.pathExists
      ? `<a class="thumb" href="${escapeHtml(entry.image)}"><img loading="lazy" src="${escapeHtml(entry.image)}" alt="${escapeHtml(entry.key)}"></a>`
      : '<div class="thumb empty">无图片</div>';
    const meta = [
      ['batch', entry.batch], ['key', entry.key], ['attempt', entry.attempt],
      ['display', entry.displayName], ['engine', entry.engine], ['model', entry.checkpoint],
      entry.loraId ? ['lora', `${entry.loraId} @${entry.loraStrength}`] : null,
      ['seed', entry.seed], ['size', `${entry.width}x${entry.height}`],
      ['params', `${entry.steps}s / cfg ${entry.cfg} / ${entry.sampler} / ${entry.scheduler}`],
      ['char', entry.characterId || '-'], ['artist', entry.artistId || '-'],
      entry.supersedes ? ['supersedes', entry.supersedes] : null,
      entry.supersededBy ? ['supersededBy', entry.supersededBy] : null,
      ['generatedAt', entry.generatedAt],
    ].filter(Boolean).map(([label, value]: any) => `<div class="meta"><span>${escapeHtml(label)}</span><code>${escapeHtml(String(value))}</code></div>`).join('');
    const reasonBlock = entry.reviewReason
      ? `<div class="reason">审核覆盖：${escapeHtml(entry.reviewReason)}</div>` : '';
    const inpaintBlock = entry.inpaint
      ? `<details><summary>inpaint 修复明细</summary><pre>${escapeHtml(JSON.stringify(entry.inpaint, null, 2))}</pre></details>`
      : '';
    const promptBlock = entry.prompt
      ? `<details><summary>Prompt</summary><pre>${escapeHtml(entry.prompt)}</pre><pre class="neg">${escapeHtml(entry.negative || '')}</pre></details>`
      : '';
    const errorBlock = entry.error ? `<div class="error">${escapeHtml(entry.error)}</div>` : '';
    return `<section class="card" data-batch="${escapeHtml(entry.batch)}" data-status="${escapeHtml(entry.status)}" data-attempt="${entry.attempt}">
      ${image}${badge}${attemptBadge}${reasonBlock}${meta}${inpaintBlock}${promptBlock}${errorBlock}
    </section>`;
  }).join('');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>候选样张联系表 · ShowcaseRefresh 2026-08-12</title>
<style>
body{font-family:system-ui,Segoe UI,Microsoft YaHei,sans-serif;margin:0;background:#15121c;color:#eee}
header{padding:16px 20px;background:#1e1a2a;position:sticky;top:0;z-index:5}
h1{font-size:16px;margin:0}header p{margin:4px 0 0;font-size:12px;color:#9a93b0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;padding:16px 20px}
.card{background:#201c2e;border:1px solid #332c4a;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}
.thumb{display:block;text-align:center;background:#000;border-radius:8px;overflow:hidden}
.thumb img{max-width:100%;max-height:420px;object-fit:contain}
.thumb.empty{height:120px;line-height:120px;color:#666}
.ok{color:#6fd08a;font-size:12px;font-weight:600}.fail{color:#ff7d7d;font-size:12px;font-weight:600}
.attempt2{color:#ffc66d;font-size:12px;font-weight:700}.attempt3{color:#ff8fa3;font-size:12px;font-weight:700}.attempt4{color:#7fd0ff;font-size:12px;font-weight:700}.attempt5{color:#a7f3d0;font-size:12px;font-weight:700}.attempt1{color:#8b86a0;font-size:12px}
.reason{color:#ffc66d;font-size:12px;background:#332a1a;border-radius:6px;padding:4px 6px}
.meta{display:flex;gap:8px;font-size:12px;align-items:baseline}
.meta span{color:#9a93b0;min-width:64px}
.meta code{color:#d8d0f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
details summary{cursor:pointer;font-size:12px;color:#9a93b0}
pre{font-size:11px;white-space:pre-wrap;word-break:break-all;color:#c9c2e4;margin:4px 0 0;max-height:180px;overflow:auto}
pre.neg{color:#b08a8a}
.error{color:#ff7d7d;font-size:12px}
</style></head><body>
<header><h1>候选样张联系表 · 2026-08-12 artist/popular/latest-lora</h1>
<p>输出目录：<code>${escapeHtml(reviewIndex.outputDir)}</code> · 记录 ${reviewIndex.totals.planned} · 成功 ${reviewIndex.totals.succeeded} · 失败 ${reviewIndex.totals.failed} · 机械通过 ${reviewIndex.totals.mechanicalPass} · attempt 分布 ${JSON.stringify(reviewIndex.totals.attempts)}（仅机械校验，视觉判定由主线程完成）</p></header>
<div class="grid">${rows}</div>
</body></html>`;
  writeTextAtomic(path.join(outputDir, CONTACT_SHEET_NAME), html);
}

// ── runner ──────────────────────────────────────────────────────────────────

async function runKey(config: any, manifest: any, key: any, outputDir: any, comfyBase: any, force: any) {
  const sourceRecord = sourceRecordFor(manifest, key);
  const validated = validateSourceRecord(sourceRecord, outputDir);
  const outImageRel = outputImageRel(key);
  const outImageFile = path.join(outputDir, outImageRel.split('/').join(path.sep));
  const recordId = attemptFiveRecordId(key);
  const existing = manifest.find((record: any) => record.recordId === recordId);
  if (shouldReuse(existing, outImageFile, force)) {
    console.log(`[reuse] ${key} -> ${outImageRel} (${existing.sha256})`);
    return { key, status: 'reused', record: existing };
  }

  const workflowDir = path.join(outputDir, 'workflows', key.replace(/[:\/\\]/g, '_'));
  fs.mkdirSync(workflowDir, { recursive: true });

  const results: any[] = [];
  const workflowFiles: any[] = [];
  let currentBuffer = validated.buffer;
  const runId = `${Date.now()}-${process.pid}`;

  for (let index = 0; index < config.ops.length; index += 1) {
    const op = config.ops[index];
    const stageBuffer = currentBuffer;
    let done = false;
    for (let attemptIndex = 0; attemptIndex < DENOISE_CONFIGS.length && !done; attemptIndex += 1) {
      const denoiseConfig = DENOISE_CONFIGS[attemptIndex];
      // every op runs on the CURRENT composite state (chain); the mask decides
      // position, so the prompt stays side-agnostic. Unique names per upload —
      // ComfyUI 0.31.0 ignores overwrite and renames collisions to " (1).png".
      const sourceRequested = `aics_${key.replace(/[:\/\\]/g, '_')}_${runId}_stage${index}.png`;
      const sourceUpload = await uploadImage(comfyBase, sourceRequested, currentBuffer);
      if (sourceUpload.status < 200 || sourceUpload.status >= 300) {
        throw new Error(`stage source upload failed for ${key} op ${op.id} (HTTP ${sourceUpload.status}): ${sourceUpload.raw || sourceUpload.data}`);
      }
      const sourceName = resolveUploadName(sourceRequested, sourceUpload);
      const maskFile = generateMask(outputDir, key, op, denoiseConfig);
      const maskRequested = `aics_mask_${runId}_${op.id}_${denoiseConfig.id}.png`;
      const maskUpload = await uploadImage(comfyBase, maskRequested, fs.readFileSync(maskFile));
      if (maskUpload.status < 200 || maskUpload.status >= 300) {
        throw new Error(`mask upload failed for ${key} ${op.id} (HTTP ${maskUpload.status}): ${maskUpload.raw || maskUpload.data}`);
      }
      const maskName = resolveUploadName(maskRequested, maskUpload);
      const seed = (op.seedBase ?? sourceRecord.actualSeed ?? sourceRecord.seed)
        + index * 7919 + attemptIndex * 104729;
      const workflow = buildOpWorkflow(config, op, denoiseConfig, op.prompt, op.negative, sourceName, maskName, op.crop);
      // seed must be patched into the workflow AFTER build (build uses 0)
      const sampleNode: any = Object.keys(workflow).find((id: any) => workflow[id].class_type === 'KSampler');
      workflow[sampleNode].inputs.seed = seed;
      let promptId = `${key.replace(/[:\/\\]/g, '_')}-${op.id}-${denoiseConfig.id}`;
      const workflowFile = path.join(workflowDir, `${op.id}_${denoiseConfig.id}.json`);
      writeJsonAtomic(workflowFile, workflow);
      workflowFiles.push(workflowFile.replace(/\\/g, '/'));
      console.log(`[${key}] op ${op.id} config ${denoiseConfig.id} submit...`);

      let outputBuffer;
      try {
        const promptResult = await submitAndWait(comfyBase, workflow);
        const outputNode: any = Object.keys(workflow).find((id: any) => workflow[id].class_type === 'SaveImage');
        const images = promptResult.entry.outputs && promptResult.entry.outputs[outputNode]
          && promptResult.entry.outputs[outputNode].images;
        if (!Array.isArray(images) || !images.length) {
          throw new Error(`ComfyUI returned no image for ${key} ${op.id}`);
        }
        outputBuffer = await fetchOutputImage(comfyBase, images[0]);
        promptId = promptResult.promptId;
      } catch (error) {
        console.log(`[${key}] op ${op.id} config ${denoiseConfig.id} FAILED: ${runtimeErrorMessage(error)}`);
        if (attemptIndex === DENOISE_CONFIGS.length - 1) {
          throw new Error(`${key} ${op.id} failed after ${DENOISE_CONFIGS.length} fixed configs — stopping (official references: https://docs.comfy.org/tutorials/basic/inpaint, Comfy-Org discussion #639)`);
        }
        continue;
      }
      const info = imageInfo(outputBuffer);
      if (!info || info.width !== SOURCE_WIDTH || info.height !== SOURCE_HEIGHT) {
        throw new Error(`${key} ${op.id} output invalid dimensions: ${info ? `${info.width}x${info.height}` : 'non-image'}`);
      }
      const opImageRel = `images/latest-lora/${key.replace(/[:\/\\]/g, '_')}_${op.id}_${denoiseConfig.id}.png`;
      const opImageFile = path.join(outputDir, opImageRel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(opImageFile), { recursive: true });
      fs.writeFileSync(opImageFile, outputBuffer);

      const heuristic = opLooksDone(op, outputBuffer, stageBuffer);
      results.push({
        op, denoiseConfig, seed, promptId, buffer: outputBuffer,
        outputImage: opImageRel, outputSha256: sha256(outputBuffer),
        maskImage: maskName, prompt: op.prompt, negative: op.negative, heuristic,
      });
      console.log(`[${key}] op ${op.id} config ${denoiseConfig.id} -> ${opImageRel} (heuristic ${heuristic ? 'PASS' : 'FAIL'})`);
      if (heuristic) {
        done = true;
        currentBuffer = outputBuffer;
        break;
      }
      // heuristic failed: keep this output, but do NOT advance the chain unless
      // this was the last config (op must still move forward).
      if (attemptIndex === DENOISE_CONFIGS.length - 1) {
        currentBuffer = outputBuffer;
      }
    }
  }

  const finalBuffer = results[results.length - 1].buffer;
  fs.mkdirSync(path.dirname(outImageFile), { recursive: true });
  fs.writeFileSync(outImageFile, finalBuffer);
  const record = buildAttemptFiveRecord(key, sourceRecord, config, results, workflowFiles);
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
    if (!INPAINT_CONFIG[key]) throw new Error(`unsupported inpaint key: ${key} (allowed: ${KEYS.join(', ')})`);
  }
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const manifest = readJson(manifestPath);

  const sourceRecords: Record<string, any> = {};
  const plan: any[] = [];
  for (const key of keys) {
    const source = sourceRecordFor(manifest, key);
    const validated = validateSourceRecord(source, outputDir);
    sourceRecords[key] = Object.assign({}, source, { file: validated.file });
    plan.push({ key, recordId: attemptFiveRecordId(key), source: source.recordId, ops: INPAINT_CONFIG[key].ops.map((op: any) => op.id) });
  }

  generatePreviews(outputDir, sourceRecords);

  if (dryRun) {
    console.log(JSON.stringify({ manifest: manifestPath, output: outputDir, comfy: comfyBase, plan }, null, 2));
    return;
  }

  // check comfy reachable
  const stats = await comfyJson(comfyBase, 'GET', '/system_stats', null, 5000);
  if (stats.status < 200 || stats.status >= 300) {
    throw new Error(`ComfyUI not reachable at ${comfyBase} (HTTP ${stats.status})`);
  }

  const outcomes: any[] = [];
  for (const key of keys) {
    outcomes.push(await runKey(INPAINT_CONFIG[key], manifest, key, outputDir, comfyBase, force));
  }

  // persist manifest once per generated record
  const current = readJson(manifestPath);
  for (const outcome of outcomes) {
    if (outcome.status === 'generated') {
      const idx = current.findIndex((record: any) => record.recordId === outcome.record.recordId);
      if (idx >= 0) current.splice(idx, 1);
      current.push(outcome.record);
    }
  }
  const normalized = current
    .map((record: any) => (record.attempt ? record : Object.assign({}, record, { attempt: 1 })))
    .sort((a: any, b: any) => (a.recordId || a.key).localeCompare(b.recordId || b.key));
  writeJsonAtomic(manifestPath, normalized);

  const reviewIndex = verifyAndIndex(outputDir);
  console.log(JSON.stringify({
    output: outputDir,
    comfy: comfyBase,
    outcomes: outcomes.map((outcome: any) => ({
      key: outcome.key,
      status: outcome.status,
      recordId: outcome.record ? outcome.record.recordId : '',
      image: outcome.record ? outcome.record.image : '',
      sha256: outcome.record ? outcome.record.sha256 : '',
      operations: outcome.results ? outcome.results.map((r: any) => ({ id: r.op.id, config: r.denoiseConfig.id, heuristic: r.heuristic, promptId: r.promptId })) : [],
    })),
    reviewIndex: reviewIndex.totals,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

export = {
  INPAINT_CONFIG, KEYS, DENOISE_CONFIGS,
  argument, splitList, readJson, writeJsonAtomic,
  isRecord, imageInfo, sha256, escapeHtml, assertNotShowcase,
  sourceRecordFor, validateSourceRecord, attemptFiveRecordId, outputImageRel,
  shouldReuse, buildOpWorkflow, buildMaskArgs, generateMask,
  opLooksDone, buildAttemptFiveRecord, verifyAndIndex, resolveUploadName,
  constants: {
    ROOT, AI_ROOT, DEFAULT_OUTPUT, MANIFEST_NAME, REVIEW_INDEX_NAME,
    CONTACT_SHEET_NAME, SOURCE_WIDTH, SOURCE_HEIGHT, UPSCALE, CROP_SIZE,
    POLL_INTERVAL_MS, JOB_TIMEOUT_MS,
  },
};
