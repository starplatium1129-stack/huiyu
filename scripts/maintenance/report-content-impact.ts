#!/usr/bin/env node
import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

import { PathLike } from 'node:fs';

// Read-only D2 slice. Never import builders: even their --check can self-heal.
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { isDeepStrictEqual }: typeof import('node:util') = require('node:util');
const { collectGitChanges, validateRevision }: typeof import('./content-impact-git') = require('./content-impact-git');
const { historyImpact }: typeof import('./content-impact-history') = require('./content-impact-history');
const { canonicalSceneId, localReader }: typeof import('../lib/content-history-reader') = require('../lib/content-history-reader');
const { referenceImpact }: typeof import('./content-impact-references') = require('./content-impact-references');
const { WORKFLOWS }: typeof import('../workflow') = require('../workflow');
const { formatImpactReport }: typeof import('../lib/content-impact-format') = require('../lib/content-impact-format');
const { extractThemeSelectors, DEFAULT_THEME_ALLOWED }: typeof import('./report-content-coverage') = require('./report-content-coverage');

const HELP = 'audit:impact [--character <canonical-id> [--outfit <id>]] [--scene <scNNN>] [--path <repo-relative-path>]... [--root <fixture-root>] [--json]\n只读报告；--path 接收明确 Git 变更路径（不自动读取 Git、不比较历史字段）。场景路径支持 data/scenes/<逻辑组.json 或实际批次.N.json>，按当前 manifest 展开。\n--plan 与 --help 仅展示用法，不读取数据。退出码 0=报告（可能有未知范围），1=结构问题，2=参数错误。';

function parse(argv: any) {
  const opts: any = { paths: [], showcaseManifests: [], root: path.resolve(process.env.AICS_DATA_ROOT || process.env.AICS_APP_ROOT || path.join(__dirname, '../..')) };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--git-diff') { opts.gitDiff = true; continue; }
    if (!['--root', '--base', '--character', '--outfit', '--scene', '--path', '--showcase-manifest'].includes(arg)) throw new Error(`未知参数 ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
    if (arg === '--path' || arg === '--showcase-manifest') {
      const normalized: any = value.replace(/\\/g, '/');
      if (path.posix.isAbsolute(normalized) || /[:\x00]/.test(normalized) || normalized.split('/').some((p: string) => p === '..' || !p)) throw new Error(`${arg} 必须为仓库相对路径`);
      (arg === '--path' ? opts.paths : opts.showcaseManifests).push(normalized.replace(/^\.\//, ''));
    } else {
      const key = arg.slice(2);
      if (key !== 'root' && opts[key]) throw new Error(`${arg} 不可重复`);
      opts[key] = value;
    }
  }
  if (opts.outfit && !opts.character) throw new Error('--outfit 必须同时指定 --character');
  if (opts.scene && !canonicalSceneId(opts.scene)) throw new Error('--scene 必须为 canonical scNNN 或 sc1000+，不接受 sc0001 等冗余前导零');
  if (opts.base) validateRevision(opts.base);
  if (!opts.character && !opts.scene && !opts.paths.length && !opts.gitDiff && !opts.base) throw new Error('需要 --character、--scene、--path、--git-diff 或 --base');
  opts.root = path.resolve(opts.root);
  return opts;
}

const isScenePath = (file: string) => file.startsWith('data/scenes/')
  || ['data/scenes.json', 'data/curation.json', 'data/retired-scenes.json'].includes(file);
const validId = (id: string) => typeof id === 'string' && Boolean(id.trim());

function sceneImpact(opts: any, result: any, add: any, recommend: any) {
  const directory = 'data/scenes/';
  const manifestFile = `${directory}manifest.json`;
  const aggregateFile = 'data/scenes.json';
  const curationFile = 'data/curation.json';
  const retiredFile = 'data/retired-scenes.json';
  // Do not use scene-store/builders: their roots are process-global and builders may write.
  const localPath = (file: string) => {
    const root = fs.realpathSync(opts.root);
    const real = fs.realpathSync(path.join(root, file));
    const relative = path.relative(root, real);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${file}: 真实路径超出 --root`);
    return real;
  };
  const read = (file: string) => JSON.parse(fs.readFileSync(localPath(file), 'utf8'));
  const groups = new Map();
  const rows: any[] = [];
  let complete = true;
  const sourceProblem = (file: string, reason: string) => {
    complete = false;
    add('mustChange', 'scene-source', file, `${reason}（全域源清单检查，未归因于当前输入）`);
  };
  try {
    const manifest = read(manifestFile);
    if (!Array.isArray(manifest?.files) || !manifest.files.length) throw new Error('manifest.files 必须为非空逻辑组数组');
    const declared = new Set();
    for (const entry of manifest.files) {
      if (!entry || !/^[a-zA-Z0-9_-]+\.json$/.test(entry.file) || entry.file === 'manifest.json' || declared.has(entry.file)) throw new Error('非法或重复逻辑组路径');
      declared.add(entry.file);
    }
    const names = fs.readdirSync(localPath(directory));
    const managed = new Set(['manifest.json']);
    for (const entry of manifest.files) {
      const base = entry.file.slice(0, -5);
      const batches = names.filter((name: any) => name.startsWith(`${base}.`) && /^\.\d+\.json$/.test(name.slice(base.length)))
        .sort((a: any, b: any) => Number(a.slice(base.length + 1, -5)) - Number(b.slice(base.length + 1, -5)));
      const group: any = { entry, files: batches.length ? batches : [entry.file], rows: [], ok: false };
      groups.set(`${directory}${entry.file}`, group);
      for (const file of [entry.file, ...batches]) managed.add(file);
      try {
        if (batches.length) {
          if (names.includes(entry.file)) throw new Error('单文件与批次并存，无法确定完整源边界');
          if (batches.some((file: any, index: any) => file !== `${base}.${index + 1}.json`)) throw new Error('批次缺号或编号不规范，不能把连续前缀当作完整源');
        } else if (!names.includes(entry.file)) throw new Error('manifest 声明的源不存在，删除/重命名未知');
        const loaded: any[] = [];
        for (const file of group.files) {
          const records = read(`${directory}${file}`);
          if (!Array.isArray(records) || records.some((scene: any) => !scene || !validId(scene.id))) throw new Error(`${file}: 源须为含有效场景 ID 的数组`);
          for (const value of records) loaded.push({ file: `${directory}${file}`, group: `${directory}${entry.file}`, entry, value });
        }
        group.rows = loaded;
        group.ok = true;
        rows.push(...loaded);
      } catch (error) { sourceProblem(`${directory}${entry.file}`, runtimeErrorMessage(error)); }
    }
    for (const name of names) {
      if (name.endsWith('.json') && !managed.has(name)) sourceProblem(`${directory}${name}`, '源文件未在当前 manifest 逻辑组登记，不读取其中场景');
    }
  } catch (error) { sourceProblem(manifestFile, runtimeErrorMessage(error)); }
  if (!complete) result.unknown.push('场景源读取不完整或展开有歧义；不能证明不存在的 ID、删除/重命名或全域源/聚合一致性，未从旧聚合推断关系。');

  const selected = new Set(opts.scene ? [opts.scene] : []);
  for (const file of opts.paths.filter(isScenePath)) {
    if (file === curationFile || file === retiredFile) continue;
    const logical = groups.get(file);
    const group = logical || [...groups.values()].find((item: any) => item.files.some((name: any) => `${directory}${name}` === file));
    if (!group?.ok) {
      result.unknown.push(`${file}: 未解析路径、未登记/已删除/重命名或源不完整；不能从聚合推断影响边界`);
      continue;
    }
    const matches = logical ? group.rows : group.rows.filter((row: any) => row.file === file);
    for (const row of matches) selected.add(row.value.id);
    add('revalidate', 'scene-source', file, logical ? '逻辑组按当前 manifest 展开，纳入全部当前批次场景' : '精确匹配实际批次，仅纳入该文件当前场景');
    result.unknown.push(`${file}: 仅有当前路径${matches.length ? '' : '（当前为空）'}，历史删除/重命名及字段差异 unknown，不能证明历史影响为空。`);
  }

  const readMetadata = (file: string, validate: any, shape: string|undefined) => {
    try {
      const value = read(file);
      if (!validate(value)) throw new Error(shape);
      return value;
    } catch (error) {
      result.unknown.push(`${file}: 不可解析，相关状态 unknown（${runtimeErrorMessage(error)}）`);
      if (runtimeErrorCode(error) !== 'ENOENT') add('mustChange', 'scene-metadata', file, runtimeErrorMessage(error));
      return null;
    }
  };
  const aggregate = readMetadata(aggregateFile, (value: any) => Array.isArray(value) && value.every((scene: any) => scene && validId(scene.id)), '聚合须为含有效场景 ID 的数组');
  const curation = readMetadata(curationFile, (value: any) => value && typeof value === 'object' && !Array.isArray(value), '精选须为对象');
  const retired = readMetadata(retiredFile, (value: any) => Array.isArray(value?.records) && value.records.every((record: any) => record && validId(record.id)), '退役表须有含有效 ID 的 records 数组');
  const tiers: Record<string, any> = {};
  for (const key of ['curatedSceneIds', 'signatureSceneIds', 'personaCoreSceneIds']) {
    const ids = curation?.[key];
    tiers[key] = Array.isArray(ids) && ids.every(validId) ? ids : null;
    if (curation && !tiers[key]) result.unknown.push(`${curationFile}#${key}: 缺少可解析 ID 数组，不能视为未入选。`);
  }
  for (const [file, domain, ids] of [
    [curationFile, 'curation-source', Object.values(tiers).every(Array.isArray) ? Object.values(tiers).flat() : null],
    [retiredFile, 'retired-source', retired ? retired.records.map((record: any) => record.id) : null],
  ]) {
    if (!opts.paths.includes(file)) continue;
    result.unknown.push(`${file}: 仅选择当前合法登记 ID；历史删除记录、重命名及字段差异 unknown，不能证明历史影响为空。`);
    if (!ids) {
      add('revalidate', domain, file, '显式元数据缺失或损坏，影响边界 unknown；不使用部分记录或聚合补回 ID');
      add('mustChange', domain, file, '显式元数据无法完整解析，需恢复可验证的当前登记');
      continue;
    }
    for (const id of ids) selected.add(id);
    add('related', domain, file, '当前登记源；不证明历史变更范围');
    add('revalidate', domain, file, '复验当前登记及其展示/退役关系，未执行；空登记也不证明无历史影响');
    if (file === retiredFile) for (const id of new Set(ids)) {
      add('revalidate', 'retired-scene', `${file}#${id}`, '当前退役 ID，需复验退役引用及产物状态；历史源归属未知');
    }
  }
  result.scenes = [];
  for (const id of selected) {
    const sources = rows.filter((row: any) => row.value.id === id);
    const products = aggregate?.filter((scene: any) => scene.id === id);
    const records = retired?.records.filter((record: any) => record.id === id);
    const item: any = {
      id,
      sourceStatus: sources.length > 1 ? 'ambiguous' : !complete ? 'unknown' : sources.length ? 'present' : 'absent',
      sources: sources.map((row: any) => ({ file: row.file, group: row.group })),
      aggregate: { file: aggregateFile, status: 'unknown' },
      curation: {},
      retirement: { status: records ? records.length ? 'retired' : 'not-listed' : 'unknown', records: records || [] },
    };
    result.scenes.push(item);
    if (!sources.length) result.unknown.push(`${id}: 当前可读源中无此 ID；历史源归属、删除/重命名 unknown，未从聚合补回源关系。`);
    if (sources.length > 1) add('mustChange', 'scene', id, '当前源重复 ID，源归属歧义，不能选择其中一条作为权威记录');
    for (const source of sources) {
      add('related', 'scene-source', `${source.file}#${id}`, `当前源；逻辑组 ${source.group} 由 ${manifestFile} 声明`);
      add('revalidate', 'scene', `${source.file}#${id}`, '目标场景编译/画面需按实际变更复验，未执行');
      if (source.value.char && source.entry.character && source.value.char !== source.entry.character) add('mustChange', 'scene', `${source.file}#${id}`, '场景 char 与逻辑组 character 归属冲突');
    }
    const productProblem = (status: string, reason: string) => {
      item.aggregate.status = status;
      add('mustChange', 'scene-aggregate', `${aggregateFile}#${id}`, reason);
      recommend('data:build');
    };
    if (products) {
      if (products.length > 1) productProblem('duplicate', '目标场景在聚合中重复');
      else if (sources.length === 1) {
        if (!products.length) productProblem('missing', '当前源目标未进入数组聚合，源/聚合失配');
        else if (!isDeepStrictEqual(sources[0].value, products[0])) productProblem('mismatch', '目标场景源/聚合内容失配（仅比较目标，未归因于本次输入）');
        else item.aggregate.status = complete ? 'current' : 'unknown';
      } else if (!sources.length && complete) {
        if (products.length) productProblem('stale', '聚合残留当前源不存在的目标；不能据此推断已删除/重命名场景的源归属');
        else item.aggregate.status = 'absent';
      }
    } else if (sources.length) {
      add('revalidate', 'scene-aggregate', `${aggregateFile}#${id}`, '聚合不可读取，需复验目标产物；未运行构建');
      recommend('data:build');
    }
    if (sources.length || products?.length) add('related', 'scene-aggregate', `${aggregateFile}#${id}`, `数组聚合，目标比较状态 ${item.aggregate.status}；不是源归属依据`);
    if (records?.length) {
      add('related', 'retired-scene', `${retiredFile}#${id}`, '当前退役登记；登记不提供历史源归属');
      if (sources.length) add('mustChange', 'retired-scene', `${retiredFile}#${id}`, '已登记退役的 ID 仍存在当前源，活跃/退役状态冲突');
    }
    for (const [key, ids] of Object.entries(tiers)) {
      item.curation[key] = ids ? ids.includes(id) ? 'included' : 'not-listed' : 'unknown';
      if (!ids?.includes(id)) continue;
      const object = `${curationFile}#${key}/${id}`;
      add('related', 'curation', object, `当前 ${key} 显式成员；三个层级分别读取，不推断包含关系或审核通过`);
      add('revalidate', 'curation', object, '精选展示/排序及既有审核证据需按实际变更复验，未执行');
      if (records?.length) add('mustChange', 'curation', object, '精选层引用已登记退役的场景');
      else if (!sources.length && complete) add('mustChange', 'curation', object, '精选层引用当前源不存在的场景（悬空引用）');
      if (ids.filter((value: any) => value === id).length > 1) add('mustChange', 'curation', object, '目标场景在同一精选层重复登记');
    }
  }
  result.unknown.push('场景比较仅覆盖所选 ID 的数组聚合内容；未验证全域聚合顺序、按角色浏览器分片、核心/索引产物、精选审核真实性及其他场景引用域。');
}

function themeImpact(opts: { root: PathLike; }, selected: any, result: any, add: any) {
  const file = 'src/assets/css/director/tokens.css';
  const readLocal = (name: string) => {
    const root = fs.realpathSync(opts.root);
    const real = fs.realpathSync(path.join(root, name));
    const relative = path.relative(root, real);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${name}: 真实路径超出 --root`);
    return fs.readFileSync(real, 'utf8');
  };
  let selectors: Set<any>;
  let dynamic = false;
  let cssError: string;
  let canonical: any;
  let dataError: string;
  try {
    // Parse rules, not comments/declaration strings; syntax errors cannot prove absence.
    const css = (require('postcss') as typeof import('postcss')).parse(readLocal(file), { from: file });
    selectors = new Set();
    css.walkRules((rule: any) => {
      const normalized = rule.selector.replace(/\[\s*data-character\s*=\s*(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))\s*\]/g,
        (_: any, double: any, single: any, bare: any) => `[data-character="${double || single || bare}"]`);
      for (const id of extractThemeSelectors(normalized)) selectors.add(id);
      // Unsupported attribute syntax (escapes/flags/operators) prevents a missing claim.
      if (normalized.replace(/\[data-character="[A-Za-z0-9_-]+"\]|\[\s*data-character\s*\]/g, '').includes('data-character')) throw new Error('存在无法安全解析的 data-character 选择器');
    });
    if (!css.nodes.some((node: any) => node.type === 'rule' || node.type === 'atrule')) throw new Error('CSS 无可解析规则');
    dynamic = selectors.has('*');
  } catch (error) { cssError = `${file}: 不可解析（${runtimeErrorMessage(error)}）`; }
  try {
    const records = JSON.parse(readLocal('data/characters.json'));
    if (!Array.isArray(records) || records.some((row: any) => !row || !validId(row.id)) || new Set(records.map((row: any) => row.id)).size !== records.length) throw new Error('canonical 角色须为有效且不重复 ID 的数组');
    canonical = new Set(records.map((row: any) => row.id));
  } catch (error) { dataError = `data/characters.json: 不可解析（${runtimeErrorMessage(error)}）`; }
  result.themes = [...selected].map((id: any) => {
    const theme: any = { id, file, canonical: canonical ? canonical.has(id) : null, themeStatus: 'unknown', reason: '' };
    if (cssError) theme.reason = cssError;
    else if (dynamic || selectors.has(id)) {
      theme.themeStatus = 'explicit';
      theme.selector = dynamic ? '[data-character]' : `[data-character="${id}"]`;
      theme.reason = dynamic
        ? '当前 CSS 使用运行时 data-character 主题契约；配色来自 characters.json/运行时令牌，不证明实际画面'
        : '当前 CSS 有显式角色选择器；不证明层叠、配色或实际画面';
      add('related', 'theme', `${file}#${id}`, theme.reason);
      add('revalidate', 'theme', `${file}#${id}`, '角色主题关联；按实际变更复验双主题、对比度及画面，未执行');
    } else if (DEFAULT_THEME_ALLOWED.includes(id)) {
      theme.themeStatus = 'default';
      theme.reason = '默认主题白名单（与 audit:coverage 共用）；未验证实际渲染';
      add('related', 'theme', `${file}#${id}`, theme.reason);
    } else if (dataError) theme.reason = dataError;
    else if (!canonical.has(id)) theme.reason = '不在 canonical 档案中；外部热门角色/别名主题归属未知，不要求新增主题';
    else {
      theme.themeStatus = 'missing';
      theme.reason = 'canonical 角色缺少显式主题，且不在默认主题白名单';
      add('mustChange', 'theme', `${file}#${id}`, theme.reason);
    }
    if (theme.themeStatus === 'unknown') result.unknown.push(`${id}: 主题 unknown；${theme.reason}`);
    return theme;
  });
}

function outfitDefault(rows: any, id: any) {
  const item: any = { id, status: 'unknown', defaultOutfit: null, defaultIds: [], isDefaultIds: [], reasons: [] };
  if (rows.length !== 1 || !Array.isArray(rows[0].value.outfits)) {
    item.reasons.push('热门身份或 outfits 数组无法唯一确认');
    return item;
  }
  const outfits = rows[0].value.outfits;
  const fields = ['default', 'isDefault'];
  const marked = fields.map((key: any) => outfits.filter((o: { [x: string]: boolean; }) => o?.[key] === true));
  [item.defaultIds, item.isDefaultIds] = marked.map((list: any) => list.map((o: any) => o.id ?? null));
  const problems: any[] = [];
  if (marked.some((list: any) => list.length > 1)) problems.push(['ambiguous', '同一字段标记多个默认项']);
  if (marked.flat().some((o: any) => !validId(o.id))) problems.push(['missing', '默认项 ID 缺失或无效']);
  if (marked.flat().some((o: any) => validId(o.id) && outfits.filter((v: any) => v?.id === o.id).length > 1)) problems.push(['ambiguous', '默认 ID 在角色内重复，无法唯一解析']);
  if (outfits.some((o: any) => fields.every((key: any) => typeof o?.[key] === 'boolean') && o.default !== o.isDefault)) problems.push(['mismatch', 'default 与 isDefault 字段集合冲突']);
  const complete = outfits.length > 0 && outfits.every((o: any) => fields.every((key: any) => typeof o?.[key] === 'boolean'));
  if (complete && marked.some((list: any) => !list.length)) problems.push(['missing', '完整双字段中无默认项']);
  if (problems.length) {
    item.status = problems[0][0];
    item.reasons = problems.map(([, reason]: any) => reason);
  } else if (!complete) item.reasons.push('默认字段缺失、非布尔值或空列表；旧格式无法证明默认语义');
  else {
    item.status = 'explicit';
    item.defaultOutfit = marked[0][0].id;
    item.reasons.push('两字段集合一致，恰好一个默认项且 ID 唯一有效');
  }
  return item;
}

function showcaseImpact(opts: any, result: any, add: any) {
  const files: string[] = [...new Set<string>(opts.showcaseManifests || [])];
  result.showcase = { status: 'unknown', manifests: [] };
  if (!files.length) {
    result.unknown.push('样张清单在外部/未提供');
    return;
  }
  for (const file of files) {
    const item: any = { file, status: 'unknown', entries: [] };
    result.showcase.manifests.push(item);
    try {
      const normalized = file.replace(/\\/g, '/');
      if (path.posix.isAbsolute(normalized) || normalized.includes(':') || normalized.split('/').some((p: string) => p === '..' || !p)) throw new Error('manifest 必须为 root 内相对路径');
      const root = fs.realpathSync(opts.root);
      const real = fs.realpathSync(path.resolve(root, normalized));
      const relative = path.relative(root, real);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('manifest 真实路径超出 --root');
      if (!fs.statSync(real).isFile()) throw new Error('manifest 必须为普通文件');
      const manifest = JSON.parse(fs.readFileSync(real, 'utf8'));
      const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
      if (!object(manifest) || !Array.isArray(manifest.entries) || manifest.entries.some((entry: any) => !object(entry)
        || !validId(entry.id) || ['type', 'char'].some((key: any) => entry[key] !== undefined && typeof entry[key] !== 'string'))) throw new Error('manifest.entries 必须为含有效 id 与可解析 type/char 的对象数组');
      item.status = 'parsed';
      manifest.entries.forEach((entry: any, index: any) => {
        const matchedBy: any[] = [];
        if (opts.scene && entry.id === opts.scene) matchedBy.push('scene');
        if (opts.character && (entry.char === opts.character || entry.type === opts.character)) matchedBy.push('character');
        if (!matchedBy.length) return;
        const scalar = (value: any) => ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
        item.entries.push({ index, id: entry.id, type: scalar(entry.type), char: scalar(entry.char),
          rating: scalar(entry.rating), attempt: scalar(entry.attempt),
          reviewPresent: object(entry.provenance) && Object.hasOwn(entry.provenance, 'review'), matchedBy });
        const target = `${file}#entries/${index}`;
        add('related', 'showcase', target, `样张登记 ${entry.id}；仅匹配显式目标，review 字段存在不代表审核通过`);
        add('revalidate', 'showcase', target, '样张与目标关联，按实际变更复验；未读取图片或执行生成、审核、发布');
      });
      result.unknown.push(`${file}: 仅解析所提供 entries，完整性未知；${item.entries.length ? '匹配项不证明画面质量或审核有效性' : '未匹配目标不能证明缺少样张，不列为必改'}。`);
    } catch (error) {
      item.status = 'error';
      item.reason = runtimeErrorMessage(error);
      add('mustChange', 'showcase-manifest', file, `显式清单无法安全解析：${runtimeErrorMessage(error)}`);
      result.unknown.push(`${file}: 样张关系 unknown，不能推断缺失条目`);
    }
  }
  result.showcase.status = result.showcase.manifests.some((item: { status: string; }) => item.status === 'error') ? 'error' : 'partial';
}

function report(opts: any) {
  if (opts.base) return historyImpact(opts, undefined);
  const result: any = { version: 1, readOnly: true, input: { character: opts.character || null, outfit: opts.outfit || null, scene: opts.scene || null, paths: opts.paths }, mustChange: [], revalidate: [], related: [], unknown: [], recommendations: [] };
  const add = (level: string, domain: string, object: string, reason: string) => result[level].push({ domain, object, reason });
  if (opts.gitDiff) {
    result.gitChanges = collectGitChanges(opts.root);
    if (result.gitChanges.status === 'error') {
      add('mustChange', 'git', '--git-diff', result.gitChanges.reason);
      result.unknown.push('Git 变更路径采集失败，未使用部分结果；显式输入仍独立分析。');
    }
    opts = { ...opts, paths: [...new Set([...opts.paths, ...result.gitChanges.paths])] };
  }
  let currentReader;
  const read = (file: string) => { currentReader ||= localReader(opts.root); return currentReader.json(file); };
  const recommend = (name: string) => {
    const def = WORKFLOWS[name];
    if (!def) throw new Error(`未注册推荐入口 ${name}`);
    if (!result.recommendations.some((r: any) => r.name === name)) result.recommendations.push({ name, argv: ['node', 'scripts/workflow.js', name], nature: def.run.nature, executed: false });
  };
  function shards(domain: string, key: string, aggregate: string, version: number) {
    try {
      const manifest = read(`data/${domain}/manifest.json`);
      if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('manifest.files 缺失或为空');
      const files = new Set();
      const ids = new Set();
      const rows: any[] = [];
      for (const entry of manifest.files) {
        if (typeof entry.file !== 'string' || !/^[\w.-]+\.json$/.test(entry.file) || files.has(entry.file)) throw new Error('非法或重复分片路径');
        files.add(entry.file);
        const file = `data/${domain}/${entry.file}`;
        const records = read(file)[key];
        if (!Array.isArray(records)) throw new Error(`${file}: ${key} 必须为数组`);
        if (!Number.isInteger(entry.count) || entry.count !== records.length) add('mustChange', domain, file, 'manifest count 缺失或不匹配');
        for (const value of records) {
          if (!value || typeof value.id !== 'string' || !value.id.trim()) throw new Error(`${file}: 缺失有效 ID`);
          if (ids.has(value.id)) add('mustChange', domain, value.id, '重复 ID，关联可能歧义');
          ids.add(value.id);
          rows.push({ file, value });
        }
      }
      try {
        if (!isDeepStrictEqual(read(aggregate), { version, [key]: rows.map((r: any) => r.value) })) {
          add('mustChange', domain, aggregate, '源/聚合内容失配（全域快照检查，未断言由本次输入造成）');
          recommend(domain === 'popular' ? 'popular:build' : 'blueprints:build');
        }
      } catch (error) { add('mustChange', domain, aggregate, `产物不可读取：${runtimeErrorMessage(error)}`); }
      return rows;
    } catch (error) {
      add('mustChange', domain, `data/${domain}`, runtimeErrorMessage(error));
      result.unknown.push(`${domain} 源读取不完整，未从旧聚合推断关系`);
      return null;
    }
  }
  const characterScope = opts.character || opts.paths.some((file: any) => !isScenePath(file));
  const popular = characterScope ? shards('popular', 'characters', 'data/popular-characters.json', 1) : null;
  const blueprints = characterScope ? shards('blueprints', 'blueprints', 'data/scene-blueprints.json', 2) : null;
  const selected = new Set(opts.character ? [opts.character] : []);
  for (const file of opts.paths) {
    if (isScenePath(file)) continue;
    if (file === 'src/assets/css/director/tokens.css') add('revalidate', 'theme', file, '主题文件路径变化，需复验双主题及对比度；无法由路径确定受影响角色或样式语义');
    if (file === 'scripts/workflow.js' || file === 'docs/workflow.md') add('revalidate', 'workflow', file, '工作流路径变化，需复核入口与文档；无法由路径推断行为差异');
    const matches = [...(popular || []), ...(blueprints || [])].filter((r: any) => r.file === file);
    for (const row of matches) selected.add(row.value.characterId || row.value.id);
    if (matches.length) add('revalidate', 'source', file, '仅有路径，保守纳入该分片全部角色；无法判断字段、删除或重命名');
    else result.unknown.push(`${file}: 未解析的路径或已删除/空分片；不能证明影响边界`);
    if (/^scripts\/lib\/|^scripts\/maintenance\/build-|^scripts\/workflow\.js$/.test(file)) recommend('data:validate');
  }
  const byId = new Map((popular || []).map((r: any) => [r.value.id, r]));
  result.outfitDefaults = [...selected].map((id: any) => outfitDefault((popular || []).filter((r: any) => r.value.id === id), id));
  for (const item of result.outfitDefaults) {
    if (item.status === 'unknown') result.unknown.push(`${item.id}: 默认服装 unknown；${item.reasons.join('；')}`);
    else if (item.status !== 'explicit') for (const reason of item.reasons) add('mustChange', 'outfit-default', item.id, reason);
  }
  if (selected.size) themeImpact(opts, selected, result, add);
  referenceImpact(opts, selected, result, add);
  for (const id of selected) {
    const row = byId.get(id);
    if (!row) { result.unknown.push(`${id}: 当前热门源中不存在；档案角色、别名、退役或删除未解析`); continue; }
    add('related', 'popular', `${row.file}#${id}`, '权威身份/服装源；关联不等于必须重写');
    const outfits = row.value.outfits;
    if (!Array.isArray(outfits)) { add('mustChange', 'outfit', id, 'outfits 元数据缺失'); continue; }
    const ids = outfits.map((o: any) => o?.id);
    if (ids.some((v: any) => typeof v !== 'string' || !v) || new Set(ids).size !== ids.length) add('mustChange', 'outfit', id, '服装 ID 缺失或角色内重复');
    if (opts.outfit && !ids.includes(opts.outfit)) result.unknown.push(`${id}/${opts.outfit}: 当前源无此服装，仍检索显式蓝图引用`);
    for (const bp of blueprints || []) {
      if (bp.value.characterId !== id) continue;
      if (bp.value.outfitId && !ids.includes(bp.value.outfitId)) add('mustChange', 'blueprint', `${bp.file}#${bp.value.id}`, `悬空服装引用 ${id}/${bp.value.outfitId}`);
      if (!opts.outfit || bp.value.outfitId === opts.outfit || !bp.value.outfitId) {
        const defaultInfo = result.outfitDefaults.find((item: any) => item.id === id);
        const reason = bp.value.outfitId ? '显式角色/服装引用；需复核编译和画面，未执行'
          : defaultInfo.status === 'explicit' ? `服装省略，解析默认服装 ${id}/${defaultInfo.defaultOutfit}；需复验编译和画面，未执行`
            : '服装省略，默认服装解析 unknown，不能猜测第一项';
        add('revalidate', 'blueprint', `${bp.file}#${bp.value.id}`, reason);
        if (!bp.value.outfitId && defaultInfo.status !== 'explicit') result.unknown.push(`${bp.file}#${bp.value.id}: ${reason}`);
      }
    }
  }
  if (popular && blueprints) for (const bp of blueprints) {
    if (!byId.has(bp.value.characterId)) add('mustChange', 'blueprint', `${bp.file}#${bp.value.id}`, '未知角色引用（全域快照检查）');
  }
  if (opts.scene || opts.paths.some(isScenePath)) sceneImpact(opts, result, add, recommend);
  showcaseImpact(opts, result, add);
  recommend('data:validate');
  if (characterScope) recommend('audit:coverage');
  result.unknown.push('场景关系仅由 --scene 或明确场景源路径展开，不从热门角色/服装推断；主题仅覆盖所选角色在 tokens.css 通用选择器与 runtime characterTheme.ts 的关系，样张仅匹配显式 manifest 与 scene/character 目标，未验证 DATA_VERSION、压缩产物及历史删除/重命名。', '仅比较当前源与聚合的 JSON 内容；不运行推荐命令，不证明增量检查边界或真实渲染质量。');
  return result;
}

function main(argv: any = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('--plan')) { console.log(`${HELP}\n--base <local-commit/ref> 显式比较本地基线与当前工作树，按稳定 ID 追踪字段/删除/移动及旧新关系，生成只读增量计划；未知/全局约束要求 full，默认预览且不执行命令。与显式目标组合时不会过滤掉其他历史差异。\n--scene 支持 sc001、sc1000；拒绝 sc0001。\n--git-diff 显式只读采集 root Git 工作树 staged/unstaged/untracked 路径，与其他输入组合；失败退出 1。\n--showcase-manifest <root内相对路径> 可重复（建议单个），只读解析 entries 安全元数据；不读取图片。`); return 0; }
  let opts;
  try { opts = parse(argv); } catch (error) {
    console.log(argv.includes('--json') ? JSON.stringify({ version: 1, error: runtimeErrorMessage(error) }) : runtimeErrorMessage(error));
    return 2;
  }
  const output: any = report(opts);
  let human = '';
  if (!opts.json) {
    try { human = formatImpactReport(output); } catch { human = '影响报告渲染失败；请使用 --json 查看结构化结果。'; }
  }
  console.log(opts.json ? JSON.stringify(output, null, 2) : human);
  return output.mustChange.length ? 1 : 0;
}
if (require.main === module) process.exitCode = main();
export = { parse, report, main };
