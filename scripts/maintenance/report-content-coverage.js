#!/usr/bin/env node
'use strict';

/**
 * scripts/maintenance/report-content-coverage.js — 只读内容覆盖差额报告（计划 006 W1/D1 配套）
 *
 * 回答两个问题，全部只读：
 *   1. 热门服装 → 参考登记差额：popular 分片里存在、standards/view 未登记的形态；
 *      已登记形态中 pending（无 url）与 url 已填但素材根缺实图的区分。
 *   2. 角色 canonical ID → 主题选择器差额：tokens.css 的 data-character 选择器
 *      相对 characters.json canonical ID 的覆盖；旧别名选择器与待补清单分开。
 *
 * 边界（主任务复核口径，见 docs/guides/engineering/glm-implementation-handoff.md）：
 *   - 覆盖差额是「覆盖待办」，不是悬空引用；本命令不登记服装、不出图、不改主题，
 *     退出码不因差额数量失败（信息性报告），仅结构错误才退出 1。
 *   - URL 非空只代表索引声明；「缺实图」以与 check-ref-urls 相同的素材根解析
 *     （server/config.resolveCharRefRoot）实际 statSync 为准；素材根不存在时归为
 *     unverified，不冒充缺图，也不冒充通过。
 *
 * 按 popular-store 的 manifest 顺序只读加载；使用显式 root 避免该模块的环境变量
 * 缓存影响隔离夹具。复用 server/config 的素材根解析，不调用配置初始化。
 *
 * 用法：
 *   node scripts/maintenance/report-content-coverage.js [--json] [--root <目录>]
 *   --root 用于隔离夹具（测试）；默认仓库根（与 popular-store 的 AICS_DATA_ROOT 同约定）。
 *
 * 退出码：0 = 仅有覆盖差额或全部覆盖；1 = 结构错误（清单缺文件、根结构不对、
 * 跨分片重复 ID、manifest 批次数缺失/不符、standards↔view 镜像破坏）。
 */

const fs = require('fs');
const path = require('path');

/** 默认主题归属：tokens.css 的 :root 默认强调色对所有未显式注册角色生效。
 *  现状（2026-09-13）仅 nene 被有意留在默认主题（工程契约「新角色必做主题层」之前的
 *  基础角色），:root 默认色与 characters.json 的 accent_color 不同源，无法由数据推导，
 *  故以显式清单登记，修改须附证据。 */
const DEFAULT_THEME_ALLOWED = Object.freeze(['nene']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

/** 别名归一：小写、非字母数字折叠为下划线（"historia reiss" -> "historia_reiss"）。 */
function normalizeAlias(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** 从 CSS 文本提取全部 data-character 选择器 id（去重排序）。 */
function extractThemeSelectors(cssText) {
  const ids = [];
  for (const match of String(cssText).matchAll(/data-character="([A-Za-z0-9_-]+)"/g)) ids.push(match[1]);
  return sortedUnique(ids);
}

/**
 * 主题覆盖分析（纯函数，便于夹具测试）。
 * inputs: { characters:[{id,accent_color?}], selectors:[string], popularAliasMap:Map<normalized, canonicalId> }
 */
function analyseThemes({ characters, selectors, popularAliasMap }) {
  const charIds = characters.map((c) => c.id);
  const dupCharacters = sortedUnique(charIds.filter((id, index) => charIds.indexOf(id) !== index));
  const charSet = new Set(charIds);
  const selectorSet = new Set(selectors);
  const accentById = new Map(characters.map((c) => [c.id, c.accent_color]));

  const explicit = [];
  const missingTheme = [];
  const defaultAllowed = [];
  for (const id of sortedUnique(charIds)) {
    if (selectorSet.has(id)) explicit.push(id);
    else if (DEFAULT_THEME_ALLOWED.includes(id)) defaultAllowed.push(id);
    else missingTheme.push({ id, accentColor: accentById.get(id) || null, source: 'data/characters.json' });
  }
  const staleAlias = [];
  const nonCharacter = [];
  for (const selector of selectors) {
    if (charSet.has(selector)) continue;
    const suggestion = popularAliasMap.get(selector);
    if (suggestion) staleAlias.push({ selector, suggestion, matchType: 'alias', note: '待人工确认后改名，不改语义' });
    else nonCharacter.push({ selector, note: '未匹配任何 canonical ID；triad 等共享主题属设计现状，需人工归类' });
  }
  return { explicit, defaultAllowed, missingTheme, staleAlias, nonCharacter, dupCharacters };
}

/**
 * 参考覆盖分析（纯函数）。
 * inputs: {
 *   popular: [{ id, outfitId, file }],
 *   standards: [{ id, outfitIds:[...] }],
 *   view: [{ id, outfits:[{ outfitId, references:[{ pending, url }] }] }],
 *   fileExists: (url) => true|false|null   // null = 无法核实（素材根缺失/structure 模式）
 * }
 */
function analyseReferences({ popular, standards, view, fileExists }) {
  const duplicateRegistrations = [];
  for (const [source, records, outfitsOf] of [
    ['standards', standards, (c) => c.outfitIds],
    ['view', view, (c) => c.outfits.map((o) => o.outfitId)],
  ]) {
    const seen = new Set();
    for (const record of records) {
      if (seen.has(record.id)) duplicateRegistrations.push(`${source}: 重复角色 ${record.id}`);
      seen.add(record.id);
      const outfits = new Set();
      for (const id of outfitsOf(record)) {
        if (outfits.has(id)) duplicateRegistrations.push(`${source}: 重复形态 ${record.id}/${id}`);
        outfits.add(id);
      }
    }
  }
  const standardsMap = new Map(standards.map((c) => [c.id, new Set(c.outfitIds)]));
  const viewMap = new Map(view.map((c) => [c.id, c.outfits]));

  const missingRegistration = [];
  const pending = [];
  const missingImage = [];
  const unverifiedImage = [];
  let verifiedImage = 0;

  // 双向镜像校验（contract 语义）：standards 与 view 的形态集合必须一致。
  const mirrorErrors = [];
  for (const [id, outfitIds] of standardsMap) {
    const viewOutfits = new Set((viewMap.get(id) || []).map((o) => o.outfitId));
    for (const outfitId of outfitIds) if (!viewOutfits.has(outfitId)) mirrorErrors.push(`${id}: standards 独有形态 ${outfitId}`);
    for (const outfitId of viewOutfits) if (!outfitIds.has(outfitId)) mirrorErrors.push(`${id}: view 独有形态 ${outfitId}`);
  }
  for (const id of viewMap.keys()) if (!standardsMap.has(id)) mirrorErrors.push(`${id}: view 有角色而 standards 无`);

  // 跨分片重复检测：角色 ID 应只出现在一个分片文件；服装 ID 在角色内应唯一。
  const charFiles = new Map();
  const outfitRowCount = new Map();
  const duplicateCharacters = [];
  const duplicateOutfits = [];
  for (const entry of popular) {
    if (!charFiles.has(entry.id)) charFiles.set(entry.id, new Set());
    const files = charFiles.get(entry.id);
    files.add(entry.file);
    if (files.size === 2) duplicateCharacters.push(entry.id);
    const key = `${entry.id}/${entry.outfitId}`;
    outfitRowCount.set(key, (outfitRowCount.get(key) || 0) + 1);
    if (outfitRowCount.get(key) === 2) duplicateOutfits.push(key);
  }

  for (const entry of popular) {
    const inStandards = standardsMap.get(entry.id)?.has(entry.outfitId) || false;
    if (!inStandards) {
      missingRegistration.push({ id: entry.id, outfitId: entry.outfitId, source: entry.file, related: 'data/character-reference-standards.json 无此形态' });
      continue;
    }
    const viewOutfit = (viewMap.get(entry.id) || []).find((o) => o.outfitId === entry.outfitId);
    const refs = viewOutfit?.references || [];
    const pendingRefs = refs.filter((r) => r.pending === true || !r.url);
    if (pendingRefs.length) {
      pending.push({ id: entry.id, outfitId: entry.outfitId, source: 'data/character-reference-view.json', pending: pendingRefs.length, total: refs.length });
    }
    for (const ref of refs) {
      if (ref.pending === true || !ref.url) continue;
      const exists = fileExists(ref.url);
      if (exists === true) verifiedImage += 1;
      else if (exists === false) missingImage.push({ id: entry.id, outfitId: entry.outfitId, refId: ref.id, url: ref.url, source: 'data/character-reference-view.json' });
      else unverifiedImage.push({ id: entry.id, outfitId: entry.outfitId, refId: ref.id, url: ref.url });
    }
  }

  // standards 独有（popular 无对应）单列；集合差额本身不能证明来源或正确性。
  const referenceOnlyForms = [];
  const popularMap = new Map();
  for (const entry of popular) {
    if (!popularMap.has(entry.id)) popularMap.set(entry.id, new Set());
    popularMap.get(entry.id).add(entry.outfitId);
  }
  for (const [id, outfitIds] of standardsMap) {
    const popularOutfits = popularMap.get(id);
    for (const outfitId of outfitIds) if (!popularOutfits || !popularOutfits.has(outfitId)) {
      referenceOnlyForms.push({ id, outfitId, note: 'standards 独有形态；来源与必要性待核实，不自动删除' });
    }
  }

  return {
    missingRegistration, pending, missingImage, unverifiedImage, verifiedImage,
    referenceOnlyForms, mirrorErrors, duplicateCharacters, duplicateOutfits, duplicateRegistrations,
  };
}

/** 由 URL 判定素材文件是否存在的工厂；返回 true|false|null（null=无法核实）。
 *  解析语义与 scripts/maintenance/check-ref-urls.js auditReferenceView 一致。 */
function makeFileExists({ appRoot, env }) {
  const { resolveCharRefRoot } = require('../../server/config');
  const assetsRoot = path.resolve(env.AICS_ASSETS_ROOT || path.join(appRoot, 'assets'));
  const structureOnly = env.AICS_REFERENCE_AUDIT_MODE === 'structure';
  return function fileExists(url) {
    const value = typeof url === 'string' ? url : '';
    const prefix = value.startsWith('/character-references/') ? '/character-references/'
      : value.startsWith('/assets/') ? '/assets/' : '';
    if (!prefix) return false;
    const base = prefix === '/character-references/'
      ? resolveCharRefRoot(appRoot, env, env.AI_WORKSPACE_ROOT) : assetsRoot;
    try {
      const suffix = decodeURIComponent(value.slice(prefix.length));
      const validationBase = base || path.join(appRoot, '.reference-validation');
      const candidate = path.resolve(validationBase, suffix);
      const relative = path.relative(validationBase, candidate);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || /[?#\0]/.test(suffix)) return false;
      if (prefix === '/character-references/' && structureOnly) return null;
      if (!base || !fs.existsSync(base)) return null;
      return fs.statSync(candidate).isFile();
    } catch { return false; }
  };
}

function buildReport({ characters, popularRows, standards, view, selectors, popularAliasMap, fileExists }) {
  const themes = analyseThemes({ characters, selectors, popularAliasMap });
  const references = analyseReferences({ popular: popularRows, standards, view, fileExists });
  const structuralErrors = [];
  for (const id of themes.dupCharacters) structuralErrors.push(`characters.json 重复角色 ID: ${id}`);
  for (const id of references.duplicateCharacters) structuralErrors.push(`热门分片跨文件重复角色 ID: ${id}`);
  for (const row of references.duplicateOutfits) structuralErrors.push(`热门分片重复服装 ID: ${row}`);
  for (const message of references.mirrorErrors) structuralErrors.push(`standards↔view 镜像破坏: ${message}`);
  structuralErrors.push(...references.duplicateRegistrations);
  return { version: 1, structuralErrors, reference: references, themes };
}

function popularAliasMapOf(popularCharacters) {
  const map = new Map();
  for (const character of popularCharacters) {
    for (const alias of [character.id, character.displayName, character.originalName, ...(character.aliases || [])]) {
      const key = normalizeAlias(alias);
      if (key && !map.has(key)) map.set(key, character.id);
    }
  }
  return map;
}

function printHuman(report) {
  const ref = report.reference;
  console.log(`[coverage] 热门服装→参考登记：缺登记 ${ref.missingRegistration.length}；登记未出图(pending) ${ref.pending.length}；URL 已填缺实图 ${ref.missingImage.length}；无法核实(素材根缺失) ${ref.unverifiedImage.length}；实图在位 ${ref.verifiedImage}；参考库独有形态 ${ref.referenceOnlyForms.length}`);
  const byChar = new Map();
  for (const row of ref.missingRegistration) {
    if (!byChar.has(row.id)) byChar.set(row.id, []);
    byChar.get(row.id).push(row.outfitId);
  }
  for (const [id, outfits] of [...byChar.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  缺登记 ${id} (${outfits.length}): ${outfits.join(', ')}`);
  }
  for (const row of ref.pending) console.log(`  pending ${row.id}/${row.outfitId}: ${row.pending}/${row.total} 视角待出图`);
  for (const row of ref.missingImage) console.log(`  缺实图 ${row.id}/${row.outfitId}/${row.refId}: ${row.url}`);
  for (const row of ref.unverifiedImage) console.log(`  未核实 ${row.id}/${row.outfitId}/${row.refId}: ${row.url}（素材根不存在于本机，见 check:ref-urls）`);
  const themes = report.themes;
  console.log(`[coverage] 角色→主题选择器：显式主题 ${themes.explicit.length}；默认主题允许 ${themes.defaultAllowed.length}（${themes.defaultAllowed.join(', ') || '无'}）；待补 ${themes.missingTheme.length}；旧别名选择器 ${themes.staleAlias.length}；未归类选择器 ${themes.nonCharacter.length}`);
  for (const row of themes.missingTheme) console.log(`  待补主题 ${row.id}（accent_color=${row.accentColor || '未登记'}）`);
  for (const row of themes.staleAlias) console.log(`  旧别名选择器 ${row.selector} → 建议 ${row.suggestion}（${row.note}）`);
  for (const row of themes.nonCharacter) console.log(`  未归类选择器 ${row.selector}（${row.note}）`);
  if (report.structuralErrors.length) {
    console.error(`[coverage] 结构错误 ${report.structuralErrors.length} 项：`);
    for (const message of report.structuralErrors) console.error(`  - ${message}`);
  }
}

function loadSources(root) {
  const shardsRoot = path.join(root, 'data', 'popular');
  const manifest = readJson(path.join(shardsRoot, 'manifest.json'));
  if (!Array.isArray(manifest?.files) || !manifest.files.length) throw new Error('manifest.files 必须为非空数组');
  const seenFiles = new Set();
  const seenCharacters = new Set();
  const sources = manifest.files.map((entry) => {
    if (typeof entry?.file !== 'string' || !entry.file) throw new Error('manifest 条目缺 file');
    const source = path.resolve(shardsRoot, entry.file);
    const relative = path.relative(shardsRoot, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('分片路径越界');
    if (seenFiles.has(source)) throw new Error(`重复分片文件: ${entry.file}`);
    seenFiles.add(source);
    const data = readJson(source);
    validateCharacters(data?.characters, entry.file, 'id');
    if (!Number.isInteger(entry.count) || entry.count !== data.characters.length) throw new Error(`manifest count 不符: ${entry.file}`);
    for (const character of data.characters) {
      if (seenCharacters.has(character.id)) throw new Error(`热门分片重复角色 ID: ${character.id}`);
      seenCharacters.add(character.id);
    }
    return { entry, characters: data.characters };
  });
  return { manifest, sources };
}

function validateCharacters(records, source, outfitKey) {
  if (!Array.isArray(records)) throw new Error(`${source} 角色必须为数组`);
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id.trim()) throw new Error(`${source} 角色缺有效 id`);
    if (!outfitKey) continue;
    if (!Array.isArray(record.outfits)) throw new Error(`${source}/${record.id} outfits 必须为数组`);
    for (const outfit of record.outfits) {
      if (!outfit || typeof outfit[outfitKey] !== 'string' || !outfit[outfitKey].trim()) throw new Error(`${source}/${record.id} 形态缺有效 ID`);
      if (outfitKey === 'outfitId' && (!Array.isArray(outfit.references) || outfit.references.some((r) => !r || typeof r !== 'object' || Array.isArray(r)))) {
        throw new Error(`${source}/${record.id} references 必须为对象数组`);
      }
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 && argv[rootIndex + 1]
    ? path.resolve(argv[rootIndex + 1])
    : path.resolve(process.env.AICS_DATA_ROOT || process.env.AICS_APP_ROOT || path.resolve(__dirname, '..', '..'));

  const structuralErrors = [];
  let manifest = null;
  let sources = [];
  try {
    if (rootIndex >= 0 && (!argv[rootIndex + 1] || argv[rootIndex + 1].startsWith('--'))) throw new Error('--root 需要目录');
    ({ manifest, sources } = loadSources(root));
  } catch (error) {
    console.error(`[coverage] 结构错误：${error.message}`);
    process.exitCode = 1;
    return;
  }

  let characters;
  let standards;
  let view;
  let cssText = '';
  try {
    characters = readJson(path.join(root, 'data', 'characters.json'));
    standards = readJson(path.join(root, 'data', 'character-reference-standards.json'));
    view = readJson(path.join(root, 'data', 'character-reference-view.json'));
    cssText = fs.readFileSync(path.join(root, 'src', 'assets', 'css', 'director', 'tokens.css'), 'utf8');
    validateCharacters(characters, 'characters.json');
    validateCharacters(standards?.characters, 'standards', 'id');
    if (!view || typeof view !== 'object' || Array.isArray(view)) throw new Error('view 根必须为对象');
    validateCharacters(Object.entries(view).map(([id, profile]) => ({ ...profile, id })), 'view', 'outfitId');
  } catch (error) {
    console.error(`[coverage] 结构错误：${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(characters)) { console.error('[coverage] 结构错误：characters.json 根必须是数组'); process.exitCode = 1; return; }

  // manifest 批次数核对（缺批号/批次数不符 → 结构错误）。
  for (const entry of manifest.files) {
    if (typeof entry.count !== 'number') structuralErrors.push(`data/popular/manifest.json 条目缺 count: ${entry.file}`);
  }

  // 每服装一行（含所属分片文件，供差额定位）；manifest 批次数另行核对。
  const rows = [];
  for (const { entry, characters: items } of sources) {
    for (const character of items) {
      for (const outfit of character.outfits || []) rows.push({ id: character.id, outfitId: outfit.id, file: entry.file });
    }
  }

  const standardsRows = standards.characters.map((c) => ({ id: c.id, outfitIds: (c.outfits || []).map((o) => o.id) }));
  const viewRows = Object.entries(view).map(([id, profile]) => ({
    id,
    outfits: (profile.outfits || []).map((o) => ({ outfitId: o.outfitId, references: o.references || [] })),
  }));

  const report = buildReport({
    characters,
    popularRows: rows,
    standards: standardsRows,
    view: viewRows,
    selectors: extractThemeSelectors(cssText),
    popularAliasMap: popularAliasMapOf(sources.flatMap(({ characters: items }) => items)),
    fileExists: makeFileExists({ appRoot: root, env: rootIndex >= 0 ? {
      AICS_CHARACTER_REF_ROOT: path.join(root, 'assets', 'character-references'),
      AICS_ASSETS_ROOT: path.join(root, 'assets'),
    } : process.env }),
  });
  report.structuralErrors.push(...structuralErrors);

  if (json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  process.exitCode = report.structuralErrors.length ? 1 : 0;
}

if (require.main === module) main();

module.exports = { analyseThemes, analyseReferences, extractThemeSelectors, normalizeAlias, popularAliasMapOf, buildReport, makeFileExists, DEFAULT_THEME_ALLOWED };
