'use strict';

// audit:delivery 的人类可读渲染层：只把 report() 已产出的对象排版为文字。
// 不产生新判定、不补齐未启用的检查、不执行推荐命令；未知/未运行/待验/失败/通过
// 沿用条目自身的 status 分别标注，完整数值与结构始终以 --json 为准。

const LABELS = {
  passed: '通过', failed: '失败', pending: '待验', unknown: '未知', unrun: '未运行',
  exists: '存在', matched: '一致', mismatch: '不匹配', missing: '缺失',
  'not-file': '非普通文件', 'outside-root': '越出 root', error: '错误',
  clean: '干净', dirty: '有改动', unavailable: '不可用', 'missing-commit': '缺最终提交',
};
const KIND_LABELS = { untracked: '未跟踪', uncommitted: '未提交' };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const label = (status) => (typeof status === 'string' && LABELS[status]) || status;
const statusLabel = (v) => (typeof v === 'string' ? label(v) : '缺失');
const count = (r, key) => (Array.isArray(r[key]) ? r[key].length : 0);

// 任意值安全转文字；循环引用等 JSON.stringify 失败时退回 String()，不抛出。
function text(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

// 摘要行中的 40 位以上十六进制标识缩略为 12 位；完整值保留在 --json。
function short(value) {
  return typeof value === 'string' && /^[a-f\d]{40,64}$/i.test(value) ? `${value.slice(0, 12)}…` : text(value);
}

function entryLine(entry) {
  const head = [
    entry && typeof entry.status === 'string' ? `[${label(entry.status)}]` : '',
    entry && typeof entry.file === 'string' && entry.file ? entry.file : '',
    entry && typeof entry.field === 'string' && entry.field ? `· ${entry.field}` : '',
  ].filter(Boolean).join(' ');
  const message = text(entry && entry.message);
  const line = head && message ? `${head} — ${message}` : head || message;
  return `  ${line || '（无详情）'}`;
}

function bucket(lines, title, entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  lines.push(`${title} (${entries.length}):`);
  for (const entry of entries) lines.push(entryLine(entry));
}

// 待验条目内部仍区分 unknown/unrun 等状态，混合时在标题注明分布。
function pendingTitle(entries) {
  const counts = new Map();
  for (const e of entries) if (e && typeof e.status === 'string') counts.set(e.status, (counts.get(e.status) || 0) + 1);
  if (counts.size < 2) return `待验 (${entries.length}):`;
  return `待验 (${entries.length}；${[...counts].map(([s, n]) => `${label(s)} ${n}`).join('、')}):`;
}

function comparisonLine(c) {
  const detail = text(c && c.message)
    || (Array.isArray(c && c.sharedIds) && c.sharedIds.length ? `共有标识: ${c.sharedIds.join(', ')}` : '');
  const head = `[${statusLabel(c && c.status)}] ${text(c && c.file)}`;
  return `  ${detail ? `${head} — ${detail}` : head}`;
}

function headLines(h) {
  const lines = [`仓库 HEAD: [${statusLabel(h.status)}] ${text(h.message) || `状态: ${statusLabel(h.status)}`}`];
  const commits = [h.commit ? `HEAD ${short(h.commit)}` : '', h.evidenceCommit ? `证据 ${short(h.evidenceCommit)}` : ''].filter(Boolean);
  if (commits.length) lines.push(`  ${commits.join(' · ')}`);
  return lines;
}

function worktreeLines(w) {
  const lines = [`工作树: [${statusLabel(w.status)}] ${text(w.message)}`.trimEnd()];
  const changed = Array.isArray(w.changedFiles) ? w.changedFiles : [];
  for (const c of changed.slice(0, 10)) {
    lines.push(`  - [${KIND_LABELS[c && c.kind] || statusLabel(c && c.kind)}] ${text(c && c.pathPorcelain)}`);
  }
  if (changed.length > 10) lines.push(`  …其余 ${changed.length - 10} 个改动见 --json`);
  return lines;
}

function recordLine(rec) {
  const parts = [];
  if (rec && typeof rec.commit === 'string' && rec.commit) parts.push(`commit ${short(rec.commit)}`);
  if (rec && typeof rec.baseline === 'string' && rec.baseline) parts.push(`baseline ${short(rec.baseline)}`);
  if (rec && typeof rec.scope === 'string' && rec.scope) parts.push(`scope: ${rec.scope}`);
  const env = rec && isObject(rec.environment) ? rec.environment : null;
  const envBits = env ? [env.platform, env.node].filter(v => typeof v === 'string' && v) : [];
  if (envBits.length) parts.push(envBits.join(' / '));
  const file = text(rec && rec.file);
  return `  ${file}${parts.length ? ` — ${parts.join(' · ')}` : ''}`.trimEnd();
}

function limitationLine(item) {
  const message = text(isObject(item) && item.message !== undefined ? item.message : item);
  const source = isObject(item) ? [item.file, item.field].filter(v => typeof v === 'string' && v).join(' · ') : '';
  return `  - ${message}${source ? `（${source}）` : ''}`;
}

function recommendationLine(rec) {
  const command = Array.isArray(rec && rec.command) ? rec.command.map(text).join(' ') : text(rec && rec.command);
  const nature = Array.isArray(rec && rec.nature) ? rec.nature.map(text).join(', ') : text(rec && rec.nature);
  return `  - ${text(rec && rec.name) || '未命名命令'}${nature ? `（nature: ${nature}）` : ''}: ${command}`;
}

function formatReport(r) {
  if (!isObject(r)) return `交付审计状态: 未知\n（报告对象不可解析: ${text(r) || '空'}）`;
  const lines = [];
  const exit = Number.isFinite(r.exitCode) ? `（退出码 ${r.exitCode}）` : '';
  lines.push(`交付审计状态: ${statusLabel(r.status)}${exit}`);
  lines.push(`通过 ${count(r, 'passed')} ｜ 错误 ${count(r, 'errors')} ｜ 待验 ${count(r, 'pending')}`);
  bucket(lines, '错误', r.errors);
  if (Array.isArray(r.pending) && r.pending.length) {
    lines.push(pendingTitle(r.pending));
    for (const entry of r.pending) lines.push(entryLine(entry));
  }
  bucket(lines, '通过', r.passed);
  bucket(lines, '显式文件核验', r.verifiedFiles);
  if (Array.isArray(r.comparisons) && r.comparisons.length) {
    lines.push(`证据比较 (${r.comparisons.length}):`);
    for (const c of r.comparisons) lines.push(comparisonLine(c));
  }
  if (isObject(r.repositoryHead)) lines.push(...headLines(r.repositoryHead));
  if (isObject(r.repositoryWorktree)) lines.push(...worktreeLines(r.repositoryWorktree));
  if (Array.isArray(r.records) && r.records.length) {
    lines.push(`证据记录 (${r.records.length}):`);
    for (const rec of r.records) lines.push(recordLine(rec));
  }
  if (Array.isArray(r.limitations) && r.limitations.length) {
    lines.push(`限制与未覆盖 (${r.limitations.length}):`);
    for (const item of r.limitations) lines.push(limitationLine(item));
  }
  if (Array.isArray(r.recommendations) && r.recommendations.length) {
    lines.push(`未执行推荐命令 (${r.recommendations.length}):`);
    for (const rec of r.recommendations) lines.push(recommendationLine(rec));
  }
  return lines.join('\n');
}

module.exports = { formatReport };
