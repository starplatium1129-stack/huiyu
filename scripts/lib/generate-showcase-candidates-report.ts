'use strict';

// generate-showcase-candidates: review manifest and contact-sheet rendering.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const {
  MANIFEST_NAME, readJson, REVIEW_INDEX_NAME, CONTACT_SHEET_NAME,
}: typeof import('./generate-showcase-candidates-settings.js') = require('./generate-showcase-candidates-settings.js');
const { imageInfo, writeJsonAtomic }: typeof import('./generate-showcase-candidates-support.js') = require('./generate-showcase-candidates-support.js');

// ── mechanical verification + review index ─────────────────────────────────

function verifyOutput(output: any) {
  const manifestPath = path.join(output, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) throw new Error('no manifest to verify');
  const manifest = readJson(manifestPath);
  const entries: any[] = [];
  let checked = 0;
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
    };
    if (record.status !== 'succeeded') { entries.push(entry); continue; }
    checked += 1;
    const file = path.join(output, record.image.split('/').join(path.sep));
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
  // Mark attempt-1 entries superseded when a later attempt succeeded.
  const superseding = new Map(entries.filter((entry: any) => entry.attempt > 1).map((entry: any) => [entry.key, entry.recordId]));
  entries.forEach((entry: any) => {
    if (entry.attempt === 1 && superseding.has(entry.key)) entry.supersededBy = superseding.get(entry.key);
  });
  const reviewIndex = {
    generatedAt: new Date().toISOString(),
    outputDir: output,
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
  writeJsonAtomic(path.join(output, REVIEW_INDEX_NAME), reviewIndex);
  writeContactSheet(output, reviewIndex);
  return { checked, total: manifest.length, pass: reviewIndex.totals.mechanicalPass };
}

function escapeHtml(value: any) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function writeContactSheet(output: any, reviewIndex: any) {
  const rows = reviewIndex.entries.map((entry: any) => {
    const attemptBadge = entry.attempt > 3
      ? `<span class="attempt4">attempt-4 · 右眼痣修正重出</span>`
      : entry.attempt > 2
        ? `<span class="attempt3">attempt-3 · 复核重出</span>`
        : entry.attempt > 1
          ? `<span class="attempt2">attempt-2 · 复核覆盖</span>`
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
    const promptBlock = entry.prompt
      ? `<details><summary>Prompt</summary><pre>${escapeHtml(entry.prompt)}</pre><pre class="neg">${escapeHtml(entry.negative || '')}</pre></details>`
      : '';
    const errorBlock = entry.error ? `<div class="error">${escapeHtml(entry.error)}</div>` : '';
    return `<section class="card" data-batch="${escapeHtml(entry.batch)}" data-status="${escapeHtml(entry.status)}" data-attempt="${entry.attempt}">
      ${image}${badge}${attemptBadge}${reasonBlock}${meta}${promptBlock}${errorBlock}
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
.attempt2{color:#ffc66d;font-size:12px;font-weight:700}.attempt3{color:#ff8fa3;font-size:12px;font-weight:700}.attempt4{color:#7fd0ff;font-size:12px;font-weight:700}.attempt1{color:#8b86a0;font-size:12px}
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
  writeJsonAtomic2(path.join(output, CONTACT_SHEET_NAME), html);
}

function writeJsonAtomic2(file: any, content: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

export = { verifyOutput };
