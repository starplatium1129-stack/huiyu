#!/usr/bin/env node
'use strict';

/**
 * 纯只读源码文件规模巡检：统计核心目录中超过阈值的源码文件，不阻断开发。
 * 用法：npm run wf -- audit:file-size [--limit 500] [--json]
 */

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const TARGET_DIRS = [
  'src',
  'runtime-rs/src',
  'desktop-tauri/src-tauri/src',
  'desktop-tauri/native-live2d/src',
];
const EXT_RE = /\.(?:ts|vue|rs|css)$/;

function walk(dir: string, out: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile() && EXT_RE.test(ent.name)) out.push(full);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法: npm run wf -- audit:file-size [--limit 500] [--json]');
    return;
  }
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 500;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('--limit 必须是正整数');
  const asJson = args.includes('--json');

  const files: string[] = [];
  for (const dir of TARGET_DIRS) walk(path.join(ROOT, dir), files);

  const over: Array<{ lines: number; path: string }> = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).length;
    if (lines > limit) {
      over.push({ lines, path: path.relative(ROOT, file).replaceAll('\\', '/') });
    }
  }
  over.sort((a, b) => b.lines - a.lines);

  if (asJson) {
    console.log(JSON.stringify({ limit, scanned: files.length, overCount: over.length, over }, null, 2));
    return;
  }

  console.log(`[audit:file-size] 扫描 ${files.length} 个核心源码文件（阈值 ${limit} 行），超限 ${over.length} 个`);
  for (const item of over) {
    console.log(`  ${String(item.lines).padStart(5)}  ${item.path}`);
  }
}

if (require.main === module) main();
