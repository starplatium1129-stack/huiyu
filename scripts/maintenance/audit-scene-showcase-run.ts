#!/usr/bin/env node
'use strict';

/**
 * Batch-audit every succeeded generation record with image-inspect (audit task)
 * and write structured results to audit-results.json.
 *
 * This orchestrates the established vision channel (scripts/maintenance/
 * image-inspect.js → local CLIProxyAPI gemini-3.7-flash-high). It never
 * publishes anything — it only produces the per-image audit evidence that the
 * reviewer uses to build manual-review.json.
 *
 * Usage:
 *   node scripts/maintenance/audit-scene-showcase-run.js \
 *       [--manifest <generation-manifest.json>] \
 *       [--concurrency 4] [--latest-attempt] [--ids sc001,sc002]
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { spawn }: typeof import('child_process') = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DIR = path.join(
  path.resolve(ROOT, '..', 'AI'),
  'Reviews',
  'SceneShowcaseRefresh',
  '2026-08-14_v16-anima11-rella',
);
const DEFAULT_MANIFEST = path.join(DEFAULT_DIR, 'generation-manifest.json');

function argument(name: any, fallback: any = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function splitList(value: any) {
  return String(value || '').split(',').map((item: any) => item.trim()).filter(Boolean);
}
function runInspect(imageFile: any, timeoutMs: any, prompt: any) {
  return new Promise<any>((resolve: any) => {
    const args = [path.join(ROOT, 'scripts', 'maintenance', 'image-inspect.js'), imageFile, '-t', 'audit', '--json'];
    if (prompt) args.push('-p', prompt);
    const child = spawn(
      process.execPath,
      args,
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: any) => { stdout += chunk; });
    child.stderr.on('data', (chunk: any) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ file: imageFile, ok: false, error: 'inspect timeout' });
    }, timeoutMs);
    child.on('error', (error: any) => {
      clearTimeout(timer);
      resolve({ file: imageFile, ok: false, error: error.message });
    });
    child.on('close', (code: any) => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(stdout);
        resolve({ file: imageFile, ok: true, result: Array.isArray(data) ? data[0] : data });
      } catch (error) {
        resolve({ file: imageFile, ok: false, error: `bad inspect output (${code}): ${stderr.slice(0, 300)}` });
      }
    });
  });
}

async function main() {
  const manifestPath = path.resolve(argument('--manifest', DEFAULT_MANIFEST));
  const dir = path.dirname(manifestPath);
  const concurrency = Math.max(1, Math.min(6, Number(argument('--concurrency', '4')) || 4));
  const latestOnly = process.argv.includes('--latest-attempt');
  const ids = splitList(argument('--ids'));
  const timeoutMs = Math.max(60000, Number(argument('--timeout', '240000')) || 240000);
  const auditPrompt = argument('--prompt', '');

  const records = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let selected = records.filter((record: any) => record.status === 'succeeded');
  if (latestOnly) {
    const best = new Map();
    for (const record of selected) {
      const previous = best.get(record.key);
      if (!previous || record.attempt > previous.attempt) best.set(record.key, record);
    }
    selected = [...best.values()];
  }
  if (ids.length) selected = selected.filter((record: any) => ids.includes(record.sceneId));

  const outputPath = path.join(dir, 'audit-results.json');
  const existing = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : {};
  const results = Object.assign({}, existing);

  console.log(`[audit-plan] ${selected.length} succeeded records, concurrency ${concurrency}`);
  let cursor = 0;
  async function worker() {
    while (cursor < selected.length) {
      const record = selected[cursor];
      cursor += 1;
      const imageFile = path.resolve(dir, record.image.split('/').join(path.sep));
      if (!fs.existsSync(imageFile)) {
        results[record.recordId] = { ok: false, error: 'missing image file', file: imageFile };
        fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf8');
        console.log(`[missing] ${record.recordId}`);
        continue;
      }
      if (results[record.recordId] && results[record.recordId].ok === true && !process.argv.includes('--force')) {
        console.log(`[reuse] ${record.recordId}`);
        continue;
      }
      console.log(`[audit] ${record.recordId} ${imageFile}`);
      const outcome = await runInspect(imageFile, timeoutMs, auditPrompt);
      results[record.recordId] = outcome.ok
        ? { ok: true, verdict: classify(outcome.result), summary: summarize(outcome.result), inspectedAt: new Date().toISOString() }
        : { ok: false, error: outcome.error, file: imageFile };
      fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf8');
      console.log(`[done] ${record.recordId} -> ${results[record.recordId].ok ? results[record.recordId].verdict : 'error'}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));
  console.log(JSON.stringify({ output: outputPath, audited: selected.length }, null, 2));
}

/** 轻量归类：硬伤关键词判 fail；其余 pass（复核由人终审）。 */
function classify(result: any) {
  if (!result || !result.content) return 'unknown';
  const text = String(result.content);
  if (text.includes('不通过')) return 'fail';
  if (text.includes('需复核') || text.includes('需注意')) return 'review';
  return 'pass';
}
function summarize(result: any) {
  if (!result || !result.content) return '';
  const text = String(result.content);
  const lines = text.split('\n').map((line: any) => line.trim()).filter(Boolean);
  const conclusion = lines.find((line: any) => line.includes('结论')) || '';
  const issues = lines.filter((line: any) => /^\d+[\.、]/.test(line) || line.startsWith('- ')).slice(0, 6);
  return [conclusion, ...issues].join('\n');
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

export = { classify, summarize };
