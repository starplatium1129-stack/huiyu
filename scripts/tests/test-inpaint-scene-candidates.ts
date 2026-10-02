'use strict';

const sharp: typeof import('sharp').default = require('sharp');

/** Isolated repair-tool behavior: crop/mask bounds, finite attempts, compiled
 * workflow, source identity, resumability and refusal to overwrite published
 * assets. Historical art wording is not a code contract or render evidence. */

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');

const inpaint: typeof import('../../scripts/maintenance/inpaint-scene-candidates.js') = require('../../scripts/maintenance/inpaint-scene-candidates.js');
const animaConst = (require('../../routes/anima.js') as typeof import('../../routes/anima.js')).constants;

function makePng(width: number, height: number, spot: { cx: number; cy: number; rx: number; ry: number } | null) {
  const pixels = Buffer.alloc(width * height * 3, 200);
  if (spot) for (let y = spot.cy - spot.ry; y <= spot.cy + spot.ry; y++) {
    pixels.fill(40, (y * width + spot.cx - spot.rx) * 3, (y * width + spot.cx + spot.rx + 1) * 3);
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function workflowTypes(wf: any) {
  return Object.keys(wf).map(id => wf[id].class_type);
}

test('SCENE_INPAINT_CONFIG covers exactly scene:sc037, scene:sc280 and scene:sc214 with per-key source attempts', () => {
  assert.deepStrictEqual([...inpaint.KEYS].sort(), ['scene:sc037', 'scene:sc214', 'scene:sc280']);
  const sc037 = inpaint.SCENE_INPAINT_CONFIG['scene:sc037'];
  const sc280 = inpaint.SCENE_INPAINT_CONFIG['scene:sc280'];
  const sc214 = inpaint.SCENE_INPAINT_CONFIG['scene:sc214'];
  assert.strictEqual(sc037.sourceAttempt, 8, 'sc037 inpaints its attempt-8 source');
  assert.strictEqual(sc280.sourceAttempt, 6, 'sc280 inpaints its attempt-6 source (clean hands + cups, wrapper-free fingers)');
  assert.strictEqual(sc214.sourceAttempt, 15, 'sc214 inpaints its attempt-15 source (6 failed re-rolls)');
  assert.strictEqual(sc214.attempt, 16, 'sc214 repair lands on attempt-16 to avoid clashing with scene re-roll numbering');
  assert.deepStrictEqual([sc037.width, sc037.height], [832, 1216]);
  assert.deepStrictEqual([sc280.width, sc280.height], [1216, 832]);
  assert.deepStrictEqual([sc214.width, sc214.height], [832, 1216]);
  for (const cfg of [sc037, sc280, sc214]) {
    assert.strictEqual(cfg.engine, 'anima');
    assert.strictEqual(cfg.unet, animaConst.MODELS['anima-base-v1.0'].file, 'Anima base checkpoint must stay production');
    assert.strictEqual(cfg.lora.file, animaConst.LORAS.L_NAT_V21_ANIMA.file, 'production natsume v21 Anima LoRA');
    assert.strictEqual(cfg.lora.strength, 0.85);
    assert.strictEqual(cfg.sampler, 'res_multistep', 'Anima sampler contract');
    assert.strictEqual(cfg.scheduler, 'simple', 'Anima scheduler contract');
    assert.strictEqual(cfg.steps, 30);
    assert.strictEqual(cfg.cfg, 4.5);
  }
});

test('every crop/mask coordinate stays inside the per-key source bounds', () => {
  for (const key of inpaint.KEYS) {
    const cfg = inpaint.SCENE_INPAINT_CONFIG[key];
    for (const op of cfg.ops) {
      assert.ok(op.crop && op.crop.x >= 0 && op.crop.y >= 0, `${key} ${op.id} crop origin`);
      assert.ok(op.crop.x + op.crop.w <= cfg.width, `${key} ${op.id} crop x+w in bounds`);
      assert.ok(op.crop.y + op.crop.h <= cfg.height, `${key} ${op.id} crop y+h in bounds`);
      assert.ok(Number.isInteger(op.crop.x) && Number.isInteger(op.crop.y), `${key} ${op.id} crop integer origin`);
      assert.ok(op.crop.w >= 64 && op.crop.h >= 64, `${key} ${op.id} crop must be large enough for upscale`);
      for (const shape of op.mask) {
        if (shape.kind === 'ellipse') {
          assert.ok(shape.cx - shape.rx >= 0 && shape.cx + shape.rx <= cfg.width, `${key} ${op.id} mask x in bounds`);
          assert.ok(shape.cy - shape.ry >= 0 && shape.cy + shape.ry <= cfg.height, `${key} ${op.id} mask y in bounds`);
          assert.ok(Number.isInteger(shape.cx) && Number.isInteger(shape.cy), `${key} ${op.id} mask integer coords`);
        } else if (shape.kind === 'rect') {
          assert.ok(shape.x0 >= 0 && shape.y0 >= 0 && shape.x1 <= cfg.width && shape.y1 <= cfg.height, `${key} ${op.id} rect in bounds`);
          assert.ok(shape.x1 > shape.x0 && shape.y1 > shape.y0, `${key} ${op.id} rect must have positive area`);
          assert.ok(Number.isInteger(shape.x0) && Number.isInteger(shape.y0), `${key} ${op.id} rect integer origin`);
        } else {
          assert.fail(`${key} ${op.id} unknown mask kind ${shape.kind}`);
        }
      }
    }
  }
});

test('denoise configs are bounded: primary masked img2img + one true-inpaint fallback', () => {
  assert.strictEqual(inpaint.DENOISE_CONFIGS.length, 2);
  assert.deepStrictEqual(inpaint.DENOISE_CONFIGS.map(c => c.id), ['masked-0.70', 'inpaint-1.00']);
  assert.strictEqual(inpaint.DENOISE_CONFIGS[0].mode, 'set-noisy-mask');
  assert.ok(inpaint.DENOISE_CONFIGS[0].denoise >= 0.65 && inpaint.DENOISE_CONFIGS[0].denoise <= 0.75);
  assert.strictEqual(inpaint.DENOISE_CONFIGS[1].mode, 'vae-inpaint');
  assert.strictEqual(inpaint.DENOISE_CONFIGS[1].denoise, 1.0);
});

test('buildOpWorkflow mirrors the production Anima chain and official inpaint node flow', () => {
  const cfg = inpaint.SCENE_INPAINT_CONFIG['scene:sc037'];
  const op = cfg.ops[0];
  const primary = inpaint.buildOpWorkflow(
    cfg, op, inpaint.DENOISE_CONFIGS[0],
    'prompt', 'neg', 'src.png', 'mask.png', op.crop,
  );
  const types = workflowTypes(primary);
  for (const expected of ['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoraLoader', 'CLIPTextEncode',
    'ImageCrop', 'ImageScale', 'VAEEncode', 'SetLatentNoiseMask', 'KSampler', 'VAEDecode',
    'ImageCompositeMasked', 'SaveImage']) {
    assert.ok(types.includes(expected), `primary workflow must include ${expected}`);
  }
  const fallback = inpaint.buildOpWorkflow(
    cfg, op, inpaint.DENOISE_CONFIGS[1],
    'prompt', 'neg', 'src.png', 'mask.png', op.crop,
  );
  const fallbackTypes = workflowTypes(fallback);
  assert.ok(!fallbackTypes.includes('SetLatentNoiseMask'), 'fallback must swap out SetLatentNoiseMask');
  assert.ok(fallbackTypes.includes('VAEEncodeForInpaint'), 'fallback must use VAEEncodeForInpaint');
  const ksampler = Object.values(primary).find(node => node.class_type === 'KSampler');
  assert.strictEqual(ksampler.inputs.denoise, 0.7);
  assert.strictEqual(ksampler.inputs.steps, cfg.steps);
  assert.strictEqual(ksampler.inputs.cfg, cfg.cfg);
  assert.strictEqual(ksampler.inputs.sampler_name, cfg.sampler);
  assert.strictEqual(ksampler.inputs.scheduler, cfg.scheduler);
  const composite = Object.values(primary).find(node => node.class_type === 'ImageCompositeMasked');
  assert.strictEqual(composite.inputs.x, op.crop.x);
  assert.strictEqual(composite.inputs.y, op.crop.y);
  assert.strictEqual(composite.inputs.resize_source, false);
  const clip = Object.values(primary).find(node => node.class_type === 'CLIPLoader');
  assert.strictEqual(clip.inputs.type, 'qwen_image', 'Anima uses the qwen_image CLIP loader');
  const lora = Object.values(primary).find(node => node.class_type === 'LoraLoader');
  assert.strictEqual(lora.inputs.lora_name, cfg.lora.file);
  assert.strictEqual(lora.inputs.strength_model, 0.85);
});

test('buildMaskArgs emits ellipse shape tokens for the python maskgen', () => {
  const cfg = inpaint.SCENE_INPAINT_CONFIG['scene:sc280'];
  const args = inpaint.buildMaskArgs(cfg.ops[0]);
  assert.ok(args.includes('--ellipse'));
  assert.strictEqual(args[1], String(cfg.ops[0].mask[0].cx));
});

test('region-delta heuristic gates only the single fixed fallback', async () => {
  const shape = { kind: 'ellipse', cx: 32, cy: 32, rx: 16, ry: 16 };
  const plain = await makePng(64, 64, null);
  const changed = await makePng(64, 64, shape);
  const op = { id: 'replace-wrapper', mask: [shape] };
  assert.strictEqual(inpaint.opLooksDone(op, changed, plain), true, 'changed mask region must pass');
  assert.strictEqual(inpaint.opLooksDone(op, plain, plain), false, 'unchanged mask region must fail and trigger the fallback');
  const noEllipse = { id: 'x', mask: [{ kind: 'rect', x0: 0, y0: 0, x1: 10, y1: 10, feather: 2 }] };
  assert.strictEqual(inpaint.opLooksDone(noEllipse, plain, plain), true, 'non-ellipse masks pass without a local detector');
});

test('attempt-9 record contract: recordId, supersedes, provenance, sha256, image path', () => {
  const key = 'scene:sc037';
  const cfg = inpaint.SCENE_INPAINT_CONFIG[key];
  const source = {
    key, recordId: 'scene:sc037@attempt-8', status: 'succeeded',
    width: cfg.width, height: cfg.height, seed: 123, actualSeed: 456,
    prompt: 'src prompt', negative: 'src neg',
  };
  const results = cfg.ops.map((op: any, index: any) => ({
    op,
    denoiseConfig: inpaint.DENOISE_CONFIGS[index % 2],
    seed: 100 + index,
    promptId: `pid-${index}`,
    buffer: Buffer.alloc(64, index + 1),
    outputImage: `images/sc037/scene_sc037_${op.id}_x.png`,
    outputSha256: 'deadbeef' + index,
    maskImage: 'mask.png',
    prompt: op.prompt,
    negative: op.negative,
    heuristic: true,
  }));
  const record = inpaint.buildAttemptRecord(key, source, cfg, results, ['workflows/scene/x.json']);
  assert.strictEqual(record.recordId, 'scene:sc037@attempt-9');
  assert.strictEqual(record.supersedes, 'scene:sc037@attempt-8');
  assert.strictEqual(record.attempt, 9);
  assert.strictEqual(record.status, 'succeeded');
  assert.strictEqual(record.image, 'images/sc037/attempt-9.png');
  assert.ok(record.postprocess && record.postprocess.kind === 'inpaint');
  assert.strictEqual(record.inpaint.sourceRecordId, 'scene:sc037@attempt-8');
  assert.strictEqual(record.inpaint.operations.length, cfg.ops.length);
  const first = record.inpaint.operations[0];
  assert.strictEqual(first.id, cfg.ops[0].id);
  assert.deepStrictEqual(first.crop, cfg.ops[0].crop);
  assert.deepStrictEqual(first.mask, cfg.ops[0].mask);
  assert.ok(first.promptId && first.outputSha256 && Number.isFinite(first.seed) && first.denoise);
  assert.strictEqual(record.sha256, inpaint.sha256(results[results.length - 1].buffer));
  assert.strictEqual(record.jobId, results[results.length - 1].promptId);
});

test('sourceRecordFor + validateSourceRecord: attempt, status, hash, and per-key dimensions gate', async () => {
  const manifest = [
    { recordId: 'scene:sc037@attempt-8', status: 'succeeded', image: 'images/sc037/attempt-8.png', sha256: '' },
    { recordId: 'scene:sc280@attempt-6', status: 'succeeded', image: 'images/sc280/attempt-6.png', sha256: '' },
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-scene-inpaint-test-'));
  try {
    fs.mkdirSync(path.join(root, 'images', 'sc037'), { recursive: true });
    fs.mkdirSync(path.join(root, 'images', 'sc280'), { recursive: true });
    fs.writeFileSync(path.join(root, 'images', 'sc037', 'attempt-8.png'), await makePng(832, 1216, null));
    fs.writeFileSync(path.join(root, 'images', 'sc280', 'attempt-6.png'), await makePng(1216, 832, null));
    const sc037 = inpaint.sourceRecordFor(manifest, 'scene:sc037');
    assert.strictEqual(sc037.recordId, 'scene:sc037@attempt-8');
    const ok = inpaint.validateSourceRecord('scene:sc037', sc037, root);
    assert.ok(ok.buffer.length > 0);
    const sc280 = inpaint.sourceRecordFor(manifest, 'scene:sc280');
    assert.strictEqual(sc280.recordId, 'scene:sc280@attempt-6');
    assert.ok(inpaint.validateSourceRecord('scene:sc280', sc280, root).buffer.length > 0);
    assert.throws(() => inpaint.validateSourceRecord('scene:sc037', { status: 'failed', image: 'images/sc037/attempt-8.png' }, root), /not succeeded/);
    assert.throws(() => inpaint.validateSourceRecord('scene:sc037', { ...sc037, image: 'images/sc037/missing.png' }, root), /source image missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shouldReuse honours --force, per-key dimensions, and hash gates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-scene-inpaint-test-'));
  try {
    const image = path.join(root, 'ok.png');
    fs.writeFileSync(image, await makePng(832, 1216, null));
    const record = { status: 'succeeded', image: 'ok.png', sha256: '' };
    assert.strictEqual(inpaint.shouldReuse('scene:sc037', record, image, false), true);
    assert.strictEqual(inpaint.shouldReuse('scene:sc037', record, image, true), false, '--force must regenerate');
    assert.strictEqual(inpaint.shouldReuse('scene:sc037', { ...record, status: 'failed' }, image, false), false);
    fs.writeFileSync(image, await makePng(1216, 832, null));
    assert.strictEqual(inpaint.shouldReuse('scene:sc037', record, image, false), false, 'wrong dimensions must not be reused');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to write into the public SceneShowcase directory', () => {
  const showcase = path.resolve(path.join(__dirname, '..', '..', '..', 'AI', 'SceneShowcase'));
  assert.throws(() => inpaint.assertNotShowcase(showcase), /SceneShowcase/);
  assert.throws(() => inpaint.assertNotShowcase(path.join(showcase, '2026-07-22_v14')), /SceneShowcase/);
  const safe = inpaint.assertNotShowcase(inpaint.constants.DEFAULT_OUTPUT);
  assert.strictEqual(safe, path.resolve(inpaint.constants.DEFAULT_OUTPUT));
});
