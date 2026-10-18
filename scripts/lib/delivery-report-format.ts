import type { AuditComparison, AuditEntry, AuditRecord, AuditRecommendation, AuditReport, RepositoryHead, RepositoryWorktree } from './delivery-types';
'use strict';
const { object }: typeof import('./delivery-paths') = require('./delivery-paths');

// audit:delivery 的人类可读渲染层：只把 report() 已产出的对象排版为文字。
// 不产生新判定、不补齐未启用的检查、不执行推荐命令；未知/未运行/待验/失败/通过
// 沿用条目自身的 status 分别标注，完整数值与结构始终以 --json 为准。

const LABELS: Record<string, string> = {
  passed: '通过', failed: '失败', pending: '待验', unknown: '未知', unrun: '未运行',
  exists: '存在', matched: '一致', mismatch: '不匹配', missing: '缺失',
  'not-file': '非普通文件', 'outside-root': '越出 root', error: '错误',
  clean: '干净', dirty: '有改动', unavailable: '不可用', 'missing-commit': '缺最终提交',
  fresh: '有效', stale: '已陈旧', invalid: '无效', added: '新增', removed: '删除', changed: '改变',
  empty: '空目录', 'unsafe-or-unreadable': '不安全或不可读', 'not-directory': '非目录',
};
const KIND_LABELS: Record<string, string> = { untracked: '未跟踪', uncommitted: '未提交' };

const label = (status: string) => (typeof status === 'string' && LABELS[status]) || status;
const statusLabel = (v: unknown) => (typeof v === 'string' ? label(v) : '缺失');
const count = (r: AuditReport, key: 'passed' | 'errors' | 'pending') => r[key]?.length || 0;

// 任意值安全转文字；循环引用等 JSON.stringify 失败时退回 String()，不抛出。
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

// 摘要行中的 40 位以上十六进制标识缩略为 12 位；完整值保留在 --json。
function short(value: unknown) {
  return typeof value === 'string' && /^[a-f\d]{40,64}$/i.test(value) ? `${value.slice(0, 12)}…` : text(value);
}

function entryLine(entry: Partial<AuditEntry>) {
  const head = [
    entry && typeof entry.status === 'string' ? `[${label(entry.status)}]` : '',
    entry && typeof entry.file === 'string' && entry.file ? entry.file : '',
    entry && typeof entry.field === 'string' && entry.field ? `· ${entry.field}` : '',
  ].filter(Boolean).join(' ');
  const message = text(entry && entry.message);
  const line = head && message ? `${head} — ${message}` : head || message;
  return `  ${line || '（无详情）'}`;
}

function bucket(lines: string[], title: string, entries: Partial<AuditEntry>[] | undefined) {
  if (!Array.isArray(entries) || !entries.length) return;
  lines.push(`${title} (${entries.length}):`);
  for (const entry of entries) lines.push(entryLine(entry));
}

// 待验条目内部仍区分 unknown/unrun 等状态，混合时在标题注明分布。
function pendingTitle(entries: AuditEntry[]) {
  const counts = new Map<string, number>();
  for (const e of entries) if (e && typeof e.status === 'string') counts.set(e.status, (counts.get(e.status) || 0) + 1);
  if (counts.size < 2) return `待验 (${entries.length}):`;
  return `待验 (${entries.length}；${[...counts].map(([s, n]) => `${label(s)} ${n}`).join('、')}):`;
}

function comparisonLine(c: AuditComparison) {
  const detail = text(c && c.message)
    || (Array.isArray(c && c.sharedIds) && c.sharedIds.length ? `共有标识: ${c.sharedIds.join(', ')}` : '');
  const head = `[${statusLabel(c && c.status)}] ${text(c && c.file)}`;
  return `  ${detail ? `${head} — ${detail}` : head}`;
}

function headLines(h: RepositoryHead) {
  const lines = [`仓库 HEAD: [${statusLabel(h.status)}] ${text(h.message) || `状态: ${statusLabel(h.status)}`}`];
  const commits = [h.commit ? `HEAD ${short(h.commit)}` : '', h.evidenceCommit ? `证据 ${short(h.evidenceCommit)}` : ''].filter(Boolean);
  if (commits.length) lines.push(`  ${commits.join(' · ')}`);
  return lines;
}

function worktreeLines(w: RepositoryWorktree) {
  const lines = [`工作树: [${statusLabel(w.status)}] ${text(w.message)}`.trimEnd()];
  const changed = Array.isArray(w.changedFiles) ? w.changedFiles : [];
  for (const c of changed.slice(0, 10)) {
    lines.push(`  - [${KIND_LABELS[c && c.kind] || statusLabel(c && c.kind)}] ${text(c && c.pathPorcelain)}`);
  }
  if (changed.length > 10) lines.push(`  …其余 ${changed.length - 10} 个改动见 --json`);
  return lines;
}

function recordLine(rec: AuditRecord) {
  const parts = [];
  if (rec && typeof rec.commit === 'string' && rec.commit) parts.push(`commit ${short(rec.commit)}`);
  if (rec && typeof rec.baseline === 'string' && rec.baseline) parts.push(`baseline ${short(rec.baseline)}`);
  if (rec && typeof rec.scope === 'string' && rec.scope) parts.push(`scope: ${rec.scope}`);
  const env = rec && object(rec.environment) ? rec.environment : null;
  const envBits = env ? [env.platform, env.node].filter(v => typeof v === 'string' && v) : [];
  if (envBits.length) parts.push(envBits.join(' / '));
  const file = text(rec && rec.file);
  return `  ${file}${parts.length ? ` — ${parts.join(' · ')}` : ''}`.trimEnd();
}

function limitationLine(item: AuditEntry) {
  const message = text(item.message !== undefined ? item.message : item);
  const source = [item.file, item.field].filter(v => typeof v === 'string' && v).join(' · ');
  return `  - ${message}${source ? `（${source}）` : ''}`;
}

function recommendationLine(rec: AuditRecommendation) {
  const command = Array.isArray(rec.command) ? rec.command.map(text).join(' ') : text(rec.command);
  const nature = Array.isArray(rec && rec.nature) ? rec.nature.map(text).join(', ') : text(rec && rec.nature);
  return `  - ${text(rec && rec.name) || '未命名命令'}${nature ? `（nature: ${nature}）` : ''}: ${command}`;
}

function formatReport(r: AuditReport) {
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
  if (r.repositoryHead) lines.push(...headLines(r.repositoryHead));
  if (r.repositoryWorktree) lines.push(...worktreeLines(r.repositoryWorktree));
  if (r.freshness) {
    lines.push(`证据新鲜度: [${statusLabel(r.freshness.status)}] ${text(r.freshness.message)}`.trimEnd());
    for (const key of ['source', 'build'] as const) {
      const group = r.freshness[key];
      if (!group) continue;
      lines.push(`  ${key}: [${statusLabel(group.status)}] ${short(group.status === 'invalid' ? undefined : group.expectedSha256)} → ${short(group.status === 'invalid' ? undefined : group.actualSha256)}`);
      for (const item of (group.changes || []).slice(0, 10)) lines.push(`    [${statusLabel(item.status)}] ${text(item.path)}`);
      if (group.changes?.length > 10) lines.push(`    …其余 ${group.changes.length - 10} 个变化见 --json`);
      if (group.status !== 'invalid') for (const item of group.problems.slice(0, 10)) lines.push(`    [${statusLabel(item.status)}] ${text(item.path)} ${text(item.status === 'file' ? undefined : item.message)}`);
    }
  }
  if (r.handoff) {
    const h = r.handoff;
    lines.push(`办公机 → 主力机交接: [${statusLabel(h.status)}]`);
    if (h.commit) lines.push(`  commit: [${statusLabel(h.commit.status)}] ${short(h.commit.expected)} → ${short(h.commit.actual)}`);
    if (h.finalization) {
      const f = h.finalization;
      lines.push(`  finalize: [${statusLabel(f.status)}] baselineHead ${short(f.status === 'matched' ? f.baselineHead : undefined)} → finalCommit ${short(f.status === 'matched' ? f.finalCommit : undefined)} ${text(f.status === 'invalid' ? f.message : undefined)}`.trimEnd());
    }
    for (const machine of ['office', 'main']) if (h.environment?.[machine]) lines.push(`  environment.${machine}: ${text(h.environment[machine])}`);
    if (h.install) lines.push(`  install: ${text(h.install.entry)} · ${text(h.install.machine)}`);
    for (const item of h.requiredMain || []) lines.push(`  [${statusLabel(item.status)}] ${text(item.field)} · ${text(item.action)}`);
  }
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

export = { formatReport };
