#!/usr/bin/env node
'use strict';

/**
 * 秒级手动快检入口（默认只检查 git 改动命中的域；--all 运行全量静态检查）。
 * 严禁挂入 pre-commit 自动阻塞提交，仅作手动按需自检。
 */

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { spawn }: typeof import('node:child_process') = require('node:child_process');
const { desktopBuildEnvironment }: typeof import('../lib/desktop-build-environment') = require('../lib/desktop-build-environment');

const ROOT = path.resolve(__dirname, '../..');

interface CheckTask {
  name: string;
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  output: string;
}

function parseGitChanges(): string[] {
  const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
  const res = spawnSync('git', ['status', '--porcelain=v1', '-z', '-uall'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0 || !res.stdout) return [];
  const entries = res.stdout.split('\0').filter(Boolean);
  const paths = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    if (item.length < 4) continue;
    const status = item.slice(0, 2);
    const file = item.slice(3).replaceAll('\\', '/');
    paths.add(file);
    if (status[0] === 'R' || status[0] === 'C') i++;
  }
  return [...paths];
}

function isGeneratedScriptOutput(rel: string): boolean {
  if (!/^(?:scripts|tools)\/.+\.(?:[cm]?js)$/.test(rel)) return false;
  const src = rel.replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts').replace(/\.js$/, '.ts');
  return src !== rel && fs.existsSync(path.join(ROOT, src));
}

function runTask(task: CheckTask): Promise<CheckResult> {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(task.cmd, task.args, {
      cwd: ROOT,
      env: task.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', err => {
      resolve({ name: task.name, ok: false, ms: Date.now() - started, output: err.message });
    });
    child.on('close', code => {
      resolve({
        name: task.name,
        ok: code === 0,
        ms: Date.now() - started,
        output: Buffer.concat(chunks).toString('utf8').trim(),
      });
    });
  });
}

function buildTasks(all: boolean): { tasks: CheckTask[]; scopeNote: string } {
  const node = process.execPath;
  const env = desktopBuildEnvironment(ROOT);
  const eslintBin = path.join(ROOT, 'node_modules/eslint/bin/eslint.js');
  const vueTscBin = path.join(ROOT, 'node_modules/vue-tsc/bin/vue-tsc.js');
  const tscBin = path.join(ROOT, 'node_modules/typescript/bin/tsc');

  if (all) {
    return {
      scopeNote: '全量静态检查 (--all)',
      tasks: [
        { name: 'typecheck:app', cmd: node, args: [vueTscBin, '-p', 'tsconfig.app.json', '--noEmit'] },
        { name: 'typecheck:node', cmd: node, args: [tscBin, '-p', 'tsconfig.node.json', '--noEmit'] },
        { name: 'typecheck:browser', cmd: node, args: [path.join(ROOT, 'scripts/build-node.mts'), '--project', 'browser', '--check'] },
        { name: 'lint:js', cmd: node, args: [eslintBin, '-c', 'eslint.config.mjs', 'src', 'scripts', 'tools'] },
        { name: 'lint:contrast', cmd: node, args: [path.join(ROOT, 'scripts/maintenance/check-contrast.js')] },
        { name: 'lint:animations', cmd: node, args: [path.join(ROOT, 'scripts/maintenance/lint-animations.js')] },
        { name: 'lint:colors', cmd: node, args: [path.join(ROOT, 'scripts/maintenance/lint-colors.js')] },
        { name: 'docs:check', cmd: node, args: [path.join(ROOT, 'scripts/maintenance/check-doc-links.js')] },
        { name: 'audit:workflows', cmd: node, args: [path.join(ROOT, 'scripts/workflow.js'), 'audit:workflows', '--json'] },
        { name: 'cargo:runtime-rs', cmd: 'cargo', args: ['check', '--manifest-path', 'runtime-rs/Cargo.toml'], env },
        { name: 'cargo:desktop-tauri', cmd: 'cargo', args: ['check', '--manifest-path', 'desktop-tauri/src-tauri/Cargo.toml'], env },
      ],
    };
  }

  const changed = parseGitChanges();
  if (!changed.length) {
    return { tasks: [], scopeNote: '工作区无未提交改动' };
  }

  const tasks: CheckTask[] = [];
  const srcTyped = changed.some(f => /^src\/.+\.(?:[cm]?ts|vue)$/.test(f));
  const srcStyled = changed.some(f => /^src\/.+\.(?:css|vue)$/.test(f));
  const scriptsChanged = changed.some(f => /^(?:scripts\/(?!archive\/)|eslint\.config\.mts$|tsconfig\.(?:node|browser-tools)\.json$)/.test(f));
  const browserToolsChanged = changed.some(f => /^(?:tools\/|assets\/theme-bootstrap\.ts$|docs\/guides\/prompts\/|tsconfig\.browser-tools\.json$)/.test(f));
  const docsChanged = changed.some(f => /^(?:docs\/|(?:README|README_zh|DESIGN|AGENTS|STARTUP)\.md$)/.test(f));
  const runtimeRsChanged = changed.some(f => f.startsWith('runtime-rs/'));
  const tauriChanged = changed.some(f => f.startsWith('desktop-tauri/'));
  const lintFiles = changed.filter(f =>
    /^(?:src|scripts|tools)\/.+\.(?:[cm]?[jt]s|vue)$/.test(f)
    && !f.startsWith('scripts/archive/')
    && !isGeneratedScriptOutput(f)
    && fs.existsSync(path.join(ROOT, f))
  );

  if (srcTyped) tasks.push({ name: 'typecheck:app', cmd: node, args: [vueTscBin, '-p', 'tsconfig.app.json', '--noEmit'] });
  if (lintFiles.length) tasks.push({ name: `eslint(${lintFiles.length})`, cmd: node, args: [eslintBin, '-c', 'eslint.config.mjs', ...lintFiles] });
  if (srcStyled) {
    tasks.push({ name: 'lint:contrast', cmd: node, args: [path.join(ROOT, 'scripts/maintenance/check-contrast.js')] });
    tasks.push({ name: 'lint:animations', cmd: node, args: [path.join(ROOT, 'scripts/maintenance/lint-animations.js')] });
    tasks.push({ name: 'lint:colors', cmd: node, args: [path.join(ROOT, 'scripts/maintenance/lint-colors.js')] });
  }
  if (scriptsChanged) {
    tasks.push({ name: 'typecheck:node', cmd: node, args: [tscBin, '-p', 'tsconfig.node.json', '--noEmit'] });
    tasks.push({ name: 'audit:workflows', cmd: node, args: [path.join(ROOT, 'scripts/workflow.js'), 'audit:workflows', '--json'] });
  }
  if (browserToolsChanged) {
    tasks.push({ name: 'typecheck:browser', cmd: node, args: [path.join(ROOT, 'scripts/build-node.mts'), '--project', 'browser', '--check'] });
  }
  if (docsChanged) {
    tasks.push({ name: 'docs:check', cmd: node, args: [path.join(ROOT, 'scripts/maintenance/check-doc-links.js')] });
  }
  if (runtimeRsChanged) {
    tasks.push({ name: 'cargo:runtime-rs', cmd: 'cargo', args: ['check', '--manifest-path', 'runtime-rs/Cargo.toml'], env });
  }
  if (tauriChanged) {
    tasks.push({ name: 'cargo:desktop-tauri', cmd: 'cargo', args: ['check', '--manifest-path', 'desktop-tauri/src-tauri/Cargo.toml'], env });
  }

  return { tasks, scopeNote: `按改动范围命中 ${tasks.length} 项（改动文件 ${changed.length} 个）` };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法: npm run wf -- check [--all] [--json]\n默认仅按 git 改动范围秒级并行检查；--all 运行全量静态检查（含 Rust cargo check）。');
    return;
  }
  const all = args.includes('--all');
  const asJson = args.includes('--json');
  const { tasks, scopeNote } = buildTasks(all);
  if (!tasks.length) {
    if (asJson) {
      console.log(JSON.stringify({ ok: true, scopeNote, results: [] }, null, 2));
    } else {
      console.log(`[check] ${scopeNote}；如需全量体检请运行：npm run wf -- check --all`);
    }
    return;
  }

  const started = Date.now();
  const results = await Promise.all(tasks.map(runTask));
  const wallMs = Date.now() - started;
  const failed = results.filter(r => !r.ok);

  if (asJson) {
    console.log(JSON.stringify({ ok: failed.length === 0, scopeNote, wallMs, results }, null, 2));
    if (failed.length) process.exitCode = 1;
    return;
  }

  console.log(`[check] ${scopeNote}（并发总耗时 ${wallMs} ms）`);
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`  ${tag.padEnd(4)}  ${r.name.padEnd(20)}  ${String(r.ms).padStart(5)} ms`);
  }
  if (failed.length) {
    console.error(`\n失败项详情（${failed.length}/${results.length}）：`);
    for (const r of failed) {
      console.error(`\n--- ${r.name} ---\n${r.output || '(无输出)'}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
