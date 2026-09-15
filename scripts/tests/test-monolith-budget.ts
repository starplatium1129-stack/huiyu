'use strict';

import type { PathLike } from 'node:fs';

type Baseline = Record<string, number>;

/**
 * test-monolith-budget.js —— 单体体量「只降不升」门禁（2026-08-31 审计立项）
 *
 * 背景：AGENTS.md 与 8-28 工程审计确立的 600 行拆分红线此前仅靠 eslint
 * max-lines warn@1000 预警（warn 不阻断，8-28~8-31 三天单体仍回涨 +870 行）。
 * 本门禁采用与 ALLOWED_EXEMPT / style-debt 同构的「豁免基线」模式：
 *
 *   1. 有效行数（跳过空行与纯注释行，与 eslint max-lines 口径一致）> 600
 *      且不在基线清单 → FAIL（新单体入库）
 *   2. 在基线清单内但有效行数超过基线记录值 → FAIL（存量回涨）
 *   3. 基线内文件已降至 600 以下 → 打印清理提醒（不阻断，下次 --update-baseline 收编）
 *   4. 基线内文件已不存在 → FAIL（防基线腐化）
 *
 * 基线：scripts/tests/monolith-baseline.json。修复拆分后运行
 *   node scripts/tests/test-monolith-budget.js --update-baseline
 * 重新生成（拆分质量仍由 code review 把关，本门禁只防回涨）。
 *
 * 扫描范围与 eslint.config.js max-lines 块保持一致：
 *   src 与 routes 与 services 下的 .ts/.vue/.js 文件 + server.js
 * （services 根层 *.js 与 *.d.ts 是 build:runtime 编译产物，与 eslint ignores 一并排除）
 */

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const BASELINE_FILE = path.join(__dirname, 'monolith-baseline.json');
const RED_LINE = 600;

// 与 eslint.config.js 的 ignores / max-lines files 对齐
const SCAN_DIRS = ['src', 'routes', 'services', 'server'];
const SCAN_EXT = /\.(ts|vue|js)$/;
// services 根层的编译产物三件套不入库也不参检（与 eslint ignores 一致）
const COMPILED_AT_SERVICES_ROOT = (rel: string) =>
  /^services\/[^/]+\.(js|d\.ts)$/.test(rel.replace(/\\/g, '/'));

function listFiles(dir: PathLike): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(String(dir), { withFileTypes: true })) {
    const abs = path.join(String(dir), entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(abs));
    } else if (SCAN_EXT.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

// 与 eslint max-lines { skipBlankLines: true, skipComments: true } 同口径：
// 跳过空行与「整行都是注释」的行（行尾注释不影响计数）。
function isCommentLine(line: string) {
  const t = line.trim();
  if (!t) return true; // 空行
  if (t.startsWith('//')) return true;
  if (t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')) return true; // JS 块注释
  if (t.startsWith('<!--') || t.startsWith('-->')) return true; // Vue 模板注释
  if (t.startsWith('{/*') ) return true; // JSX/Vue 模板内注释包装
  return false;
}

function effectiveLineCount(absPath: string): number {
  const text = fs.readFileSync(absPath, 'utf8');
  return text.split(/\r?\n/).filter((line) => !isCommentLine(line)).length;
}

function relKey(absPath: string) {
  return path.relative(root, absPath).replace(/\\/g, '/');
}

function scan() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(root, dir);
    if (fs.existsSync(abs)) files.push(...listFiles(abs));
  }
  const serverEntryCandidates = ['server.ts', 'server.js'];
  for (const serverEntry of serverEntryCandidates) {
    const serverPath = path.join(root, serverEntry);
    if (fs.existsSync(serverPath)) files.push(serverPath);
  }

  const counts = new Map();
  for (const abs of files) {
    const rel = relKey(abs);
    if (COMPILED_AT_SERVICES_ROOT(rel)) continue;
    const ext = path.extname(rel);
    if (ext === '.js' || ext === '.d.ts') {
      const tsSibling = rel.replace(/\.js$/, '.ts');
      if (counts.has(tsSibling) || fs.existsSync(path.join(root, tsSibling))) continue;
    }
    counts.set(rel, effectiveLineCount(abs));
  }
  return counts;
}

function loadBaseline(): Baseline {
  if (!fs.existsSync(BASELINE_FILE)) return {};
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as Baseline;
}

test('monolith-budget', () => {
  const counts = scan();
  const baseline = loadBaseline();
  const violations = [];
  const retired = [];

  // 1+2：红线拦截（新单体 / 回涨）
  for (const [rel, count] of counts) {
    if (count <= RED_LINE) continue;
    if (!(rel in baseline)) {
      violations.push(`[新单体] ${rel}: ${count} 行 > ${RED_LINE} 红线且不在基线。拆分该文件，或评审后 --update-baseline 收编（需在提交信息说明理由）`);
    } else if (count > baseline[rel]) {
      violations.push(`[回涨] ${rel}: ${count} 行 > 基线 ${baseline[rel]}（600 行拆分红线内只降不升）`);
    }
  }

  // 4：基线死条目
  for (const rel of Object.keys(baseline)) {
    if (!counts.has(rel)) {
      violations.push(`[基线死条目] ${rel}: 文件已不存在，请 --update-baseline 清理基线`);
    }
  }

  // 3：已达标的基线残留（提醒，不阻断）
  for (const rel of Object.keys(baseline)) {
    const count = counts.get(rel);
    if (count !== undefined && count <= RED_LINE) retired.push(`${rel} (${count})`);
  }

  const message = violations.length
    ? `\n单体体量门禁失败（红线 ${RED_LINE} 有效行）：\n  ${violations.join('\n  ')}\n` +
      `拆分指引：优先抽 composable/子模块（参照 routes/video/ 与 usePolling 的既有拆分模式）。`
    : '';

  assert.strictEqual(violations.length, 0, message);

  if (retired.length) {
    console.log(`ℹ️ 以下基线文件已降至红线以下，可运行 --update-baseline 收编：\n  ${retired.join('\n  ')}`);
  }
  console.log(`✅ 单体体量门禁通过：${counts.size} 个文件，${Object.keys(baseline).length} 个基线豁免，红线 ${RED_LINE} 行只降不升。`);
});

// --update-baseline：重算超线清单并写入基线文件
if (process.argv.includes('--update-baseline')) {
  const counts = scan();
  const next: Baseline = {};
  for (const [rel, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (count > RED_LINE) next[rel] = count;
  }
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`基线已更新：${Object.keys(next).length} 个文件 > ${RED_LINE} 有效行 → scripts/tests/monolith-baseline.json`);
  for (const [rel, count] of Object.entries(next)) console.log(`  ${String(count).padStart(5)}  ${rel}`);
}



