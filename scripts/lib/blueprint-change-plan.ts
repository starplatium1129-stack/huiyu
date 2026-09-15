import { errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

/**
 * scripts/lib/blueprint-change-plan.js — 蓝图分片变更纯规划器（G12）
 *
 * 背景（scripts/archive/task-07-blueprint-save-verification.md）：蓝图保存路由只覆写
 * 聚合 data/scene-blueprints.json，源分片 data/blueprints/*.json 不随之更新，网关启动
 * 自愈（ensure-data-build）会从源分片重建聚合，覆盖刚保存的内容。本模块为后续保存
 * 事务修复提供规划核心：输入当前状态与完整目标集合，输出下一个 manifest、聚合产物
 * 与明确的分片 writes/deletes/unchanged 计划；是否落盘、写入顺序与回滚由调用方决定。
 *
 * 纯函数边界：本模块零 require（不引入 fs/path、不读环境变量、不执行命令），
 * 不自动应用计划；对全部输入只读，从不修改 manifest、shards、blueprints、mapping。
 *
 * planBlueprintChanges(input) 输入：
 * - manifest: 当前 data/blueprints/manifest.json 的解析对象；files 须为数组（可为空，
 *   仅用于引导态；当前读取器不接受空 manifest 作为已落盘状态）。每个条目须含安全的
 *   分片 JSON 基名 file（拒绝 traversal/绝对路径/分隔符/manifest.json）与非空 franchise。
 * - shards: 「分片文件名 → { text, data }」的 Map 或普通对象，与 manifest.files 一一
 *   对应（缺片、未声明分片均报错）：text 为磁盘原始文本，data 必须等于 JSON.parse(text)，
 *   data.franchise 须与 manifest 条目一致（冲突即报错，不静默合并），data.blueprints
 *   须为数组且各蓝图有非空、全局唯一的 id。
 * - blueprints: 完整目标集合（保存语义：缺失的即下架）。每项须为对象，含非空字符串
 *   id（全局唯一）与非空字符串 characterId；空数组整体拒绝（会产生当前读取器不接受的
 *   空 manifest）。
 * - franchiseByCharacter: 「characterId → franchise」的 Map 或普通对象。目标中出现的
 *   角色必须解析出非空且非 unknown 的 franchise；未知角色或无法确认时明确报错，
 *   不自动归入 unknown 建片。franchise 匹配区分大小写。
 *
 * 返回：
 * - manifest: { data, text, changed } — 下一 manifest。保留输入 manifest 的其他字段与
 *   条目扩展字段，沿用既有条目的文件名与顺序，count 按目标精确更新；text 为 jsonText
 *   格式（2 空格缩进 + 结尾换行）；changed 表示与输入 manifest 结构不同（含计数修正）。
 * - aggregate: { data, text } — { version: 2, blueprints }，blueprints 按下一 manifest
 *   顺序拼接，text 与 blueprint-store.writeBlueprintAggregate 重建结果字节一致。
 * - writes: [{ file, franchise, count, kind: 'create'|'update', data, text }] — 按下一
 *   manifest 顺序；text 应写入 data/blueprints/<file>，与现有 jsonText 格式兼容。
 * - deletes: [{ file, franchise }] — 仅限输入 manifest 声明的已知片（目标中已清空的
 *   franchise），按既有 manifest 顺序；压缩伴生文件与聚合落盘由调用方协议处理。
 * - unchanged: [{ file, franchise, count }] — 解析内容未变化的分片；调用方应保留其
 *   原始字节，不因格式差异重写。deletes 与 writes 不共享同一路径（新系列文件名冲突
 *   检查包含本次将被删除的既有文件名，如需复用同名文件请分两次保存）。
 * - summary: { writes, deletes, unchanged, blueprints, franchises }；
 *   dirty — 是否存在任何需要的落盘动作（含 manifest 计数修正）。
 *
 * 关键语义：
 * - 同一 franchise 沿用既有 manifest 条目的文件名与顺序；新 franchise 按目标首次出现
 *   顺序追加，文件名用 popular-store 的 franchiseSlug 规则生成并做冲突检查（与现有
 *   分片大小写不敏感冲突、与其他新系列冲突、Windows 保留设备名、manifest.json、
 *   slug 退化为 unknown 均拒绝）。
 * - 组内顺序与条目字段完全以目标为准，不改写内容、评级或绑定；跨 franchise 移动
 *   表现为旧片移除、新片加入。
 * - 未变化分片按解析内容判断（JSON.stringify 逐条一致），保留原始字节；变化分片
 *   输出 { version: 2, franchise, blueprints } 的 jsonText 文本。
 */

/** franchise → 分片文件名 slug。逐字复制 popular-store.js 的 franchiseSlug：
 *  本模块不 require 任何带 fs/环境读取的模块，测试用原函数对拍防止漂移。 */
function franchiseSlug(franchise: any) {
  const slug = String(franchise || 'unknown')
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unknown';
}

/** 与 blueprint-store.jsonText 相同的序列化格式（2 空格缩进 + 结尾换行）。 */
function jsonText(value: any) {
  return JSON.stringify(value, null, 2) + '\n';
}

class BlueprintChangePlanError extends Error {
    problems!: any;
constructor(problems: any[]) {
    super('蓝图变更规划失败: ' + problems.join('；'));
    this.name = 'BlueprintChangePlanError';
    this.problems = Object.freeze(problems.slice());
  }
}

// 安全分片基名：仅字母数字与 . _ -，须以字母数字开头、.json 结尾；
// 不含任何分隔符/盘符，故 traversal 与绝对路径均不可能构造。
const SHARD_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const RESERVED_LOWER_FILE_NAMES = new Set(['manifest.json']);
// franchiseSlug 只会产生小写字母数字与连字符，可能撞上这些 Windows 保留设备名。
const WINDOWS_RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

function isMapping(value: any) {
  return value instanceof Map
    || (value !== null && typeof value === 'object' && !Array.isArray(value));
}

function mappingLookup(mapping: any, key: string) {
  if (mapping instanceof Map) {
    return { has: mapping.has(key), value: mapping.get(key) };
  }
  return { has: Object.prototype.hasOwnProperty.call(mapping, key), value: mapping[key] };
}

// ── 输入校验 ────────────────────────────────────────────────────────────

/** 校验 manifest 结构；返回通过校验的条目（引用原对象，不复制不改写）。 */
function validateManifest(manifest: any, problems: string[]) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    problems.push('manifest 必须是解析对象');
    return [];
  }
  if (!Array.isArray(manifest.files)) {
    problems.push('manifest.files 必须是数组');
    return [];
  }
  const entries: any[] = [];
  const fileByLower = new Map();
  const franchiseSeen = new Set();
  manifest.files.forEach((entry: any, index: string) => {
    const at = 'manifest.files[' + index + ']';
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(at + ' 必须是对象');
      return;
    }
    const file = entry.file;
    if (typeof file !== 'string' || !SHARD_FILE_RE.test(file)
      || RESERVED_LOWER_FILE_NAMES.has(file.toLowerCase())
      || WINDOWS_RESERVED_STEMS.has(file.split('.')[0].toLowerCase())) {
      problems.push(at + ' 的 file 不是安全的分片 JSON 基名'
        + '（拒绝 traversal/绝对路径/分隔符/manifest.json/Windows 保留设备名）: ' + JSON.stringify(file));
      return;
    }
    const lower = file.toLowerCase();
    if (fileByLower.has(lower)) {
      problems.push(at + ' 的 file 与 ' + fileByLower.get(lower)
        + ' 在 Windows 大小写不敏感下视为同一文件，冲突: ' + file);
      return;
    }
    fileByLower.set(lower, at);
    if (typeof entry.franchise !== 'string' || !entry.franchise.trim()) {
      problems.push(at + ' 缺少非空 franchise 字符串');
      return;
    }
    if (franchiseSeen.has(entry.franchise)) {
      problems.push(at + ' 的 franchise 重复声明（同一 franchise 不得挂在多个文件上）: '
        + entry.franchise);
      return;
    }
    franchiseSeen.add(entry.franchise);
    entries.push(entry);
  });
  return entries;
}

/** 校验分片输入与 manifest 一一对应；返回 Map<file, { text, data }>。 */
function validateShards(shards: any, entries: any[], problems: string[]) {
  let provided;
  if (shards instanceof Map) {
    provided = shards;
  } else if (isMapping(shards)) {
    provided = new Map(Object.keys(shards).map((file) => [file, shards[file]]));
  } else {
    problems.push('shards 必须是「分片文件名 → { text, data }」的 Map 或普通对象');
    return new Map();
  }
  const result = new Map();
  const sourceIds = new Map();
  for (const entry of entries) {
    const file = entry.file;
    const shard = provided.get(file);
    if (!shard || typeof shard !== 'object' || Array.isArray(shard)) {
      problems.push('来源分片不齐全：缺少 ' + JSON.stringify(file) + ' 的 { text, data }');
      continue;
    }
    const text = shard.text;
    const data = shard.data;
    if (typeof text !== 'string') {
      problems.push('分片 ' + file + ' 缺少原始文本 text');
      continue;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      problems.push('分片 ' + file + ' 缺少解析对象 data');
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      problems.push('分片 ' + file + ' 的 text 不是合法 JSON: ' + runtimeErrorMessage(error));
      continue;
    }
    if (JSON.stringify(parsed) !== JSON.stringify(data)) {
      problems.push('分片 ' + file + ' 的 text 与 data 不一致（data 必须等于 JSON.parse(text)）');
      continue;
    }
    if (!Array.isArray(data.blueprints)) {
      problems.push('分片 ' + file + ' 的根必须是 { blueprints: [...] }');
      continue;
    }
    if (data.franchise !== entry.franchise) {
      problems.push('分片 ' + file + ' 的 franchise 与 manifest 声明冲突（不静默合并）: 分片为 '
        + JSON.stringify(data.franchise) + '，manifest 为 ' + JSON.stringify(entry.franchise));
      continue;
    }
    let valid = true;
    data.blueprints.forEach((bp: { id: string; }, index: string) => {
      if (!bp || typeof bp !== 'object' || Array.isArray(bp)
        || typeof bp.id !== 'string' || !bp.id.trim()) {
        problems.push('分片 ' + file + ' 第 ' + index + ' 个蓝图缺少非空字符串 id');
        valid = false;
        return;
      }
      if (sourceIds.has(bp.id)) {
        problems.push('蓝图 id ' + bp.id + ' 同时出现在 ' + sourceIds.get(bp.id) + ' 和 ' + file);
        valid = false;
        return;
      }
      sourceIds.set(bp.id, file);
    });
    if (!valid) continue;
    result.set(file, { text, data });
  }
  for (const file of provided.keys()) {
    if (!entries.some((entry: any) => entry.file === file)) {
      problems.push('shards 包含未在 manifest 声明的分片: ' + JSON.stringify(file));
    }
  }
  return result;
}

/** 校验目标集合并按 franchise 分组（Map 保序：franchise 按首次出现排序）。 */
function validateTarget(blueprints: any[], mapping: any, mappingUsable: boolean, problems: string[]) {
  const groups = new Map();
  if (!Array.isArray(blueprints)) {
    problems.push('目标 blueprints 必须是数组');
    return groups;
  }
  if (!blueprints.length) {
    problems.push('目标 blueprints 为空：全部 franchise 都会被删除并产生空 manifest，'
      + '而当前读取器（blueprint-store 的 readManifest）不接受空清单，请保留至少一个蓝图');
    return groups;
  }
  const idSeen = new Map();
  blueprints.forEach((bp: any, index) => {
    const at = '目标 blueprints[' + index + ']';
    if (!bp || typeof bp !== 'object' || Array.isArray(bp)) {
      problems.push(at + ' 必须是对象');
      return;
    }
    const id = bp.id;
    if (typeof id !== 'string' || !id.trim()) {
      problems.push(at + ' 缺少非空字符串 id');
      return;
    }
    if (idSeen.has(id)) {
      problems.push(at + ' 的蓝图 id 重复: ' + id + '（已出现在 ' + idSeen.get(id) + '）');
      return;
    }
    idSeen.set(id, at);
    if (!mappingUsable) return;
    const characterId = bp.characterId;
    if (typeof characterId !== 'string' || !characterId.trim()) {
      problems.push('蓝图 ' + id + '（' + at + '）缺少非空字符串 characterId');
      return;
    }
    const found = mappingLookup(mapping, characterId);
    if (!found.has) {
      problems.push('蓝图 ' + id + ' 的 characterId ' + JSON.stringify(characterId)
        + ' 不在角色→franchise 映射中（未知角色，不自动归入 unknown 建片）');
      return;
    }
    const franchise = found.value;
    if (typeof franchise !== 'string' || !franchise.trim()
      || franchise.trim().toLowerCase() === 'unknown') {
      problems.push('蓝图 ' + id + ' 的 characterId ' + JSON.stringify(characterId)
        + ' 无法确认 franchise（映射值为空或 unknown，不自动建 unknown 片）');
      return;
    }
    if (!groups.has(franchise)) groups.set(franchise, []);
    groups.get(franchise).push(bp);
  });
  return groups;
}

// ── 计划构建 ────────────────────────────────────────────────────────────

function planWrite(file: string, franchise: any, group: string|any[], kind: string) {
  const data = { version: 2, franchise, blueprints: group };
  return { file, franchise, count: group.length, kind, data, text: jsonText(data) };
}

function buildPlan(manifest: any, entries: any[], shardMap: Map<any,any>, groups: Map<any,any>, problems: string[]) {
  const existingByFranchise = new Map(entries.map((entry: any) => [entry.franchise, entry]));
  const nextFiles = [];
  const writes = [];
  const deletes = [];
  const unchanged = [];
  // 新系列文件名不得复用任何现有分片名（含本次将删除的），避免同一计划内
  // 同一路径「先删后写」的顺序陷阱；确需复用同名文件时分两次保存。
  const occupied = new Set(entries.map((entry: { file: string; }) => entry.file.toLowerCase()));
  const newFileByLower = new Map();

  for (const entry of entries) {
    const group: any = groups.get(entry.franchise);
    if (!group) {
      deletes.push({ file: entry.file, franchise: entry.franchise });
      continue;
    }
    nextFiles.push({ ...entry, count: group.length });
    const source: any = shardMap.get(entry.file);
    if (JSON.stringify(source.data.blueprints) === JSON.stringify(group)) {
      unchanged.push({ file: entry.file, franchise: entry.franchise, count: group.length });
    } else {
      writes.push(planWrite(entry.file, entry.franchise, group, 'update'));
    }
  }

  for (const [franchise, group] of groups) {
    if (existingByFranchise.has(franchise)) continue;
    const slug = franchiseSlug(franchise);
    const file = slug + '.json';
    const lower = file.toLowerCase();
    if (slug === 'unknown') {
      problems.push('新 franchise ' + JSON.stringify(franchise)
        + ' 无法生成有效分片文件名（slug 退化为 unknown），不自动归入 unknown 建片');
    } else if (WINDOWS_RESERVED_STEMS.has(slug)) {
      problems.push('新 franchise ' + JSON.stringify(franchise)
        + ' 的文件名 ' + file + ' 是 Windows 保留设备名');
    } else if (RESERVED_LOWER_FILE_NAMES.has(lower)) {
      problems.push('新 franchise ' + JSON.stringify(franchise)
        + ' 的文件名 ' + file + ' 与 manifest 本身冲突');
    } else if (occupied.has(lower) || newFileByLower.has(lower)) {
      problems.push('新 franchise ' + JSON.stringify(franchise) + ' 的文件名 ' + file
        + ' 与现有分片或其他新系列冲突（含本次将被删除的文件名；如需复用同名文件请分两次保存）');
    } else {
      newFileByLower.set(lower, franchise);
      nextFiles.push({ file, franchise, count: group.length });
      writes.push(planWrite(file, franchise, group, 'create'));
    }
  }

  if (problems.length) throw new BlueprintChangePlanError(problems);

  const aggregateBlueprints = [];
  for (const entry of nextFiles) {
    aggregateBlueprints.push(...groups.get(entry.franchise));
  }
  const nextManifest = { ...manifest, files: nextFiles };
  const aggregateData = { version: 2, blueprints: aggregateBlueprints };
  // 结构比较（JSON.stringify 与条目键序一致）：计数修正也会被识别为已变化。
  const manifestChanged = JSON.stringify(nextManifest) !== JSON.stringify(manifest);
  return {
    manifest: { data: nextManifest, text: jsonText(nextManifest), changed: manifestChanged },
    aggregate: { data: aggregateData, text: jsonText(aggregateData) },
    writes,
    deletes,
    unchanged,
    summary: {
      writes: writes.length,
      deletes: deletes.length,
      unchanged: unchanged.length,
      blueprints: aggregateBlueprints.length,
      franchises: nextFiles.length,
    },
    dirty: writes.length > 0 || deletes.length > 0 || manifestChanged,
  };
}

/**
 * 规划一次蓝图分片变更；输入不合法时抛出 BlueprintChangePlanError（.problems 为
 * 全部问题的数组）。纯函数：零 require、不读环境、不改输入、不落盘。
 */
function planBlueprintChanges(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BlueprintChangePlanError(['planBlueprintChanges 的输入必须是单个对象参数']);
  }
  const problems: string[] = [];
  const entries = validateManifest(input.manifest, problems);
  if (problems.length) throw new BlueprintChangePlanError(problems);
  const shardMap = validateShards(input.shards, entries, problems);
  if (problems.length) throw new BlueprintChangePlanError(problems);
  const mappingUsable = isMapping(input.franchiseByCharacter);
  if (!mappingUsable) {
    problems.push('franchiseByCharacter 必须是「characterId → franchise」的 Map 或普通对象');
  }
  const groups = validateTarget(input.blueprints, input.franchiseByCharacter, mappingUsable, problems);
  if (problems.length) throw new BlueprintChangePlanError(problems);
  return buildPlan(input.manifest, entries, shardMap, groups, problems);
}

export = {
  planBlueprintChanges,
  BlueprintChangePlanError,
  franchiseSlug,
  jsonText,
};
