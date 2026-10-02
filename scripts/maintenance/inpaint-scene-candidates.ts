#!/usr/bin/env node
import { writeJsonAtomic } from '../lib/atomic-files';
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
const {
  attemptFor, attemptRecordId, outputImageRel, sha256, SCENE_INPAINT_CONFIG, sourceRecordFor,
  validateSourceRecord, shouldReuse, DENOISE_CONFIGS, imageInfo, argument,
  DEFAULT_OUTPUT, MANIFEST_NAME, assertNotShowcase, splitList, KEYS, readJson, ATTEMPT, ROOT, AI_ROOT,
  SCENE_SHOWCASE_DIR, MASKGEN, UPSCALE, POLL_INTERVAL_MS, JOB_TIMEOUT_MS,
}: typeof import('../lib/inpaint-scene-candidates-records.js') = require('../lib/inpaint-scene-candidates-records.js');
const { buildOpWorkflow }: typeof import('../lib/inpaint-scene-candidates-comfy.js') = require('../lib/inpaint-scene-candidates-comfy.js');
const {
  uploadImage, resolveUploadName, submitAndWait, fetchOutputImage, comfyJson,
}: typeof import('../lib/inpaint-comfy-client.js') = require('../lib/inpaint-comfy-client.js');
const {
  generateMask, opLooksDone, setPython, generatePreviews, buildMaskArgs, maskCoreDelta,
}: typeof import('../lib/inpaint-scene-candidates-image.js') = require('../lib/inpaint-scene-candidates-image.js');

// ── manifest record ─────────────────────────────────────────────────────────

function buildAttemptRecord(key: any, sourceRecord: any, config: any, results: any, workflowFiles: any) {
  const finalOutput = results[results.length - 1];
  const inpaint = {
    sourceRecordId: sourceRecord.recordId,
    engine: config.engine,
    workflowFiles,
    operations: results.map((result: any) => ({
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
    postprocess: { kind: 'inpaint', ...inpaint },
    inpaint,
  });
  delete record.infotexts;
  delete record.image_extra;
  return record;
}

// ── runner ──────────────────────────────────────────────────────────────────

async function runKey(key: any, manifest: any, outputDir: any, comfyBase: any, force: any) {
  const config = SCENE_INPAINT_CONFIG[key];
  const sourceRecord = sourceRecordFor(manifest, key);
  const validated = validateSourceRecord(key, sourceRecord, outputDir);
  const outImageRel = outputImageRel(key);
  const outImageFile = path.join(outputDir, outImageRel.split('/').join(path.sep));
  const recordId = attemptRecordId(key);
  const existing = manifest.find((record: any) => record.recordId === recordId);
  if (shouldReuse(key, existing, outImageFile, force)) {
    console.log(`[reuse] ${key} -> ${outImageRel} (${existing.sha256})`);
    return { key, status: 'reused', record: existing };
  }

  const workflowDir = path.join(outputDir, 'workflows', 'scene', key.replace(/[:\/\\]/g, '_'));
  fs.mkdirSync(workflowDir, { recursive: true });

  const results: any[] = [];
  const workflowFiles: any[] = [];
  let currentBuffer = validated.buffer;
  const runId = `${Date.now()}-${process.pid}`;

  for (let index = 0; index < config.ops.length; index += 1) {
    const op = config.ops[index];
    const stageBuffer = currentBuffer;
    let done = false;
    const denoiseConfigs = op.denoiseOrder
      ? op.denoiseOrder.map((id: any) => DENOISE_CONFIGS.find((item: any) => item.id === id)).filter(Boolean)
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
      const sampleNode: any = Object.keys(workflow).find((id: any) => workflow[id].class_type === 'KSampler');
      workflow[sampleNode].inputs.seed = seed;
      const workflowFile = path.join(workflowDir, `${op.id}_${denoiseConfig.id}.json`);
      writeJsonAtomic(workflowFile, workflow);
      workflowFiles.push(workflowFile.replace(/\\/g, '/'));
      console.log(`[${key}] op ${op.id} config ${denoiseConfig.id} submit...`);

      let outputBuffer;
      let promptId = `${key.replace(/[:\/\\]/g, '_')}-${op.id}-${denoiseConfig.id}`;
      try {
        const promptResult = await submitAndWait(comfyBase, workflow, `aics-scene-inpaint-${process.pid}`, JOB_TIMEOUT_MS, POLL_INTERVAL_MS);
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

  const plan: any[] = [];
  const previews: any[] = [];
  for (const key of keys) {
    const source = sourceRecordFor(manifest, key);
    const validated = validateSourceRecord(key, source, outputDir);
    previews.push(...generatePreviews(outputDir, key, validated.file));
    plan.push({ key, recordId: attemptRecordId(key), source: source ? source.recordId : '', ops: SCENE_INPAINT_CONFIG[key].ops.map((op: any) => op.id) });
  }

  if (dryRun) {
    console.log(JSON.stringify({ manifest: manifestPath, output: outputDir, comfy: comfyBase, plan, previews }, null, 2));
    return;
  }

  const stats = await comfyJson(comfyBase, 'GET', '/system_stats', null, 5000);
  if (stats.status < 200 || stats.status >= 300) {
    throw new Error(`ComfyUI not reachable at ${comfyBase} (HTTP ${stats.status})`);
  }

  const outcomes: any[] = [];
  for (const key of keys) {
    outcomes.push(await runKey(key, manifest, outputDir, comfyBase, force));
  }

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
    .sort((a: any, b: any) => (a.recordId || a.key || '').localeCompare(b.recordId || b.key || ''));
  writeJsonAtomic(manifestPath, normalized);

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
  }, null, 2));
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

export = {
  SCENE_INPAINT_CONFIG, KEYS, DENOISE_CONFIGS, ATTEMPT,
  argument, splitList, readJson, imageInfo, sha256, assertNotShowcase,
  sourceRecordFor, validateSourceRecord, attemptRecordId, outputImageRel, shouldReuse,
  buildOpWorkflow, buildMaskArgs, generateMask, maskCoreDelta, opLooksDone,
  buildAttemptRecord, resolveUploadName,
  constants: {
    ROOT, AI_ROOT, DEFAULT_OUTPUT, MANIFEST_NAME, SCENE_SHOWCASE_DIR,
    MASKGEN, UPSCALE, POLL_INTERVAL_MS, JOB_TIMEOUT_MS,
  },
};
