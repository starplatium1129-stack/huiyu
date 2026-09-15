'use strict';

// audit:impact 的人类可读渲染层：只把 report() 已产出的对象排版为文字。
// 不重新查文件、不执行推荐命令、不产生新判定、不修改推荐范围；完整结构
// 与数值始终以 --json 为准。条目沿用自身 domain/object/reason 与状态标识，
// 不把仅关联对象称为必改；空集合整节省略，长列表截断时注明剩余数量。

const MAX_ITEMS = 40;
const TIERS = ['curatedSceneIds', 'signatureSceneIds', 'personaCoreSceneIds'];

const isObject = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rows = (v: any) => (Array.isArray(v) ? v : []);
const field = (row: any, key: string) => ((row && typeof row[key] === 'string' && row[key]) || '');

// 任意值安全转文字；循环引用等 JSON.stringify 失败时退回 String()，不抛出。
function text(value: any) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value !== 'object') return String(value);
  try { return JSON.stringify(value); } catch { return '[不可序列化]'; }
}

function limited(lines: string|any[]) {
  if (lines.length <= MAX_ITEMS) return lines;
  return [...lines.slice(0, MAX_ITEMS), `  …（其余 ${lines.length - MAX_ITEMS} 条见 --json）`];
}

function issueLine(entry: { reason: any; }) {
  const domain = field(entry, 'domain') || '无域';
  const object = field(entry, 'object') || '（无对象）';
  const reason = entry && entry.reason !== undefined ? text(entry.reason) : '';
  const head = `[${domain}] ${object}`;
  return `  ${reason ? `${head} — ${reason}` : head}`;
}

function issueSection(title: string, entries: any) {
  const list = rows(entries);
  if (!list.length) return [];
  return [`${title}: ${list.length} 条`, ...limited(list.map(issueLine))];
}

function unknownSection(items: any) {
  const list = rows(items);
  if (!list.length) return [];
  return [`未知范围 unknown: ${list.length} 条`, ...limited(list.map((item) => `  - ${text(item)}`))];
}

function recommendationLine(rec: any) {
  const name = field(rec, 'name') || '未命名命令';
  const nature = rows(rec && rec.nature).map(text).filter(Boolean).join(', ') || field(rec, 'nature');
  const argv = rows(rec && rec.argv).map(text).filter(Boolean).join(' ');
  const executed = rec && rec.executed === true ? '（已执行）' : '';
  return `  - ${name}${executed}${nature ? `（nature: ${nature}）` : ''}${argv ? `: ${argv}` : ''}`;
}

function recommendationSection(items: any) {
  const list = rows(items);
  if (!list.length) return [];
  return [`未执行推荐命令 recommendations: ${list.length} 条`, ...limited(list.map(recommendationLine))];
}

function gitSection(git: any) {
  if (!isObject(git)) return [];
  const lines = [`Git 变更 gitChanges: ${field(git, 'status') || 'unknown'}`];
  const reason = field(git, 'reason');
  if (reason) lines.push(`  ${reason}`);
  const paths = rows(git.paths);
  if (paths.length) {
    lines.push(`  变更路径 ${paths.length} 个:`);
    lines.push(...limited(paths.map((p) => `  - ${text(p)}`)));
  }
  return lines;
}

function historySection(history: any, git: any) {
  if (!isObject(git)) return [];
  const lines = [`历史对照 gitHistory: ${field(git, 'status') || 'unknown'} · ${field(git, 'baseCommit') || '未解析基线'} → 当前工作树`];
  if (git.reason) lines.push(`  ${text(git.reason)}`);
  for (const change of rows(git.changes)) lines.push(`  ${text(change.status)} ${text(change.oldPath)}${change.oldPath && change.path ? ' → ' : ''}${text(change.path)}`);
  for (const change of rows(history && history.entities)) {
    lines.push(`  [${text(change.role)}] ${text(change.kind)} ${change.characterId ? text(change.characterId) + '/' : ''}${text(change.id)}: ${text(change.change)} · ${rows(change.changedFields).map(text).join(', ')}`);
  }
  return limited(lines);
}

function incrementalSection(plan: any) {
  if (!isObject(plan)) return [];
  const lines = [`增量检查计划: ${field(plan, 'mode') || 'unknown'}（预览；未执行）`,
    `  全库状态: ${field(plan, 'wholeLibrary') || 'unknown'}`, `  ${text(plan.acceptance)}`];
  for (const check of rows(plan.incrementalChecks)) lines.push(`  可限定检查 ${text(check.id)}: ${rows(check.targets).length} 个稳定 ID · ${text(check.proof)}`);
  for (const check of rows(plan.fullChecks)) {
    lines.push(`  full 必需 ${text(check.id)}:`);
    lines.push(...rows(check.reasons).map((reason) => `    ${text(reason)}`));
  }
  return limited(lines);
}

function outfitSection(items: any) {
  const list = rows(items);
  if (!list.length) return [];
  const lines = list.map((row) => {
    const id = field(row, 'id') || '（无 ID）';
    const status = field(row, 'status') || 'unknown';
    const bits = [];
    if (status === 'explicit' && row && row.defaultOutfit !== undefined && row.defaultOutfit !== null) bits.push(`默认 ${text(row.defaultOutfit)}`);
    const reasons = rows(row && row.reasons).map(text).filter(Boolean);
    if (reasons.length) bits.push(reasons.join('；'));
    for (const [key, label] of [['defaultIds', 'default'], ['isDefaultIds', 'isDefault']]) {
      const ids = rows(row && row[key]);
      if (ids.length) bits.push(`${label} 标记: ${ids.map(text).join(', ')}`);
    }
    return `  ${id}: ${status}${bits.length ? `（${bits.join('；')}）` : ''}`;
  });
  return [`默认服装 outfitDefaults: ${list.length} 项`, ...limited(lines)];
}

function referenceSection(items: any) {
  const list = rows(items);
  if (!list.length) return [];
  const lines = list.map((row) => {
    const character = field(row, 'characterId') || '（无角色）';
    const outfit = row && row.outfitId !== undefined && row.outfitId !== null ? text(row.outfitId) : '*';
    const status = field(row, 'status') || 'unknown';
    const bits = [];
    if (typeof (row && row.total) === 'number') {
      bits.push(`共 ${row.total} 条`);
      const counts = [['pendingCount', 'pending'], ['urlDeclaredCount', 'URL 声明'], ['reviewDeclaredCount', 'review 声明']]
        .filter(([key]) => typeof row[key] === 'number').map(([key, label]) => `${label} ${row[key]}`);
      if (counts.length) bits.push(counts.join('、'));
    }
    if (row && row.reviewStatus !== undefined) bits.push(`review: ${text(row.reviewStatus) || 'unknown'}`);
    bits.push(`素材存在性: ${field(row, 'assetStatus') || 'unknown'}`);
    const reason = field(row, 'reason');
    return `  ${character}/${outfit}: ${status}${bits.length ? ` · ${bits.join(' · ')}` : ''}${reason ? ` — ${reason}` : ''}`;
  });
  return [`参考状态 referenceEvidence: ${list.length} 项（仅索引声明，未访问素材）`, ...limited(lines)];
}

function themeSection(items: any) {
  const list = rows(items);
  if (!list.length) return [];
  const lines = list.map((row) => {
    const id = field(row, 'id') || '（无 ID）';
    const status = field(row, 'themeStatus') || 'unknown';
    const selector = field(row, 'selector');
    const reason = field(row, 'reason');
    return `  ${id}: ${status}${selector ? ` ${selector}` : ''}${reason ? ` — ${reason}` : ''}`;
  });
  return [`主题 themes: ${list.length} 项`, ...limited(lines)];
}

function sceneSection(items: any) {
  const list = rows(items);
  if (!list.length) return [];
  const lines = list.map((scene) => {
    const id = field(scene, 'id') || '（无 ID）';
    const bits = [];
    const sources = rows(scene && scene.sources).map((s) => field(s, 'file')).filter(Boolean);
    bits.push(`源 ${field(scene, 'sourceStatus') || 'unknown'}${sources.length ? `: ${sources.join(', ')}` : ''}`);
    if (isObject(scene && scene.aggregate)) bits.push(`聚合 ${field(scene.aggregate, 'status') || 'unknown'}（${field(scene.aggregate, 'file') || '?'}）`);
    const curation = scene && scene.curation;
    if (isObject(curation)) {
      const keys = [...TIERS, ...Object.keys(curation).filter((k) => !TIERS.includes(k))];
      const tiers = keys.filter((k) => k in curation).map((k) => `${k}=${text(curation[k])}`);
      if (tiers.length) bits.push(`精选 ${tiers.join(', ')}`);
    }
    if (isObject(scene && scene.retirement)) {
      const retired = rows(scene.retirement.records).length;
      bits.push(`退役 ${field(scene.retirement, 'status') || 'unknown'}${retired ? `（${retired} 条登记）` : ''}`);
    }
    return `  ${id}: ${bits.join(' · ')}`;
  });
  return [`场景 scenes: ${list.length} 项`, ...limited(lines)];
}

function showcaseSection(showcase: any) {
  if (!isObject(showcase)) return [];
  const manifests = rows(showcase.manifests);
  if (!manifests.length) return [];
  const lines = [];
  for (const manifest of manifests) {
    const file = field(manifest, 'file') || '（无文件）';
    const status = field(manifest, 'status') || 'unknown';
    const reason = field(manifest, 'reason');
    lines.push(`  ${file}: ${status}${reason ? ` — ${reason}` : ''}`);
    const entries = rows(manifest && manifest.entries);
    if (!entries.length) continue;
    lines.push(`    匹配 ${entries.length} 条:`);
    for (const entry of entries) {
      const bits = [];
      for (const key of ['type', 'char', 'rating', 'attempt']) {
        if (entry && entry[key] !== undefined && entry[key] !== null) bits.push(`${key}=${text(entry[key])}`);
      }
      if (entry && entry.reviewPresent !== undefined && entry.reviewPresent !== null) bits.push(entry.reviewPresent ? 'review 字段已声明' : 'review 字段未声明');
      const matchedBy = rows(entry && entry.matchedBy).map(text).filter(Boolean);
      if (matchedBy.length) bits.push(`命中: ${matchedBy.join('/')}`);
      lines.push(`      #${text(entry && entry.index)} ${field(entry, 'id') || '（无 ID）'}${bits.length ? ` · ${bits.join(' · ')}` : ''}`);
    }
  }
  return [`样张 showcase: ${field(showcase, 'status') || 'unknown'}`, ...limited(lines)];
}

function formatImpactReport(result: any) {
  if (!isObject(result)) return `只读影响报告\n（报告对象不可解析: ${text(result) || '空'}；完整结果使用 --json 查看）`;
  const input = isObject(result.input) ? result.input : {};
  const target = [];
  if (field(input, 'character')) target.push(`角色 ${input.character}`);
  if (field(input, 'outfit')) target.push(`服装 ${input.outfit}`);
  if (field(input, 'scene')) target.push(`场景 ${input.scene}`);
  const paths = rows(input.paths);
  if (paths.length) target.push(`路径 ${paths.length} 个: ${paths.slice(0, 5).map(text).join(', ')}${paths.length > 5 ? ` …（其余 ${paths.length - 5} 个见 --json）` : ''}`);
  if (isObject(result.gitChanges)) target.push('Git 工作树变更');
  if (isObject(result.gitHistory)) target.push(`历史基线 ${field(input, 'base')}`);
  if (!target.length) target.push('未指定显式目标');
  const count = (list: any) => rows(list).length;
  const header = [
    '只读影响报告（只读分析；未执行推荐命令，未验证真实渲染）',
    `目标: ${target.join(' · ')}`,
    `范围摘要: 必改 ${count(result.mustChange)} ｜ 需复验 ${count(result.revalidate)} ｜ 仅关联 ${count(result.related)} ｜ 未知 ${count(result.unknown)} 条 ｜ 建议命令 ${count(result.recommendations)}（未执行）`,
  ];
  const blocks = [header];
  const add = (build: { (): any[]; (): any[]; (): any[]; (): any[]; (): any[]; (): string[]; (): any; (): any; (): any[]; (): any[]; (): any[]; (): any[]; (): any[]; (): any; }) => {
    try { const block: any = build(); if (block.length) blocks.push(block); } catch { blocks.push(['（该节渲染异常；完整结果使用 --json 查看）']); }
  };
  add(() => issueSection('必改 mustChange', result.mustChange));
  add(() => issueSection('需复验 revalidate', result.revalidate));
  add(() => issueSection('仅关联 related', result.related));
  add(() => unknownSection(result.unknown));
  add(() => recommendationSection(result.recommendations));
  add(() => gitSection(result.gitChanges));
  add(() => historySection(result.history, result.gitHistory));
  add(() => incrementalSection(result.incrementalPlan));
  add(() => outfitSection(result.outfitDefaults));
  add(() => referenceSection(result.referenceEvidence));
  add(() => themeSection(result.themes));
  add(() => sceneSection(result.scenes));
  add(() => showcaseSection(result.showcase));
  return blocks.map((block) => block.join('\n')).join('\n\n');
}

export = { formatImpactReport };
