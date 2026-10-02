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

const inpaint: typeof import('../../scripts/maintenance/inpaint-showcase-candidates.js') = require('../../scripts/maintenance/inpaint-showcase-candidates.js');
const genConst = (require('../lib/generation/sd-catalog.js') as typeof import('../lib/generation/sd-catalog.js'));
const animaConst = (require('../lib/generation/anima-model-catalog.js') as typeof import('../lib/generation/anima-model-catalog.js'));

const W = inpaint.constants.SOURCE_WIDTH;
const H = inpaint.constants.SOURCE_HEIGHT;

function makePng(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 180, b: 160 } } }).png().toBuffer();
}

test('INPAINT_CONFIG covers exactly the two natsume fullbody keys', () => {
  assert.deepStrictEqual(
    [...inpaint.KEYS].sort(),
    ['latest-lora:natsume:anima:fullbody', 'latest-lora:natsume:sd:fullbody'].sort(),
  );
  const sd = inpaint.INPAINT_CONFIG['latest-lora:natsume:sd:fullbody'];
  const anima = inpaint.INPAINT_CONFIG['latest-lora:natsume:anima:fullbody'];
  assert.strictEqual(sd.engine, 'sd');
  assert.strictEqual(anima.engine, 'anima');
  assert.strictEqual(sd.checkpoint, genConst.CHECKPOINT, 'WAI checkpoint must stay production');
  assert.strictEqual(sd.lora.file, genConst.LORAS.L_NAT_V18_WD14.file, 'WAI v18 LoRA must stay production');
  assert.strictEqual(sd.lora.strength, 0.85);
  assert.strictEqual(anima.lora.file, animaConst.LORAS.L_NAT_V21_ANIMA.file, 'Anima v21 LoRA must stay production');
  assert.strictEqual(anima.lora.strength, 0.85);
  assert.strictEqual(anima.unet, animaConst.MODELS['anima-base-v1.0'].file, 'Anima base checkpoint');
  assert.ok(sd.sampler && sd.scheduler && sd.steps && sd.cfg, 'WAI sampler params present');
  assert.strictEqual(anima.sampler, 'res_multistep', 'Anima sampler contract');
  assert.strictEqual(anima.scheduler, 'simple', 'Anima scheduler contract');
});

test('all crop/mask coordinates stay inside the 960x1536 source bounds', () => {
  for (const key of inpaint.KEYS) {
    const cfg = inpaint.INPAINT_CONFIG[key];
    for (const op of cfg.ops) {
      assert.ok(op.crop && op.crop.x >= 0 && op.crop.y >= 0, `${key} ${op.id} crop origin`);
      assert.ok(op.crop.x + op.crop.w <= W, `${key} ${op.id} crop x+w in bounds`);
      assert.ok(op.crop.y + op.crop.h <= H, `${key} ${op.id} crop y+h in bounds`);
      assert.ok(Number.isInteger(op.crop.x) && Number.isInteger(op.crop.y), `${key} ${op.id} crop integer origin`);
      assert.ok(op.crop.w >= 64 && op.crop.h >= 64, `${key} ${op.id} crop must be large enough for upscale`);
      for (const shape of op.mask) {
        assert.strictEqual(shape.kind, 'ellipse');
        assert.ok(shape.cx - shape.rx >= 0 && shape.cx + shape.rx <= W, `${key} ${op.id} mask x in bounds`);
        assert.ok(shape.cy - shape.ry >= 0 && shape.cy + shape.ry <= H, `${key} ${op.id} mask y in bounds`);
        assert.ok(Number.isInteger(shape.cx) && Number.isInteger(shape.cy), `${key} ${op.id} mask integer coords`);
      }
    }
  }
});

test('denoise configs are bounded: primary masked img2img + one true-inpaint fallback', () => {
  assert.strictEqual(inpaint.DENOISE_CONFIGS.length, 2);
  assert.deepStrictEqual(inpaint.DENOISE_CONFIGS.map(c => c.id), ['masked-0.70', 'inpaint-1.00']);
  const primary = inpaint.DENOISE_CONFIGS[0];
  assert.strictEqual(primary.mode, 'set-noisy-mask');
  assert.ok(primary.denoise >= 0.65 && primary.denoise <= 0.75, 'primary denoise in 0.65-0.75');
  const fallback = inpaint.DENOISE_CONFIGS[1];
  assert.strictEqual(fallback.mode, 'vae-inpaint');
  assert.strictEqual(fallback.denoise, 1.0);
});

test('buildOpWorkflow mirrors the production model chains and official inpaint node flow', () => {
  const sdCfg = inpaint.INPAINT_CONFIG['latest-lora:natsume:sd:fullbody'];
  const sdWf = inpaint.buildOpWorkflow(
    sdCfg, sdCfg.ops[0], inpaint.DENOISE_CONFIGS[0],
    'prompt', 'neg', 'src.png', 'mask.png', sdCfg.ops[0].crop,
  );
  const sdTypes = Object.values(sdwfTypes(sdWf));
  assert.ok(sdTypes.includes('CheckpointLoaderSimple'));
  assert.ok(sdTypes.includes('LoraLoader'));
  assert.ok(sdTypes.includes('CLIPTextEncode'));
  assert.ok(sdTypes.includes('ImageCrop') && sdTypes.includes('ImageScale'));
  assert.ok(sdTypes.includes('VAEEncode') && sdTypes.includes('SetLatentNoiseMask'));
  assert.ok(sdTypes.includes('KSampler') && sdTypes.includes('VAEDecode'));
  assert.ok(sdTypes.includes('ImageCompositeMasked') && sdTypes.includes('SaveImage'));

  const animaCfg = inpaint.INPAINT_CONFIG['latest-lora:natsume:anima:fullbody'];
  const animaWf = inpaint.buildOpWorkflow(
    animaCfg, animaCfg.ops[0], inpaint.DENOISE_CONFIGS[0],
    'prompt', 'neg', 'src.png', 'mask.png', animaCfg.ops[0].crop,
  );
  const animaTypes = Object.values(sdwfTypes(animaWf));
  assert.ok(animaTypes.includes('UNETLoader') && animaTypes.includes('CLIPLoader') && animaTypes.includes('VAELoader'));
  assert.ok(animaTypes.includes('LoraLoader'));

  // fallback mode swaps VAEEncode+SetLatentNoiseMask for VAEEncodeForInpaint
  const fallbackWf = inpaint.buildOpWorkflow(
    sdCfg, sdCfg.ops[0], inpaint.DENOISE_CONFIGS[1],
    'prompt', 'neg', 'src.png', 'mask.png', sdCfg.ops[0].crop,
  );
  const fallbackTypes = Object.values(sdwfTypes(fallbackWf));
  assert.ok(!fallbackTypes.includes('SetLatentNoiseMask'));
  assert.ok(fallbackTypes.includes('VAEEncodeForInpaint'));

  // KSampler must carry the low denoise from the config
  const ksampler = Object.values(sdWf).find(node => node.class_type === 'KSampler');
  assert.strictEqual(ksampler.inputs.denoise, 0.7);
  assert.strictEqual(ksampler.inputs.steps, sdCfg.steps);
  assert.strictEqual(ksampler.inputs.cfg, sdCfg.cfg);
  assert.strictEqual(ksampler.inputs.sampler_name, sdCfg.sampler);
  assert.strictEqual(ksampler.inputs.scheduler, sdCfg.scheduler);

  // composite pastes the downscaled crop back onto the full source at the crop origin
  const composite = Object.values(sdWf).find(node => node.class_type === 'ImageCompositeMasked');
  assert.strictEqual(composite.inputs.x, sdCfg.ops[0].crop.x);
  assert.strictEqual(composite.inputs.y, sdCfg.ops[0].crop.y);
  assert.strictEqual(composite.inputs.resize_source, false);
});

function sdwfTypes(wf: any) {
  return Object.keys(wf).map(id => wf[id].class_type);
}

test('buildMaskArgs emits ellipse/rect shape tokens for the python maskgen', () => {
  const cfg = inpaint.INPAINT_CONFIG['latest-lora:natsume:anima:fullbody'];
  const args = inpaint.buildMaskArgs(cfg.ops[0]);
  assert.ok(args.includes('--ellipse'));
  assert.strictEqual(args[1], String(cfg.ops[0].mask[0].cx));
});

test('resolveUploadName uses the server-returned name (ComfyUI renames on collision)', () => {
  // ComfyUI 0.31.0 ignores overwrite and returns "x (1).png" for a collision.
  const ok = inpaint.resolveUploadName('stage.png', { status: 200, data: { name: 'stage (1).png' } });
  assert.strictEqual(ok, 'stage (1).png');
  const fresh = inpaint.resolveUploadName('stage.png', { status: 200, data: { name: 'stage.png' } });
  assert.strictEqual(fresh, 'stage.png');
  const fallback = inpaint.resolveUploadName('stage.png', { status: 200, data: null });
  assert.strictEqual(fallback, 'stage.png');
});

test('opLooksDone is source-relative: mole add darkens, mole remove lightens, clips add red', async () => {
  // build tiny real PNG buffers with a known dark spot / red spot
  function pngWith(cells: { kind: string; x: number; y: number; r: number }[]) {
    const pixels = Buffer.alloc(64 * 64 * 3, 240);
    for (const cell of cells) for (let y = cell.y - cell.r; y <= cell.y + cell.r; y++) {
      for (let x = cell.x - cell.r; x <= cell.x + cell.r; x++) {
        const rgb = cell.kind === 'dark' ? [60, 40, 30] : [220, 30, 30];
        pixels.set(rgb, (y * 64 + x) * 3);
      }
    }
    return sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
  }
  const addOp = { kind: 'add', id: 'add-mole', mask: [{ kind: 'ellipse', cx: 20, cy: 20, rx: 5, ry: 5 }] };
  const plainSrc = await pngWith([]);
  const moleOut = await pngWith([{ kind: 'dark', x: 20, y: 20, r: 4 }]);
  assert.strictEqual(inpaint.opLooksDone(addOp, moleOut, plainSrc), true, 'mole added must pass');
  assert.strictEqual(inpaint.opLooksDone(addOp, plainSrc, plainSrc), false, 'no change must fail');

  const removeOp = { kind: 'remove', id: 'remove-wrong-mole', mask: [{ kind: 'ellipse', cx: 20, cy: 20, rx: 5, ry: 5 }] };
  const moleSrc = await pngWith([{ kind: 'dark', x: 20, y: 20, r: 4 }]);
  const cleanOut = await pngWith([]);
  assert.strictEqual(inpaint.opLooksDone(removeOp, cleanOut, moleSrc), true, 'mole removed must pass');
  assert.strictEqual(inpaint.opLooksDone(removeOp, moleSrc, moleSrc), false, 'mole still present must fail');

  const clipOp = { id: 'add-hairclips', kind: 'add', mask: [
    { kind: 'ellipse', cx: 20, cy: 20, rx: 5, ry: 5 },
    { kind: 'ellipse', cx: 42, cy: 20, rx: 5, ry: 5 },
  ] };
  // derived band = (3,6)-(59,34). Two 5px-radius red blobs at (20,20)/(42,20) give ~150 red.
  const clipOut = await pngWith([{ kind: 'red', x: 20, y: 20, r: 4 }, { kind: 'red', x: 42, y: 20, r: 4 }]);
  assert.strictEqual(inpaint.opLooksDone(clipOp, clipOut, plainSrc), true, 'two red clips added must pass');
  const oneClip = await pngWith([{ kind: 'red', x: 20, y: 20, r: 2 }]);
  assert.strictEqual(inpaint.opLooksDone(clipOp, oneClip, plainSrc), false, 'only a tiny single red blob must fail');
  assert.strictEqual(inpaint.opLooksDone(clipOp, plainSrc, plainSrc), false, 'no red must fail');
  // clipBand override caps the band away from a flower bleed
  const bandOp = { ...clipOp, clipBand: { x0: 18, y0: 18, x1: 46, y1: 22 } };
  assert.strictEqual(inpaint.opLooksDone(bandOp, clipOut, plainSrc), true, 'clipBand override still passes');
});

test('attempt-5 record contract: recordId, supersedes, provenance, sha256', () => {
  const key = 'latest-lora:natsume:sd:fullbody';
  const cfg = inpaint.INPAINT_CONFIG[key];
  const source = {
    key, recordId: `${key}@attempt-4`, status: 'succeeded',
    actualWidth: W, actualHeight: H, seed: 123, actualSeed: 456,
    prompt: 'src prompt', negative: 'src neg', width: W, height: H,
    checkpoint: cfg.checkpoint, loraId: 'L_NAT_V18_WD14', loraStrength: 0.85,
  };
  const results = cfg.ops.map((op: any, index: any) => ({
    op,
    denoiseConfig: inpaint.DENOISE_CONFIGS[index % 2],
    seed: 100 + index,
    promptId: `pid-${index}`,
    buffer: Buffer.alloc(64, index + 1),
    outputImage: `images/latest-lora/${key.replace(/[:\/\\]/g, '_')}_${op.id}_x.png`,
    outputSha256: 'deadbeef' + index,
    maskImage: 'mask.png',
    prompt: op.prompt,
    negative: op.negative,
    heuristic: true,
  }));
  const record = inpaint.buildAttemptFiveRecord(key, source, cfg, results, ['workflows/x.json']);
  assert.strictEqual(record.recordId, `${key}@attempt-5`);
  assert.strictEqual(record.supersedes, `${key}@attempt-4`);
  assert.strictEqual(record.attempt, 5);
  assert.strictEqual(record.status, 'succeeded');
  assert.strictEqual(record.actualWidth, W);
  assert.strictEqual(record.actualHeight, H);
  assert.strictEqual(record.image, inpaint.outputImageRel(key));
  assert.ok(record.postprocess && record.postprocess.kind === 'inpaint');
  assert.strictEqual(record.inpaint.sourceRecordId, `${key}@attempt-4`);
  assert.deepStrictEqual(record.inpaint.workflowFiles, ['workflows/x.json']);
  assert.strictEqual(record.inpaint.operations.length, cfg.ops.length);
  const first = record.inpaint.operations[0];
  assert.strictEqual(first.id, cfg.ops[0].id);
  assert.deepStrictEqual(first.crop, cfg.ops[0].crop);
  assert.deepStrictEqual(first.mask, cfg.ops[0].mask);
  assert.ok(first.promptId && first.outputSha256 && Number.isFinite(first.seed) && first.denoise);
  assert.strictEqual(record.sha256, inpaint.sha256(results[results.length - 1].buffer));
  assert.strictEqual(record.jobId, results[results.length - 1].promptId);
});

test('sourceRecordFor + validateSourceRecord: hash, status, dimensions gate', async () => {
  const manifest = [
    { recordId: 'latest-lora:natsume:sd:fullbody@attempt-4', status: 'succeeded', actualWidth: W, actualHeight: H, image: 'a.png', sha256: '' },
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-inpaint-test-'));
  try {
    const buffer = await makePng(W, H);
    fs.writeFileSync(path.join(root, 'a.png'), buffer);
    const record = inpaint.sourceRecordFor(manifest, 'latest-lora:natsume:sd:fullbody');
    assert.ok(record);
    const ok = inpaint.validateSourceRecord(Object.assign({}, record, { sha256: inpaint.sha256(buffer) }), root);
    assert.ok(ok.buffer.length === buffer.length);
    assert.throws(() => inpaint.validateSourceRecord({ status: 'failed', actualWidth: W, actualHeight: H, image: 'a.png' }, root), /not succeeded/);
    assert.throws(() => inpaint.validateSourceRecord(Object.assign({}, record, { actualWidth: 512 }), root), /960x1536/);
    assert.throws(() => inpaint.validateSourceRecord(Object.assign({}, record, { sha256: 'wrong' }), root), /hash mismatch/);
    assert.throws(() => inpaint.validateSourceRecord(Object.assign({}, record, { image: 'missing.png' }), root), /source image missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shouldReuse: resume semantics honour --force and hash/size gates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-inpaint-test-'));
  try {
    const image = path.join(root, 'ok.png');
    fs.writeFileSync(image, await makePng(W, H));
    const record = { status: 'succeeded', image: 'ok.png', sha256: '' };
    assert.strictEqual(inpaint.shouldReuse(record, image, false), true);
    assert.strictEqual(inpaint.shouldReuse(record, image, true), false, '--force must regenerate');
    assert.strictEqual(inpaint.shouldReuse({ ...record, status: 'failed' }, image, false), false);
    fs.writeFileSync(image, Buffer.alloc(10));
    assert.strictEqual(inpaint.shouldReuse(record, image, false), false, 'tiny files must not be reused');
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

test('imageInfo rejects garbage and reads PNG dimensions', () => {
  const png = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 4, 0, 0, 0, 5, 32, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const info = inpaint.imageInfo(png);
  assert.deepStrictEqual({ mime: info!.mime, width: info!.width, height: info!.height }, { mime: 'image/png', width: 1024, height: 1312 });
  assert.strictEqual(inpaint.imageInfo(Buffer.from([0, 1, 2, 3])), null);
});
