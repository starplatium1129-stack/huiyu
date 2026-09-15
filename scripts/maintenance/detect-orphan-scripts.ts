#!/usr/bin/env node
'use strict';

/**
 * 孤儿维护脚本探测器（2026-08-31 七维审计 P2「16 孤儿脚本归档」前置检测）。
 *
 * 判定：scripts/maintenance/ 下某脚本若其 basename 在全库（排除 archive /
 * node_modules / 自身 / 各类构建产物与运行时目录）零引用，则视为孤儿候选。
 *
 * 用法：
 *   node scripts/maintenance/detect-orphan-scripts.js            # 列孤儿候选
 *   node scripts/maintenance/detect-orphan-scripts.js --json     # 机器可读
 *   node scripts/maintenance/detect-orphan-scripts.js --check    # 有候选则失败
 *
 * 注意：本脚本只读，不移动/不删除任何文件。归档须人工复核后单独执行
 * （git mv 到 scripts/archive/，该目录已 .gitignore）。
 *
 * 局限：basename 子串匹配可能误判——同名前缀（如 build-scenes.js 与
 * build-scenes-extra.js）会互相命中。本探测额外做「整名」精确比对兜底：
 * 仅当 basename 作为独立 token（被 / " ' = 空格 等分隔）出现才算引用。
 */

const fs = (require('fs') as typeof import('fs'));
const path = (require('path') as typeof import('path'));

const ROOT = path.resolve(__dirname, '..', '..');
const MAINT = path.join(ROOT, 'scripts', 'maintenance');

// 扫描语料时跳过这些目录（构建产物 / 运行时 / 依赖 / 归档区本身）
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'runtime', 'test-results', 'coverage',
  'archive', '.workbuddy', '.npm-cache', '.review-shots', '__pycache__',
  'target', 'gen', 'resources', 'binaries', 'web', // desktop-tauri 子产物
]);

// 只扫这些根级子树 + 根级配置文件（覆盖所有可能引用维护脚本的地方）
const SCAN_ROOTS = ['scripts', 'src', 'routes', 'server', 'docs', 'tests', '.github', 'desktop-tauri', 'poc', 'tools', 'services', 'css', 'plans'];
const SCAN_ROOT_FILES = new Set(['package.json', 'package-lock.json', 'server.ts', 'eslint.config.mts', 'start.ps1', 'deploy-desktop.bat', 'control.bat', 'README.md', 'README_zh.md', 'AGENTS.md', 'DESIGN.md', 'STARTUP.md']);

function isGenerated(file: string): boolean {
  const source = file.replace(/\.d\.ts$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts').replace(/\.js$/, '.ts');
  return source !== file && fs.existsSync(source);
}

function walk(dir: string, out: string[]) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(path.join(dir, ent.name), out);
    } else if (ent.isFile() && !isGenerated(path.join(dir, ent.name))) {
      out.push(path.join(dir, ent.name));
    }
  }
}

function collectCorpus() {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    walk(path.join(ROOT, root), files);
  }
  // 根级单文件
  for (const f of SCAN_ROOT_FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) files.push(p);
  }
  return files;
}

function readText(file: string) {
  // 跳过大文件（lock 文件等），避免无意义开销
  try {
    const st = fs.statSync(file);
    if (st.size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

// 引用判定：basename 需作为独立 token 出现（前后为非路径/标识符字符），
// 避免前缀误命中（build-scenes.js vs build-scenes-v2.js）。
function isReferenced(content: string, basename: string) {
  let idx = 0;
  while ((idx = content.indexOf(basename, idx)) !== -1) {
    const before = idx > 0 ? content[idx - 1] : '/';
    const after = content[idx + basename.length] ?? '/';
    const isTokenBoundary = (ch: string) => ch === '/' || ch === '"' || ch === "'" || ch === '`' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '=' || ch === ',' || ch === ';' || ch === '(' || ch === ')' || ch === '|';
    if (isTokenBoundary(before) && isTokenBoundary(after)) return true;
    idx += basename.length;
  }
  return false;
}

function main() {
  const asJson = process.argv.includes('--json');
  const scripts = fs.readdirSync(MAINT, { withFileTypes: true })
    .filter((ent: any) => ent.isFile() && /\.(?:[cm]?[jt]s|ps1|py)$/.test(ent.name) && !isGenerated(path.join(MAINT, ent.name)))
    .map((ent: any) => ent.name)
    .sort();

  const corpusFiles = collectCorpus();
  // 预读语料，缓存 {path: content}
  const corpus: any[] = [];
  for (const f of corpusFiles) {
    // 跳过 maintenance/ 自身目录下的文件（它们互相引用算有效，但自引用不算）
    const c = readText(f);
    if (c != null) corpus.push({ path: f, content: c });
  }

  const orphans: any[] = [];
  const referenced: any[] = [];
  for (const name of scripts) {
    const self = path.join(MAINT, name);
    let found = false;
    let refs: any[] = [];
    // 2026-09-05 审计 P3：Node 的 require 支持 ./desktop-build-lock 这类无扩展名
    // 导入，仅按完整 basename 匹配会把真实引用误报为孤儿（desktop-build-lock.js、
    // runtime-generated-files.js 即此类误报）。补一条"无扩展名 stem"token 匹配：
    // '-' 等连接符不在边界集内，仍不会把 build-scenes 误命中到 build-scenes-v2.js。
    const stem = name.replace(/\.(?:[cm]?[jt]s|ps1|py)$/i, '');
    const runtimeName = name.replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs').replace(/\.ts$/, '.js');
    for (const entry of corpus) {
      // 跳过自身文件
      if (entry.path === self) continue;
      if (isReferenced(entry.content, name) || isReferenced(entry.content, runtimeName) || isReferenced(entry.content, stem)) {
        found = true;
        refs.push(path.relative(ROOT, entry.path));
        // 只记前 3 个引用出处，足够判断非孤儿
        if (refs.length >= 3) break;
      }
    }
    if (found) referenced.push({ name, refs });
    else orphans.push({ name });
  }

  if (asJson) {
    console.log(JSON.stringify({ orphanCount: orphans.length, orphans, referencedCount: referenced.length, total: scripts.length }, null, 2));
    if (process.argv.includes('--check') && orphans.length) process.exitCode = 1;
    return;
  }

  console.log(`[detect-orphan-scripts] 扫描 ${scripts.length} 个 maintenance 脚本，语料 ${corpus.length} 文件`);
  console.log(`孤儿候选（零引用）：${orphans.length} 个`);
  if (orphans.length) {
    for (const o of orphans) console.log(`  - ${o.name}`);
  }
  console.log(`\n被引用：${referenced.length} 个（抽样前 3 出处）`);
  // 仅打印孤儿详情 + 已引用计数；已引用清单太长默认不展开
  console.log(`\n孤儿归档前请人工复核：确认无手动用途后 git mv <file> scripts/archive/（已 .gitignore）`);
  if (process.argv.includes('--check') && orphans.length) process.exitCode = 1;
}

main();
