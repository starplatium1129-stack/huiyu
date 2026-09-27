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
const {
  sourceRecordFor, validateSourceRecord, outputImageRel, attemptFiveRecordId, shouldReuse,
  DENOISE_CONFIGS, writeJsonAtomic, imageInfo, SOURCE_WIDTH, SOURCE_HEIGHT, sha256, argument,
  DEFAULT_OUTPUT, MANIFEST_NAME, assertNotShowcase, splitList, KEYS, INPAINT_CONFIG, readJson,
  isRecord, escapeHtml, ROOT, AI_ROOT, REVIEW_INDEX_NAME, CONTACT_SHEET_NAME, UPSCALE, CROP_SIZE,
  POLL_INTERVAL_MS, JOB_TIMEOUT_MS,
}: typeof import('../lib/inpaint-showcase-candidates-records.js') = require('../lib/inpaint-showcase-candidates-records.js');
const {
  uploadImage, resolveUploadName, buildOpWorkflow, submitAndWait, fetchOutputImage, comfyJson,
}: typeof import('../lib/inpaint-showcase-candidates-comfy.js') = require('../lib/inpaint-showcase-candidates-comfy.js');
const {
  generateMask, opLooksDone, setPython, generatePreviews, buildMaskArgs,
}: typeof import('../lib/inpaint-showcase-candidates-image.js') = require('../lib/inpaint-showcase-candidates-image.js');
const { buildAttemptFiveRecord, verifyAndIndex }: typeof import('../lib/inpaint-showcase-candidates-report.js') = require('../lib/inpaint-showcase-candidates-report.js');

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
