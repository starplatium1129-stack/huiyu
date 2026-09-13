'use strict';

/**
 * scripts/lib/blueprint-write.js — 蓝图计划的磁盘准备与应用适配器（G16）
 *
 * 衔接 G12 纯规划器（blueprint-change-plan）与 routes/maintenance 的统一快照协议
 * （snapshotFiles / restoreSnapshot / saveSnapshotBackup）。职责只有两件事：
 *
 * - prepareBlueprintWrite({ rootDir, blueprints, franchiseByCharacter, io })：
 *   显式根只读读取当前 manifest 与 manifest 声明的源分片（不扫描、不读取任何
 *   未登记分片），调用纯规划器，返回 plan、原始字节基线与与现有
 *   `{ file, exists, content: Buffer|null }` 兼容的 snapshotEntries。
 *   只读准备：不创建目录、不自愈、不写任何文件。
 * - applyBlueprintWrite(prepared, { writeFileAtomic, io })：写入前逐条复核基线
 *   （存在文件字节必须仍一致、新建路径必须仍不存在，任一漂移即「过期计划」
 *   零写入拒绝，包含 unchanged 源）；然后按「分片写入 → 计划内删除 → manifest（仅结构变化时）→
 *   聚合（仅字节不一致时）」应用已准备计划，unchanged 分片一律不写，最后读回
 *   核验所有已写/已删路径。任何 IO 失败原样向上抛，不吞错、不宣称保存成功、
 *   不自行持久备份、不做完整事务回滚——回滚由主任务的统一快照负责。
 *
 * 路径边界：manifest/分片/聚合均按 `<root>/data/...` 固定形态由本模块构造；
 * root 先 realpath 解析，data、data/blueprints 及每个被读取/写入/删除的文件都
 * 校验为「非链接的真实形态」（lstat 非符号链接 + realpath 与字面路径一致），
 * 拒绝 junction/符号链接逃逸；分片文件名沿用规划器的安全基名规则并在应用前
 * 重验（防伪造/篡改 prepared 导致越界写）。新增（create）路径在准备时必须
 * 不存在——被未登记文件占用即拒绝，绝不覆盖。
 *
 * 不接路由、不改 DATA_VERSION、不动压缩伴生文件、不碰锁与 HTTP 响应；
 * 不修改 blueprint-change-plan / blueprint-store / routes/maintenance。
 * io 可注入（realpathSync/lstatSync/readFileSync/unlinkSync），写适配器
 * writeFileAtomic(source, content) 可注入，缺省用内置原子写（同目录临时文件
 * + rename，不创建目录；目录边界已在准备/复核阶段验证）。
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { planBlueprintChanges, BlueprintChangePlanError } = require('./blueprint-change-plan');
// 只接受本模块 prepare 产生的对象；基线副本不暴露给调用方，不能靠修改 Buffer 绕过。
const preparedStates = new WeakMap();

// 与 blueprint-change-plan 的 SHARD_FILE_RE / 保留名规则一致（该模块不导出，
// 这里独立维护并测试对拍；应用前重验是为了拒绝伪造的 prepared 对象）。
const SHARD_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const RESERVED_LOWER_FILE_NAMES = new Set(['manifest.json']);
const WINDOWS_RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

class BlueprintWriteError extends Error {
  constructor(message, code, filePath) {
    super(message);
    this.name = 'BlueprintWriteError';
    this.code = code;
    if (filePath !== undefined) this.filePath = filePath;
  }
}

function sameRealPath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function derivePaths(rootReal) {
  const dataDir = path.join(rootReal, 'data');
  const shardsDir = path.join(dataDir, 'blueprints');
  return {
    dataDir,
    shardsDir,
    manifestPath: path.join(shardsDir, 'manifest.json'),
    aggregatePath: path.join(dataDir, 'scene-blueprints.json'),
  };
}

function deepFreeze(value) {
  // Buffer 不可 freeze；apply 使用私有副本核对公开快照是否被改动。
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** 已存在目录必须是真实目录：非符号链接/junction，realpath 与字面路径一致。 */
function requireRealDirectory(abs, io, label) {
  let st;
  try {
    st = io.lstatSync(abs);
  } catch (error) {
    throw new BlueprintWriteError(label + ' 不可访问: ' + error.message, 'boundary', abs);
  }
  if (st.isSymbolicLink()) {
    throw new BlueprintWriteError(label + ' 是符号链接/junction，拒绝链接逃逸', 'boundary', abs);
  }
  if (!st.isDirectory()) {
    throw new BlueprintWriteError(label + ' 存在但不是目录', 'boundary', abs);
  }
  let real;
  try {
    real = io.realpathSync(abs);
  } catch (error) {
    throw new BlueprintWriteError(label + ' 真实路径无法解析: ' + error.message, 'boundary', abs);
  }
  if (!sameRealPath(real, abs)) {
    throw new BlueprintWriteError(label + ' 真实路径 ' + real + ' 与字面路径不一致（重解析点/junction），拒绝读写', 'boundary', abs);
  }
}

function requirePlanSource(shardEntries, file, where) {
  const source = shardEntries.find((item) => item.file === file);
  if (!source) {
    throw new BlueprintWriteError(where + ' 引用了 manifest 未声明的分片: ' + JSON.stringify(file), 'path-validation', file);
  }
  return source;
}

/** 读取一个必须为真实普通文件的路径；allowAbsent 时缺失返回 { exists:false }。 */
function readRealFile(abs, io, label, allowAbsent) {
  let st;
  try {
    st = io.lstatSync(abs);
  } catch (error) {
    if (allowAbsent && error.code === 'ENOENT') return { exists: false, content: null };
    if (error.code === 'ENOENT') {
      throw new BlueprintWriteError(label + ' 不存在（不自愈，拒绝准备）', 'boundary', abs);
    }
    throw new BlueprintWriteError(label + ' 不可访问: ' + error.message, 'boundary', abs);
  }
  if (st.isSymbolicLink()) {
    throw new BlueprintWriteError(label + ' 是符号链接/junction，拒绝通过链接读写', 'boundary', abs);
  }
  if (!st.isFile()) {
    throw new BlueprintWriteError(label + ' 不是普通文件', 'boundary', abs);
  }
  let real;
  try {
    real = io.realpathSync(abs);
  } catch (error) {
    throw new BlueprintWriteError(label + ' 真实路径无法解析: ' + error.message, 'boundary', abs);
  }
  if (!sameRealPath(real, abs)) {
    throw new BlueprintWriteError(label + ' 真实路径 ' + real + ' 与字面路径不一致（重解析点/junction），拒绝读写', 'boundary', abs);
  }
  let content;
  try {
    content = io.readFileSync(abs);
  } catch (error) {
    throw new BlueprintWriteError(label + ' 不可读取: ' + error.message, 'boundary', abs);
  }
  return { exists: true, content };
}

/** 分片基名重验（与规划器一致）：拒绝 traversal/绝对路径/分隔符/保留名/设备名。 */
function assertSafeShardName(file, where) {
  if (typeof file !== 'string' || !SHARD_FILE_RE.test(file)
    || RESERVED_LOWER_FILE_NAMES.has(file.toLowerCase())
    || WINDOWS_RESERVED_STEMS.has(file.split('.')[0].toLowerCase())) {
    throw new BlueprintWriteError(where + ' 的分片文件名不安全（拒绝 traversal/绝对路径/分隔符/manifest.json/Windows 保留设备名）: '
      + JSON.stringify(file), 'path-validation', file);
  }
}

function shardAbsPath(shardsDir, file) {
  const abs = path.join(shardsDir, file);
  const rel = path.relative(shardsDir, abs);
  if (rel === '' || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) {
    throw new BlueprintWriteError('分片路径越出 shards 目录: ' + JSON.stringify(file), 'path-validation', abs);
  }
  return abs;
}

/**
 * 只读准备一次蓝图写入。输入不合法或规划器拒绝时抛错
 * （输入校验问题为 BlueprintChangePlanError，携带 .problems）。
 */
function prepareBlueprintWrite({ rootDir, blueprints, franchiseByCharacter, io = nodeFs } = {}) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) {
    throw new BlueprintWriteError('rootDir 缺失或不是非空字符串', 'argument');
  }
  let rootReal;
  try {
    rootReal = io.realpathSync(path.resolve(rootDir));
  } catch (error) {
    throw new BlueprintWriteError('rootDir 不可解析为真实路径: ' + error.message, 'boundary', rootDir);
  }
  requireRealDirectory(rootReal, io, '项目根 root');
  const paths = derivePaths(rootReal);
  requireRealDirectory(paths.dataDir, io, 'data 目录');
  requireRealDirectory(paths.shardsDir, io, 'blueprints 分片目录');

  const manifestEntry = readRealFile(paths.manifestPath, io, '蓝图 manifest（' + paths.manifestPath + '）', false);
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.content.toString('utf8'));
  } catch (error) {
    throw new BlueprintWriteError('蓝图 manifest 不是合法 JSON: ' + error.message, 'boundary', paths.manifestPath);
  }

  const aggregateEntry = readRealFile(paths.aggregatePath, io, '蓝图聚合（' + paths.aggregatePath + '）', true);

  const declared = Array.isArray(manifest && manifest.files) ? manifest.files : [];
  const shardInputs = {};
  const shardEntries = [];
  for (const entry of declared) {
    const file = entry && entry.file;
    assertSafeShardName(file, 'manifest.files');
    const abs = shardAbsPath(paths.shardsDir, file);
    const shardEntry = readRealFile(abs, io, '来源分片 ' + file, false);
    let data;
    try {
      data = JSON.parse(shardEntry.content.toString('utf8'));
    } catch (error) {
      throw new BlueprintWriteError('来源分片 ' + file + ' 不是合法 JSON: ' + error.message, 'boundary', abs);
    }
    shardInputs[file] = { text: shardEntry.content.toString('utf8'), data };
    shardEntries.push({ file, entry: shardEntry });
  }

  const plan = structuredClone(planBlueprintChanges({
    manifest,
    shards: shardInputs,
    blueprints,
    franchiseByCharacter,
  }));

  // 回滚快照只含可能被改写的路径；全部源（含 unchanged）另存私有过期基线。
  // create 路径此时必须不存在。
  const entries = [
    { file: paths.manifestPath, exists: true, content: manifestEntry.content },
    { file: paths.aggregatePath, exists: aggregateEntry.exists, content: aggregateEntry.content },
  ];
  for (const write of plan.writes) {
    const abs = shardAbsPath(paths.shardsDir, write.file);
    if (write.kind === 'create') {
      const occupied = readRealFile(abs, io, '新分片 ' + write.file, true);
      if (occupied.exists) {
        throw new BlueprintWriteError('新分片 ' + write.file + ' 的路径已被未登记文件占用，拒绝覆盖', 'occupied', abs);
      }
      entries.push({ file: abs, exists: false, content: null });
    } else {
      const source = requirePlanSource(shardEntries, write.file, 'plan.writes');
      entries.push({ file: abs, exists: true, content: source.entry.content });
    }
  }
  for (const remove of plan.deletes) {
    const source = requirePlanSource(shardEntries, remove.file, 'plan.deletes');
    entries.push({ file: shardAbsPath(paths.shardsDir, remove.file), exists: true, content: source.entry.content });
  }

  const prepared = deepFreeze({
    kind: 'blueprint-write-prepared',
    rootReal,
    paths,
    plan,
    snapshotEntries: entries,
    summary: {
      writes: plan.writes.length,
      deletes: plan.deletes.length,
      unchanged: plan.unchanged.length,
      snapshotEntries: entries.length,
      dirty: plan.dirty,
    },
  });
  const copyEntry = (entry) => ({ ...entry, content: entry.exists ? Buffer.from(entry.content) : null });
  const baselineByPath = new Map(entries.map((entry) => [entry.file, copyEntry(entry)]));
  for (const source of shardEntries) {
    const file = shardAbsPath(paths.shardsDir, source.file);
    if (!baselineByPath.has(file)) baselineByPath.set(file, copyEntry({ file, ...source.entry }));
  }
  preparedStates.set(prepared, {
    snapshots: entries.map(copyEntry), baseline: [...baselineByPath.values()],
  });
  return prepared;
}

function expectFileBytes(absPath, expected, io, phase, code) {
  let st;
  try {
    st = io.lstatSync(absPath);
  } catch (error) {
    throw new BlueprintWriteError(phase + '读取 ' + absPath + ' 失败: ' + error.message, code || 'readback', absPath);
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new BlueprintWriteError(phase + absPath + ' 不是普通文件（被替换为链接或其他形态）', code || 'readback', absPath);
  }
  if (!sameRealPath(io.realpathSync(absPath), absPath)) {
    throw new BlueprintWriteError(phase + absPath + ' 真实路径发生变化', code || 'readback', absPath);
  }
  let current;
  try {
    current = io.readFileSync(absPath);
  } catch (error) {
    throw new BlueprintWriteError(phase + '读取 ' + absPath + ' 失败: ' + error.message, code || 'readback', absPath);
  }
  if (Buffer.compare(current, expected) !== 0) {
    throw new BlueprintWriteError(phase + absPath + ' 字节与计划/基线不一致', code || 'readback', absPath);
  }
}

/**
 * 应用已准备计划。prepared 必须是同一模块 prepare 返回的原始对象，不能序列化
 * 后重建；公开 Buffer 改动与全部源基线漂移在第一次写入前整体拒绝。
 */
function applyBlueprintWrite(prepared, { writeFileAtomic, io = nodeFs } = {}) {
  const write = writeFileAtomic || defaultWriteFileAtomic;
  if (typeof write !== 'function') {
    throw new BlueprintWriteError('writeFileAtomic 必须是 (source, content) 函数', 'argument');
  }
  if (!prepared || typeof prepared !== 'object' || prepared.kind !== 'blueprint-write-prepared') {
    throw new BlueprintWriteError('prepared 必须来自 prepareBlueprintWrite', 'argument');
  }
  const state = preparedStates.get(prepared);
  if (!state) throw new BlueprintWriteError('prepared 必须是本模块 prepare 的原始对象，拒绝伪造或复制', 'path-validation');
  for (let i = 0; i < state.snapshots.length; i++) {
    const original = state.snapshots[i];
    if (original.exists && !original.content.equals(prepared.snapshotEntries[i].content)) {
      throw new BlueprintWriteError('prepared 快照 Buffer 已被篡改', 'tampered', original.file);
    }
  }
  const plan = prepared.plan;
  if (!plan || typeof plan !== 'object' || !plan.manifest || !plan.aggregate
    || !Array.isArray(plan.writes) || !Array.isArray(plan.deletes) || !Array.isArray(plan.unchanged)) {
    throw new BlueprintWriteError('prepared.plan 缺少 manifest/aggregate/writes/deletes/unchanged 结构', 'argument');
  }
  const derived = derivePaths(prepared.rootReal);
  const paths = prepared.paths || {};
  for (const key of Object.keys(derived)) {
    if (paths[key] !== derived[key]) {
      throw new BlueprintWriteError('prepared.paths.' + key + ' 与 rootReal 推导不一致（拒绝篡改）: '
        + JSON.stringify(paths[key]) + ' != ' + JSON.stringify(derived[key]), 'path-validation', paths[key]);
    }
  }
  const shardsDir = derived.shardsDir;
  requireRealDirectory(prepared.rootReal, io, '项目根 root');
  requireRealDirectory(derived.dataDir, io, 'data 目录');
  requireRealDirectory(shardsDir, io, 'blueprints 分片目录');

  const shardWrites = plan.writes.map((item) => {
    if (!item || (item.kind !== 'create' && item.kind !== 'update') || typeof item.text !== 'string') {
      throw new BlueprintWriteError('plan.writes 条目缺少 kind/text: ' + JSON.stringify(item && item.file), 'path-validation');
    }
    assertSafeShardName(item.file, 'plan.writes');
    return { file: item.file, abs: shardAbsPath(shardsDir, item.file), kind: item.kind, bytes: Buffer.from(item.text, 'utf8') };
  });
  const shardDeletes = plan.deletes.map((item) => {
    assertSafeShardName(item && item.file, 'plan.deletes');
    return { file: item.file, abs: shardAbsPath(shardsDir, item.file) };
  });
  for (const item of plan.unchanged) assertSafeShardName(item && item.file, 'plan.unchanged');
  const writePaths = new Set(shardWrites.map((item) => item.abs.toLowerCase()));
  for (const item of shardDeletes) {
    if (writePaths.has(item.abs.toLowerCase())) {
      throw new BlueprintWriteError('同一分片同时出现在 writes 与 deletes: ' + item.file, 'path-validation', item.abs);
    }
  }

  // ── 写入前复核：全部基线逐条与当前磁盘一致，任何漂移零写入拒绝 ──
  const entries = Array.isArray(prepared.snapshotEntries) ? prepared.snapshotEntries : [];
  const entryByFile = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string' || (entry.exists !== true && entry.exists !== false)
      || (entry.exists === true && !Buffer.isBuffer(entry.content))) {
      throw new BlueprintWriteError('snapshotEntries 条目缺少 { file, exists, content: Buffer|null }', 'argument');
    }
    entryByFile.set(entry.file, entry);
  }
  // 每个写入/删除路径都必须有匹配形态的基线条目（受控绑定：防伪造/篡改后绕过复核）。
  for (const item of shardWrites) {
    const entry = entryByFile.get(item.abs);
    if (!entry) {
      throw new BlueprintWriteError('plan.writes 的 ' + item.file + ' 缺少基线快照条目（拒绝篡改）', 'path-validation', item.abs);
    }
    if (item.kind === 'create' && entry.exists !== false) {
      throw new BlueprintWriteError('create 路径 ' + item.file + ' 的基线必须是「不存在」', 'path-validation', item.abs);
    }
    if (item.kind === 'update' && entry.exists !== true) {
      throw new BlueprintWriteError('update 路径 ' + item.file + ' 的基线必须是「存在」', 'path-validation', item.abs);
    }
  }
  for (const item of shardDeletes) {
    const entry = entryByFile.get(item.abs);
    if (!entry || entry.exists !== true) {
      throw new BlueprintWriteError('plan.deletes 的 ' + item.file + ' 缺少「存在」基线快照条目（拒绝篡改）', 'path-validation', item.abs);
    }
  }
  for (const entry of state.baseline) {
    if (entry.exists) {
      expectFileBytes(entry.file, entry.content, io, '基线复核：', 'stale');
    } else {
      let st = null;
      try {
        st = io.lstatSync(entry.file);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw new BlueprintWriteError('基线复核：无法确认 ' + entry.file + ' 状态: ' + error.message, 'stale', entry.file);
      }
      throw new BlueprintWriteError('过期计划：新分片路径在准备后被占用（'
        + (st.isSymbolicLink() ? '符号链接/junction' : st.isDirectory() ? '目录' : '文件') + '），拒绝写入', 'occupied', entry.file);
    }
  }

  // ── 执行：分片写入 → 计划内删除 → manifest（仅结构变化）→ 聚合（仅字节不一致）──
  for (const item of shardWrites) write(item.abs, Buffer.from(item.bytes));
  for (const item of shardDeletes) {
    try {
      io.unlinkSync(item.abs);
    } catch (error) {
      throw new BlueprintWriteError('删除分片 ' + item.file + ' 失败: ' + error.message, 'io-error', item.abs);
    }
  }
  const manifestBytes = Buffer.from(plan.manifest.text, 'utf8');
  const aggregateBytes = Buffer.from(plan.aggregate.text, 'utf8');
  const written = shardWrites.map((item) => item.abs);
  let manifestWritten = false;
  let aggregateWritten = false;
  if (plan.manifest.changed === true) {
    write(derived.manifestPath, Buffer.from(manifestBytes));
    manifestWritten = true;
    written.push(derived.manifestPath);
  }
  const aggregateEntry = entries.find((entry) => entry.file === derived.aggregatePath);
  if (!aggregateEntry || !aggregateEntry.exists
    || Buffer.compare(aggregateEntry.content, aggregateBytes) !== 0) {
    write(derived.aggregatePath, Buffer.from(aggregateBytes));
    aggregateWritten = true;
    written.push(derived.aggregatePath);
  }

  // ── 读回核验：所有已写路径字节一致、已删路径确认消失 ──
  for (const item of shardWrites) expectFileBytes(item.abs, item.bytes, io, '写回核验：');
  for (const item of shardDeletes) {
    let gone = false;
    try {
      io.lstatSync(item.abs);
    } catch (error) {
      gone = error.code === 'ENOENT';
      if (!gone) throw new BlueprintWriteError('写回核验：无法确认 ' + item.abs + ' 已删除: ' + error.message, 'readback', item.abs);
    }
    if (!gone) throw new BlueprintWriteError('写回核验：计划删除的 ' + item.file + ' 仍存在', 'readback', item.abs);
  }
  if (manifestWritten) expectFileBytes(derived.manifestPath, manifestBytes, io, '写回核验：');
  if (aggregateWritten) expectFileBytes(derived.aggregatePath, aggregateBytes, io, '写回核验：');

  return deepFreeze({
    ok: true,
    rootReal: prepared.rootReal,
    paths: derived,
    written,
    deleted: shardDeletes.map((item) => item.abs),
    manifestWritten,
    aggregateWritten,
    unchanged: plan.unchanged.map((item) => item.file),
    summary: {
      writes: shardWrites.length,
      deletes: shardDeletes.length,
      manifestWritten,
      aggregateWritten,
      unchanged: plan.unchanged.length,
    },
  });
}

/** 内置原子写：同目录临时文件 + rename，失败清理临时文件；不创建目录。 */
function defaultWriteFileAtomic(source, content) {
  const dir = path.dirname(source);
  const temporary = path.join(dir, '.' + path.basename(source) + '.' + randomUUID() + '.tmp');
  let created = false;
  try {
    const fd = nodeFs.openSync(temporary, 'wx');
    created = true;
    try { nodeFs.writeFileSync(fd, content); } finally { nodeFs.closeSync(fd); }
    nodeFs.renameSync(temporary, source);
  } catch (error) {
    try { if (created) nodeFs.unlinkSync(temporary); } catch (cleanupError) {}
    throw error;
  }
}

module.exports = {
  prepareBlueprintWrite,
  applyBlueprintWrite,
  BlueprintWriteError,
  defaultWriteFileAtomic,
  BlueprintChangePlanError,
};
