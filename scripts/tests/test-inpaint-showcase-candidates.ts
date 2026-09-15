'use strict';

import { WithImplicitCoercion } from 'node:buffer';

/**
 * Contract sentinels for the ComfyUI masked local-repair pipeline
 * (scripts/maintenance/inpaint-showcase-candidates.js).
 *
 * Pins, without touching the network:
 *   - the two supported keys are exactly the natsume fullbody attempt-4 keys
 *   - every crop/mask coordinate is inside the 960x1536 source bounds and the
 *     ops are side-agnostic (prompt must NOT encode left/right; the mask does)
 *   - WAI ops = add correct-side mole + add exactly two parallel red hairclips
 *     (negative suppresses flower/ribbon); Anima ops = remove wrong-side mole +
 *     add correct-side mole
 *   - the workflow mirrors routes/generation.js / routes/anima.js model chains
 *     (WAI CheckpointLoaderSimple + LoraLoader; Anima UNETLoader + CLIPLoader +
 *     VAELoader + LoraLoader) and uses the official masked img2img node flow:
 *     ImageCrop → ImageScale → VAEEncode → SetLatentNoiseMask → KSampler(low
 *     denoise) → VAEDecode → ImageScale → ImageCompositeMasked
 *   - denoise configs are a bounded set (SetLatentNoiseMask 0.70 + fallback
 *     VAEEncodeForInpaint 1.00), never an unbounded loop
 *   - attempt-5 record contract: recordId "<key>@attempt-5", supersedes the
 *     attempt-4 source, carries postprocess/inpaint provenance
 *   - resume (shouldReuse) + hard refusal to write into SceneShowcase
 */

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');

const inpaint: typeof import('../../scripts/maintenance/inpaint-showcase-candidates.js') = require('../../scripts/maintenance/inpaint-showcase-candidates.js');
const genConst = (require('../../routes/generation.js') as typeof import('../../routes/generation.js')).constants;
const animaConst = (require('../../routes/anima.js') as typeof import('../../routes/anima.js')).constants;

const W = inpaint.constants.SOURCE_WIDTH;
const H = inpaint.constants.SOURCE_HEIGHT;

function makePng(width: number, height: number) {
  const zlib: typeof import('zlib') = require('zlib');
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  function chunk(type: WithImplicitCoercion<string>, data: any) {
    const name = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    let crc = 0xffffffff;
    for (const buf of [name, data]) {
      for (const byte of buf) {
        crc ^= byte;
        for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc);
    return Buffer.concat([len, name, data, crcBuf]);
  }
  const raw = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = 200;
      raw[row + 1 + x * 3 + 1] = 180;
      raw[row + 1 + x * 3 + 2] = 160;
    }
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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

test('ops are side-agnostic: prompt must not encode left/right, the mask decides position', () => {
  const sd = inpaint.INPAINT_CONFIG['latest-lora:natsume:sd:fullbody'];
  const anima = inpaint.INPAINT_CONFIG['latest-lora:natsume:anima:fullbody'];
  assert.deepStrictEqual(sd.ops.map((op: any) => op.id), ['add-hairclips', 'add-mole']);
  assert.deepStrictEqual(anima.ops.map((op: any) => op.id), ['remove-wrong-mole', 'add-mole']);
  for (const cfg of [sd, anima]) {
    for (const op of cfg.ops) {
      // no "left/right/viewer-side" tokens: the mask alone decides position
      assert.ok(!/(\bleft\b|\bright\b|\bviewer\b|\bleft\s+side|\bright\s+side)/i.test(op.prompt),
        `${cfg.engine} ${op.id} prompt must not encode a side: ${op.prompt}`);
    }
  }
  // The remove op targets the wrong-side mole region only via the mask.
  const remove = anima.ops.find((op: any) => op.id === 'remove-wrong-mole');
  assert.ok(/smooth clean cheek|no beauty mark/i.test(remove.prompt));
  assert.ok(/mole|beauty mark/i.test(remove.negative));
  const addMoleAnima = anima.ops.find((op: any) => op.id === 'add-mole');
  assert.ok(/single tiny beauty mark directly under the eye/i.test(addMoleAnima.prompt));
  const addMoleSd = sd.ops.find((op: any) => op.id === 'add-mole');
  assert.ok(/single tiny beauty mark directly under the eye/i.test(addMoleSd.prompt));
  const clips = sd.ops.find((op: any) => op.id === 'add-hairclips');
  assert.ok(/exactly two small parallel red hairclips/i.test(clips.prompt));
  assert.ok(/red flower|ribbon/i.test(clips.negative), 'hairclip negative must suppress flower/ribbon');
  assert.strictEqual(clips.mask.length, 2, 'exactly two clip masks');
  assert.strictEqual(clips.seedBase, 1629723539, 'clip seedBase must reproduce the verified probe seed');
  assert.deepStrictEqual(clips.clipBand, { x0: 581, y0: 116, x1: 613, y1: 160 }, 'clip heuristic band must exclude the flower');
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

test('opLooksDone is source-relative: mole add darkens, mole remove lightens, clips add red', () => {
  // build tiny real PNG buffers with a known dark spot / red spot
  const zlib: typeof import('zlib') = require('zlib');
  function pngWith(cells: { kind: string; x: number; y: number; r: number; }[]) {
    const w = 64, h = 64;
    const raw = Buffer.alloc((1 + w * 3) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (1 + w * 3)] = 0;
      for (let x = 0; x < w; x++) {
        let c = [240, 240, 240];
        for (const cell of cells) {
          if (cell.kind === 'dark' && Math.abs(x - cell.x) <= cell.r && Math.abs(y - cell.y) <= cell.r) c = [60, 40, 30];
          if (cell.kind === 'red' && Math.abs(x - cell.x) <= cell.r && Math.abs(y - cell.y) <= cell.r) c = [220, 30, 30];
        }
        raw[y * (1 + w * 3) + 1 + x * 3] = c[0];
        raw[y * (1 + w * 3) + 2 + x * 3] = c[1];
        raw[y * (1 + w * 3) + 3 + x * 3] = c[2];
      }
    }
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    function chunk(type: WithImplicitCoercion<string>, data: any) {
      const name = Buffer.from(type, 'ascii');
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      let crc = 0xffffffff;
      for (const buf of [name, data]) for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
      crc = (crc ^ 0xffffffff) >>> 0;
      const cb = Buffer.alloc(4); cb.writeUInt32BE(crc);
      return Buffer.concat([len, name, data, cb]);
    }
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
  const addOp = { kind: 'add', id: 'add-mole', mask: [{ kind: 'ellipse', cx: 20, cy: 20, rx: 5, ry: 5 }] };
  const plainSrc = pngWith([]);
  const moleOut = pngWith([{ kind: 'dark', x: 20, y: 20, r: 4 }]);
  assert.strictEqual(inpaint.opLooksDone(addOp, moleOut, plainSrc), true, 'mole added must pass');
  assert.strictEqual(inpaint.opLooksDone(addOp, plainSrc, plainSrc), false, 'no change must fail');

  const removeOp = { kind: 'remove', id: 'remove-wrong-mole', mask: [{ kind: 'ellipse', cx: 20, cy: 20, rx: 5, ry: 5 }] };
  const moleSrc = pngWith([{ kind: 'dark', x: 20, y: 20, r: 4 }]);
  const cleanOut = pngWith([]);
  assert.strictEqual(inpaint.opLooksDone(removeOp, cleanOut, moleSrc), true, 'mole removed must pass');
  assert.strictEqual(inpaint.opLooksDone(removeOp, moleSrc, moleSrc), false, 'mole still present must fail');

  const clipOp = { id: 'add-hairclips', kind: 'add', mask: [
    { kind: 'ellipse', cx: 20, cy: 20, rx: 5, ry: 5 },
    { kind: 'ellipse', cx: 42, cy: 20, rx: 5, ry: 5 },
  ] };
  // derived band = (3,6)-(59,34). Two 5px-radius red blobs at (20,20)/(42,20) give ~150 red.
  const clipOut = pngWith([{ kind: 'red', x: 20, y: 20, r: 4 }, { kind: 'red', x: 42, y: 20, r: 4 }]);
  assert.strictEqual(inpaint.opLooksDone(clipOp, clipOut, plainSrc), true, 'two red clips added must pass');
  const oneClip = pngWith([{ kind: 'red', x: 20, y: 20, r: 2 }]);
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

test('sourceRecordFor + validateSourceRecord: hash, status, dimensions gate', () => {
  const manifest = [
    { recordId: 'latest-lora:natsume:sd:fullbody@attempt-4', status: 'succeeded', actualWidth: W, actualHeight: H, image: 'a.png', sha256: '' },
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-inpaint-test-'));
  try {
    const buffer = makePng(W, H);
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

test('shouldReuse: resume semantics honour --force and hash/size gates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-inpaint-test-'));
  try {
    const image = path.join(root, 'ok.png');
    fs.writeFileSync(image, makePng(W, H));
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

test('imageInfo/sha256 helpers: PNG magic + dimensions, sha consistency', () => {
  const png = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 4, 0, 0, 0, 5, 32, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const info = inpaint.imageInfo(png);
  assert.deepStrictEqual({ mime: info!.mime, width: info!.width, height: info!.height }, { mime: 'image/png', width: 1024, height: 1312 });
  assert.strictEqual(inpaint.imageInfo(Buffer.from([0, 1, 2, 3])), null);
  const a = Buffer.from('hello');
  const b = Buffer.from('hello');
  assert.strictEqual(inpaint.sha256(a), inpaint.sha256(b));
});
