#!/usr/bin/env node
'use strict';

import { PathOrFileDescriptor } from 'node:fs';

/**
 * 单场景高质量修复工具：
 * - sc300 同构短 prompt，生成前强制结构健康检查
 * - 固定 3 seed；三张经五维人工评分后全部 >= 90 才算合格
 * - 宁宁默认 V21（unified e16），绑定 character=nene
 * - 手工修复必须显式传 --steps 30 --cfg 4.5
 *
 * 生成：
 * node scripts/maintenance/scene-fix.js --scene sc001 --prompt "<tags>" \
 *   --steps 30 --cfg 4.5
 *
 * 只校验：
 * node scripts/maintenance/scene-fix.js --scene sc001 --prompt "<tags>" \
 *   --steps 30 --cfg 4.5 --dry-run
 *
 * 填完 review.json 后复核：
 * node scripts/maintenance/scene-fix.js --scene sc001 --review-only
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const generationContract: typeof import('../../server/anima-generation-contract.js') = require('../../server/anima-generation-contract.js');
const promptContract: typeof import('./quality-prompt-contract.js') = require('./quality-prompt-contract.js');

const DEFAULT_GATEWAY = 'http://127.0.0.1:3000';
const DEFAULT_OUTPUT_ROOT = 'E:/code/2/lora/AI/Reviews/SceneFix';
const NEGATIVE = 'worst quality, low quality, blurry, jpeg artifacts, watermark, text, extra fingers, mutated hands, bad anatomy, split image, multiple panels, comic strip, second person, multiple girls';
const SEED_BASE = 20260809;
const SEED_STEP = 997;
const SEED_COUNT = 3;

const REPAIR_MODELS: any = Object.freeze({
  nene: Object.freeze({
    loraId: 'L_NENE_V21_ANIMA',
    loraStrength: 0.85,
    modelId: 'anima-aesthetic-v1.1',
  }),
  natsume: Object.freeze({
    loraId: 'L_NAT_V21_ANIMA',
    loraStrength: 0.85,
    modelId: 'anima-aesthetic-v1.1',
  }),
});

function argument(name: string, fallback: any = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJson(file: PathOrFileDescriptor) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file: PathLike, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function loadSceneIndex() {
  const scenes = new Map();
  for (const file of ['data/scenes-nene.json', 'data/scenes-natsume.json']) {
    const data = readJson(file);
    const list = Array.isArray(data) ? data : (data.scenes || []);
    const character = file.includes('nene') ? 'nene' : 'natsume';
    for (const scene of list) {
      scenes.set(String(scene.id), Object.assign({}, scene, { _character: character }));
    }
  }
  return scenes;
}

function buildSeeds(extra: any = 0) {
  if (!Number.isInteger(extra) || extra < 0) throw new Error('--extra 必须是非负整数');
  return Array.from({ length: SEED_COUNT }, (_unused: any, index: any) =>
    SEED_BASE + (index + extra) * SEED_STEP);
}

function manualParameterValue(raw: string, name: string) {
  const expected = generationContract.MANUAL_REPAIR_PRESET[name];
  if (raw === '') throw new Error(`手工修复必须显式传 --${name} ${expected}`);
  const value = Number(raw);
  if (!generationContract.validateTunableNumber(value, name) || value !== expected) {
    throw new Error(`手工修复 --${name} 固定为 ${expected}`);
  }
  return value;
}

function resolveRepairConfig(sceneCharacter: string, options: any = {}) {
  const base = REPAIR_MODELS[sceneCharacter];
  if (!base) throw new Error(`不支持的场景角色：${sceneCharacter}`);
  const loraId = String(options.loraId || base.loraId);
  const requiredCharacter = generationContract.requiredCharacterForLora(loraId);
  if (!requiredCharacter) throw new Error(`不支持的 Anima LoRA：${loraId}`);
  const belongsToScene = sceneCharacter === 'nene'
    ? requiredCharacter === 'nene'
    : requiredCharacter === sceneCharacter;
  if (!belongsToScene) throw new Error(`场景角色 ${sceneCharacter} 不能使用 ${loraId}`);
  if (options.character && options.character !== requiredCharacter) {
    throw new Error(`${loraId} 必须绑定 character=${requiredCharacter}`);
  }
  const loraStrength = options.loraStrength === undefined
    ? base.loraStrength
    : Number(options.loraStrength);
  if (!Number.isFinite(loraStrength) || loraStrength < 0.65 || loraStrength > 1) {
    throw new Error('--strength 必须在 0.65-1 之间');
  }
  return {
    modelId: base.modelId,
    loraId,
    loraStrength,
    character: requiredCharacter,
  };
}

function reviewFiles(outputDir: string) {
  return {
    review: path.join(outputDir, 'review.json'),
    selection: path.join(outputDir, 'selection.json'),
  };
}

function ensureReviewTemplate(outputDir: string, seeds: number[]) {
  const files = reviewFiles(outputDir);
  if (!fs.existsSync(files.review)) {
    writeJsonAtomic(files.review, promptContract.buildSeedReview(seeds));
  }
  return files;
}

function evaluateReview(outputDir: string, seeds: number[]) {
  const files = ensureReviewTemplate(outputDir, seeds);
  const evaluation = promptContract.evaluateSeedReview(readJson(files.review), seeds);
  if (evaluation.qualified) {
    writeJsonAtomic(files.selection, Object.assign({
      selectedAt: new Date().toISOString(),
      rule: 'three seeds all >= 90; highest total wins',
    }, evaluation));
  } else if (fs.existsSync(files.selection)) {
    fs.rmSync(files.selection);
  }
  return evaluation;
}

async function submit(gateway: string, body: any) {
  const base = gateway.replace(/\/$/, '');
  const res = await fetch(base + '/api/anima/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status !== 202 || !data.ok || !data.job) return { ok: false, error: JSON.stringify(data) };
  const deadline = Date.now() + 10 * 60 * 1000;
  let job = data.job;
  while (Date.now() < deadline) {
    const poll = await fetch(`${base}/api/anima/jobs/${encodeURIComponent(job.id)}`, { cache: 'no-store' });
    const polled = await poll.json();
    if (polled.ok && polled.job) job = polled.job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      return { ok: false, error: `${job.status}: ${job.error || job.code || ''}` };
    }
    if (job.status === 'succeeded' && job.resultUrl) break;
    await new Promise<any>((resolve: any) => setTimeout(resolve, 2000));
  }
  if (job.status !== 'succeeded' || !job.resultUrl) return { ok: false, error: `timeout ${job.status}` };
  const image = await fetch(base + job.resultUrl, { cache: 'no-store' });
  if (!image.ok) return { ok: false, error: 'result fetch failed' };
  return { ok: true, buffer: Buffer.from(await image.arrayBuffer()), jobId: job.id };
}

async function main() {
  const scenes = loadSceneIndex();
  const sceneId = argument('--scene');
  if (!sceneId || !scenes.has(sceneId)) {
    throw new Error('必须传有效的 --scene，例如 --scene sc001');
  }
  const scene = scenes.get(sceneId);
  const outputRoot = path.resolve(argument('--output', DEFAULT_OUTPUT_ROOT));
  const outputDir = path.join(outputRoot, sceneId);
  const extra = Number(argument('--extra', '0'));
  const seeds = buildSeeds(extra);

  if (process.argv.includes('--review-only')) {
    const evaluation = evaluateReview(outputDir, seeds);
    console.log(JSON.stringify({ scene: sceneId, outputDir, evaluation }, null, 2));
    if (!evaluation.qualified) process.exitCode = 2;
    return;
  }

  const prompt = argument('--prompt');
  if (!prompt) throw new Error('必须传 --prompt "<tags>"');
  const steps = manualParameterValue(argument('--steps'), 'steps');
  const cfg = manualParameterValue(argument('--cfg'), 'cfg');
  const repair = resolveRepairConfig(scene._character, {
    loraId: argument('--lora'),
    loraStrength: argument('--strength') ? Number(argument('--strength')) : undefined,
    character: argument('--character'),
  });
  const health = promptContract.assertShortPrompt(prompt, {
    character: scene._character,
    rating: scene.rating,
  });
  const plan: any = {
    scene: sceneId,
    rating: scene.rating || 'ALL',
    outputDir,
    seeds,
    prompt,
    negative: NEGATIVE,
    health,
    parameters: {
      modelId: repair.modelId,
      loraId: repair.loraId,
      loraStrength: repair.loraStrength,
      character: repair.character,
      width: 832,
      height: 1216,
      steps,
      cfg,
      sampler: generationContract.MANUAL_REPAIR_PRESET.sampler,
      scheduler: generationContract.MANUAL_REPAIR_PRESET.scheduler,
    },
  };
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'prompt.txt'), `${prompt}\n`, 'utf8');
  writeJsonAtomic(path.join(outputDir, 'plan.json'), plan);
  ensureReviewTemplate(outputDir, seeds);

  const gateway = argument('--gateway', DEFAULT_GATEWAY);
  let generated = 0;
  let reused = 0;
  let failed = 0;
  for (const seed of seeds) {
    const file = path.join(outputDir, `${sceneId}_${seed}.png`);
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) {
      console.log(`[reuse] ${seed}`);
      reused += 1;
      continue;
    }
    const body = {
      prompt,
      negative: NEGATIVE,
      modelId: repair.modelId,
      loraId: repair.loraId,
      loraStrength: repair.loraStrength,
      character: repair.character,
      width: 832,
      height: 1216,
      seed,
      steps,
      cfg,
    };
    console.log(`[generate] ${sceneId} seed ${seed}`);
    const result: any = await submit(gateway, body);
    if (!result.ok) {
      console.log(`[failed] seed ${seed}: ${result.error}`);
      failed += 1;
      continue;
    }
    fs.writeFileSync(file, result.buffer);
    generated += 1;
    console.log(`[ok] ${sceneId} seed ${seed} (${result.buffer.length} bytes)`);
  }
  const evaluation = evaluateReview(outputDir, seeds);
  console.log(JSON.stringify({
    scene: sceneId,
    outputDir,
    generated,
    reused,
    failed,
    review: evaluation.complete
      ? evaluation
      : {
          complete: false,
          qualified: false,
          next: `填写 ${path.join(outputDir, 'review.json')} 后运行 --review-only`,
        },
  }, null, 2));
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

export = {
  SEED_COUNT,
  REPAIR_MODELS,
  buildSeeds,
  manualParameterValue,
  resolveRepairConfig,
  ensureReviewTemplate,
  evaluateReview,
};
