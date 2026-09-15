import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * scripts/tests/run-quality-suite.js — 质量套件执行器
 *
 * 默认摘要模式：逐文件一行 ✔/✘ + 用时，失败才展开输出摘录，
 * 套件末尾给汇总行；任何失败进程退出码非零。
 *   node scripts/tests/run-quality-suite.js <check|unit|contract>            摘要（默认）
 *   node scripts/tests/run-quality-suite.js contract --all                   失败后继续跑完全部文件
 *   node scripts/tests/run-quality-suite.js contract --verbose               旧模式：子进程输出直通
 *
 * check/contract 套件默认 fail-fast（保持既有总时长上限）；--all 用于求全貌。
 * 供 gate-quick.js 复用：runSuiteFiles / runUnitSuite / runNpmScript。
 */

const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const path: typeof import('node:path') = require('node:path');
const { QUALITY_TEST_SUITES }: typeof import('./quality-test-inventory') = require('./quality-test-inventory');

const root = path.resolve(__dirname, '..', '..');
const SUITE_TIMEOUT_MS = Object.freeze({
  check: 180_000,
  unit: 300_000,
  contract: 180_000,
});
const CAPTURE_MAX_BUFFER = 64 * 1024 * 1024;

function formatDuration(ms: number) {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/** 失败摘录：输出不大全打；过大保留头 10 行 + 末尾 80 行（失败断言几乎总在尾部）。 */
function printExcerpt(output: string, file: string) {
  const text = String(output || '').replace(/\r\n/g, '\n').trim();
  if (!text) return;
  const lines = text.split('\n');
  console.error(`  ── ${file} 输出摘录 ──`);
  if (lines.length <= 100) {
    for (const line of lines) console.error(`  ${line}`);
    return;
  }
  for (const line of lines.slice(0, 10)) console.error(`  ${line}`);
  console.error(`  …（省略 ${lines.length - 90} 行）…`);
  for (const line of lines.slice(-80)) console.error(`  ${line}`);
}

/** 跑单个 node 脚本（捕获输出）。返回 {ok, duration, output}。 */
function runStep(name: any, file: string, args: any, timeout: number) {
  const started = Date.now();
  const result: any = spawnSync(process.execPath, [file, ...(args || [])], {
    cwd: root,
    timeout,
    maxBuffer: CAPTURE_MAX_BUFFER,
    encoding: 'utf8',
  });
  const duration = Date.now() - started;
  let reason = '';
  if (result.error) reason = result.error.code === 'ETIMEDOUT' ? `TIMEOUT(${formatDuration(timeout)})` : result.error.message;
  else if (result.signal) reason = `signal ${result.signal}`;
  else if (result.status !== 0) reason = `exit ${result.status ?? '?'}`;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return { name, ok: !reason, duration, reason, output };
}

/**
 * 逐文件跑一组 node 脚本并输出摘要。
 * entries: { name, file, args? }[]；返回非零退出码（有失败时）。
 */
function runSuiteFiles(entries: string|any[], { label, timeout, verbose = false, keepGoing = false }: any) {
  const passed = [];
  const failed = [];
  const started = Date.now();
  for (const entry of entries) {
    if (verbose) {
      const child = spawnSync(process.execPath, [entry.file, ...(entry.args || [])], {
        cwd: root,
        stdio: 'inherit',
        timeout,
      });
      const status = child.status ?? 1;
      if (status === 0) {
        passed.push(entry.name);
      } else {
        failed.push(entry.name);
        if (!keepGoing) break;
      }
      continue;
    }
    const step = runStep(entry.name, entry.file, entry.args, timeout);
    if (step.ok) {
      passed.push(entry.name);
      console.log(`✔ ${entry.name} ${formatDuration(step.duration)}`);
    } else {
      failed.push(entry.name);
      console.log(`✘ ${entry.name} ${formatDuration(step.duration)} ${step.reason}`);
      printExcerpt(step.output, entry.name);
      if (!keepGoing) break;
    }
  }
  const total = Date.now() - started;
  const skipped = entries.length - passed.length - failed.length;
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL';
  console.log(`sum [${label}]: ${verdict} · ${passed.length} 过 / ${failed.length} 挂${skipped > 0 ? ` · 未跑 ${skipped}` : ''} · ${formatDuration(total)}`);
  return failed.length === 0 ? 0 : 1;
}

/** unit 套件：单进程 node --test 聚合跑全部文件（保持既有并发=4）。 */
function runUnitSuite({ verbose = false }: any = {}) {
  const files = QUALITY_TEST_SUITES.unit.map((file) => path.join(root, 'scripts', 'tests', file));
  const started = Date.now();
  if (verbose) {
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files], {
      cwd: root,
      stdio: 'inherit',
      timeout: SUITE_TIMEOUT_MS.unit,
    });
    return result.status ?? 1;
  }
  const result: any = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files], {
    cwd: root,
    timeout: SUITE_TIMEOUT_MS.unit,
    maxBuffer: CAPTURE_MAX_BUFFER,
    encoding: 'utf8',
  });
  const duration = Date.now() - started;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const ok = !result.error && result.status === 0;
  if (ok) {
    const passLine = /ℹ (?:pass|tests) (\d+)/.exec(output);
    const count = passLine ? `${passLine[1]} 用例` : '全部文件';
    console.log(`✔ unit 套件 ${count} ${formatDuration(duration)}`);
    return 0;
  }
  const reason = result.error
    ? (result.error.code === 'ETIMEDOUT' ? `TIMEOUT(${formatDuration(SUITE_TIMEOUT_MS.unit)})` : result.error.message)
    : `exit ${result.status ?? '?'}`;
  console.log(`✘ unit 套件 ${formatDuration(duration)} ${reason}`);
  printExcerpt(output, 'unit');
  return 1;
}

/** 跑一个 npm script。Node 24 禁止 spawnSync 直呼 .cmd（EINVAL），
 *  故整串命令 + shell:true；script 名全部来自本文件内部常量，无注入面。 */
function runNpmScript(script: any, timeout: any = 300_000) {
  const started = Date.now();
  const result: any = spawnSync(`npm run ${script}`, {
    cwd: root,
    timeout,
    maxBuffer: CAPTURE_MAX_BUFFER,
    encoding: 'utf8',
    shell: true,
  });
  const duration = Date.now() - started;
  let reason = '';
  if (result.error) reason = result.error.code === 'ETIMEDOUT' ? `TIMEOUT(${formatDuration(timeout)})` : result.error.message;
  else if (result.signal) reason = `signal ${result.signal}`;
  else if (result.status !== 0) reason = `exit ${result.status ?? '?'}`;
  return { name: script, ok: !reason, duration, reason, output: `${result.stdout || ''}\n${result.stderr || ''}` };
}

function main(argv: string[]) {
  const suiteName = argv.find((arg: PropertyKey) => Object.hasOwn(QUALITY_TEST_SUITES, arg));
  if (!suiteName) {
    console.error(`usage: node ${path.basename(__filename)} <check|unit|contract> [--verbose] [--all]`);
    return 2;
  }
  const verbose = argv.includes('--verbose');
  const keepGoing = argv.includes('--all');
  const files = QUALITY_TEST_SUITES[suiteName];
  const entries = files.map((file: string) => ({ name: file, file: path.join(root, 'scripts', 'tests', file) }));
  if (suiteName === 'unit' || suiteName === 'contract') {
    // 数据聚合产物不入库（2026-08-28）：unit（test-prompt-corpus 直读 scenes.json）
    // 与 contract 套件都直接读取生成文件，fresh clone 先补齐缺失产物。
    // onlyIfMissing：陈旧态留给 --check 门禁报红，不在测试里静默自愈。
    try {
      const ensured = (require('../lib/ensure-data-build') as typeof import('../lib/ensure-data-build')).ensureAll({ onlyIfMissing: true });
      const rebuilt = ['scenes', 'popular'].filter((face) => ensured[face].rebuilt);
      if (rebuilt.length) console.log(`↻ [data-build] 产物缺失，已构建: ${rebuilt.join(' + ')}`);
    } catch (error) {
      console.error(`✘ [data-build] 产物自愈构建失败: ${runtimeErrorMessage(error)}`);
      return 1;
    }
  }
  if (suiteName === 'unit') return runUnitSuite({ verbose });
  return runSuiteFiles(entries, {
    label: suiteName,
    timeout: SUITE_TIMEOUT_MS[suiteName],
    verbose,
    keepGoing,
  });
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

export = { runSuiteFiles, runUnitSuite, runNpmScript, runStep, formatDuration, printExcerpt, SUITE_TIMEOUT_MS, root };
