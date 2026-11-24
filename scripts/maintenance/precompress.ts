'use strict';

/**
 * scripts/maintenance/precompress.js
 *
 * 构建后预压 dist/ 与 data/ 里的文本资源为 .br / .gz。
 *
 * 为什么不用 compression 中间件就够：那是每个请求现场压一次（CPU 反复做同样的功），
 * 而且只有 gzip。实测 scenes.json gzip 229.7KB → brotli 155.2KB（−32%）。
 * 预压之后服务端只需按 Accept-Encoding 挑一个已存在的文件发出去。
 *
 * 2026-09-05 审计 P2-06：预压中间件按文件名直发，源文件删除/缩小后残留的
 * .br/.gz 会把陈旧内容发给浏览器——常规预压只遍历仍存在的源文件，压不掉孤儿。
 * 现在正常模式成对清理孤儿/陈旧产物；--check 校验存在性 + 解压内容与源一致。
 *
 * 用法: node scripts/maintenance/precompress.js [--check | --fast] [--data-only]
 * 由 npm run build:web:run 在 Vite 构建和包体校验后执行。
 */

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const zlib: typeof import('zlib') = require('zlib');
const { promisify }: typeof import('util') = require('util');
import { COMPRESSIBLE, MIN_BYTES, compressAsync } from '../lib/precompressed-artifacts';

const brotliDecompress = promisify(zlib.brotliDecompress);
const gunzip = promisify(zlib.gunzip);

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET_DIRS = ['dist', 'data'];

function walk(dir: string, skipDir?: string): string[] {
  if (dir === skipDir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, skipDir);
    return entry.isFile() ? [full] : [];
  });
}

/**
 * 构建产物里剔除 .woff 字体（2026-08-29 产品运营审计 P1）：
 * @fontsource 的 CSS 同时登记 woff2 与 woff 两种格式且 woff2 在前，
 * WebView2/Chromium 与一切 2012 后的浏览器只取 woff2，woff 是纯冗余磁盘占用
 * （实测 304 个 / 8.9MB）。vite 对两种格式的内容哈希不同名，无法按名配对，
 * 所以先把产物 CSS 里的 woff url() 源剥掉，再删除所选前端产物下全部 .woff。
 */
export function purgeWoffFonts(root = ROOT, outputDirectory = 'dist') {
  let cssRewritten = 0;
  let removed = 0;
  let bytes = 0;
  // 1) 产物 CSS 去掉 woff 源：`,url(x.woff) format("woff")`（woff2 恒在前）
  for (const file of walk(path.join(root, outputDirectory))) {
    if (!/\.css$/i.test(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (!/\.woff\)/.test(src)) continue;
    const next = src
      .replace(/,?url\([^)]*\.woff\)\s*format\("woff"\)/g, '')
      .replace(/,?url\([^)]*\.woff\)\s*format\('woff'\)/g, '');
    if (next !== src) {
      fs.writeFileSync(file, next);
      cssRewritten++;
    }
  }
  // 2) 删除前端产物下全部 .woff（woff2 保留）
  for (const file of walk(path.join(root, outputDirectory))) {
    if (!/\.woff$/i.test(file)) continue;
    bytes += fs.statSync(file).size;
    fs.unlinkSync(file);
    removed++;
  }
  if (removed || cssRewritten) {
    console.log(`Purged ${removed} redundant .woff files (${(bytes / 1024 / 1024).toFixed(1)} MB)，重写 ${cssRewritten} 个 CSS——浏览器只取 woff2`);
  }
}

/** 单次读取源文件并并行解压校验 .br/.gz，存在但内容陈旧同样算失效。 */
async function checkFileArtifacts(root: string, file: string): Promise<string[]> {
  const issues: string[] = [];
  const hasBr = fs.existsSync(file + '.br');
  const hasGz = fs.existsSync(file + '.gz');
  if (!hasBr) issues.push(path.relative(root, file));
  if (!hasBr && !hasGz) return issues;
  let raw: Buffer;
  try {
    raw = await fs.promises.readFile(file);
  } catch {
    if (hasBr) issues.push(path.relative(root, file + '.br') + ' (内容与源不一致)');
    if (hasGz) issues.push(path.relative(root, file + '.gz') + ' (内容与源不一致)');
    return issues;
  }
  const options = { maxOutputLength: raw.length };
  const checks = await Promise.all((['.br', '.gz'] as const).map(async ext => {
    const exists = ext === '.br' ? hasBr : hasGz;
    if (!exists) return null;
    const artifact = file + ext;
    try {
      const compressed = await fs.promises.readFile(artifact);
      const data = ext === '.gz'
        ? await gunzip(compressed, options)
        : await brotliDecompress(compressed, options);
      return raw.equals(data) ? null : path.relative(root, artifact) + ' (内容与源不一致)';
    } catch {
      return path.relative(root, artifact) + ' (内容与源不一致)';
    }
  }));
  for (const issue of checks) if (issue) issues.push(issue);
  return issues;
}

/**
 * 孤儿/陈旧预压产物清单：源已删除、低于压缩阈值或不再属于可压类型的 .br/.gz。
 * 只扫 TARGET_DIRS，不越界（审计 2026-09-05 P2-06）。
 */
function listStaleArtifacts(root: string, targetDirs: string[]) {
  const stale: string[] = [];
  const catalog = path.join(root, 'data', 'catalog') + path.sep;
  for (const dir of targetDirs) {
    for (const file of walk(path.join(root, dir))) {
      if (!/\.(?:br|gz)$/i.test(file)) continue;
      const source = file.replace(/\.(?:br|gz)$/i, '');
      // SQLite is seeded from raw catalog JSON. The gateway never serves these sidecars.
      if (file.startsWith(catalog) && source.endsWith('.json')) { stale.push(file); continue; }
      if (!fs.existsSync(source)) { stale.push(file); continue; }
      if (!COMPRESSIBLE.test(source) || fs.statSync(source).size < MIN_BYTES) stale.push(file);
    }
  }
  return stale;
}

async function main(root = ROOT, argv = process.argv.slice(2)) {
  const checkOnly = argv.includes('--check');
  const fast = !checkOnly && (argv.includes('--fast') || process.env.AICS_PRECOMPRESS_FAST === '1');
  const maxJobs = fast ? 8 : 4;
  const configured = process.env.PRECOMPRESS_JOBS ?? String(fast ? Math.min(maxJobs, os.availableParallelism()) : 2);
  const jobs = Number(configured);
  if (!checkOnly && (!/^[1-8]$/.test(configured) || jobs > maxJobs)) {
    throw Error('PRECOMPRESS_JOBS must be an integer from 1 to ' + maxJobs);
  }
  const dataOnly = argv.includes('--data-only');
  const targetDirs = dataOnly ? ['data'] : TARGET_DIRS;
  if (!checkOnly && !dataOnly) purgeWoffFonts(root);
  let files = 0;
  let reused = 0;
  let rawTotal = 0;
  let brTotal = 0;
  let gzTotal = 0;
  const missing: string[] = [];
  const pending: string[] = [];

  if (!checkOnly) {
    const stale = listStaleArtifacts(root, targetDirs);
    if (fast) {
      // Quality-4 Brotli must never be paired with old gzip and mistaken for
      // reusable release output. Release mode recreates both sidecars.
      const knownStale = new Set(stale);
      for (const dir of targetDirs) {
        for (const file of walk(path.join(root, dir))) {
          if (/\.gz$/i.test(file) && COMPRESSIBLE.test(file.slice(0, -3)) && !knownStale.has(file)) stale.push(file);
        }
      }
    }
    for (const file of stale) fs.unlinkSync(file);
    if (stale.length) {
      console.log(`Pruned ${stale.length} unused precompress artifacts`);
    }
  }

  for (const dir of targetDirs) {
    for (const file of walk(path.join(root, dir), path.join(root, 'data', 'catalog'))) {
      if (!COMPRESSIBLE.test(file)) continue;
      if (/\.(?:br|gz)$/i.test(file)) continue;
      if (fs.statSync(file).size < MIN_BYTES) continue;
      pending.push(file);
    }
  }

  if (checkOnly) {
    // check 模式三类失效全部拦截：源缺 .br、产物内容陈旧、孤儿产物（源已删除/低于阈值）
    const checkJobs = Math.min(4, Math.max(2, os.cpus().length), pending.length || 1);
    const perFile: string[][] = new Array(pending.length);
    let checkCursor = 0;
    await Promise.all(Array.from({ length: checkJobs }, async () => {
      while (checkCursor < pending.length) {
        const index = checkCursor++;
        perFile[index] = await checkFileArtifacts(root, pending[index]);
      }
    }));
    for (const issues of perFile) if (issues) missing.push(...issues);
    const stale = listStaleArtifacts(root, targetDirs);
    if (missing.length || stale.length) {
      if (missing.length) {
        console.error('预压产物缺失或内容陈旧（跑 npm run precompress 重建并清理孤儿）:');
        missing.slice(0, 10).forEach(f => console.error('  - ' + f));
      }
      if (stale.length) {
        console.error('孤儿/陈旧预压产物（源已删除或低于阈值，跑 npm run precompress 清理）:');
        stale.slice(0, 10).forEach(f => console.error('  - ' + path.relative(root, f)));
      }
      return 1;
    }
    console.log('预压产物完整。');
    return 0;
  }

  let cursor = 0, failed = false;
  async function worker() {
    while (cursor < pending.length && !failed) {
      try {
        const result = await compressAsync(pending[cursor++], fast);
        if (!result) continue;
        if (result.reused) reused++;
        files++; rawTotal += result.raw; brTotal += result.brotli; gzTotal += result.gzip;
      } catch (error) { failed = true; throw error; }
    }
  }
  // Await active writes even on failure; no background mutation after the CLI returns.
  const completed = await Promise.allSettled(Array.from({ length: Math.min(jobs, pending.length) }, worker));
  for (const result of completed) if (result.status === 'rejected') throw result.reason;

  const kb = (n: number) => (n / 1024).toFixed(1) + ' KB';
  const encoding = fast ? kb(brTotal) + ' brotli (desktop-local)' :
    kb(gzTotal) + ' gzip → ' + kb(brTotal) + ' brotli';
  console.log('Precompressed ' + files + ' files: ' + kb(rawTotal) + ' raw → ' + encoding);
  console.log(`Precompression reused ${reused} verified artifacts; encoded ${files - reused} files.`);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
}
