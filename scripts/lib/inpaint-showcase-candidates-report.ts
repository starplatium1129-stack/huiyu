import { writeJsonAtomic } from './atomic-files';
'use strict';

// inpaint-showcase-candidates: review manifest and contact-sheet rendering.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const {
  attemptFiveRecordId, outputImageRel, SOURCE_WIDTH, SOURCE_HEIGHT, sha256, MANIFEST_NAME, readJson,
  imageInfo, REVIEW_INDEX_NAME, escapeHtml, writeTextAtomic, CONTACT_SHEET_NAME,
}: typeof import('./inpaint-showcase-candidates-records.js') = require('./inpaint-showcase-candidates-records.js');

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
    postprocess: { kind: 'inpaint', ...inpaint },
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

export = { buildAttemptFiveRecord, verifyAndIndex };
