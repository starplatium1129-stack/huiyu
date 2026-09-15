import { PathLike } from 'node:fs';
import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

/**
 * scripts/lib/resource-pack-verify.js — 增量候选包与基线的只读兼容核验（G15）
 *
 * 职责：
 *  - 纯函数 verifyDeltaPackContent：接收基线清单对象、候选 manifest 对象与 delta 元数据
 *    对象，不触 fs、不读环境。先经 compareManifests 复用清单结构检查（两侧同一套结构
 *    规则：schemaVersion/条目形态/重复与 Windows 大小写重复/路径合规/非空 unverified），
 *    再核对 delta 元数据的 kind/schemaVersion 与身份/数量字段形态；验证基线
 *    contentIdentity/entryCount/totalBytes 与 delta.baseManifest 相符；以基线移除
 *    delta.removed 后叠加候选 added/changed 重建目标条目，其身份三项必须与
 *    delta.newManifest 相符；按基线→目标的实际集合关系重算 added/removed/changed/
 *    unchanged 并与 delta.totals 逐项一致。
 *  - 逐项强校验（不只对比总数）：removed 每项必须确实存在于基线且 bytes/sha256 相符，
 *    路径唯一且不得同时出现在候选中；候选与基线同路径同内容的条目不能冒充 changed；
 *    delta.candidate 的 files/bytes/zeroAssets 必须与候选 manifest 实际条目一致。
 *    路径匹配用精确字符串（与 compareManifests 的差异口径一致）；身份比较对十六进制
 *    大小写不敏感（manifestContentIdentity 本身即小写口径）。
 *  - IO 层 verifyDeltaPack：只读取明确指定的基线 JSON、候选 manifest.json/delta.json 与
 *    候选已列资源（复用 resource-manifest 的 verifyManifestEntries 核验候选实际字节）；
 *    不 stat/read 基线资产、不扫描安装目录；基线文件可已不存在，元数据仍可核验。
 *    基线清单/候选目录/内部路径遵守 root 与真实路径边界，junction/坏路径访问外部目录
 *    在读取前拒绝。缺 delta.json 的全包不能按增量候选核验（missing-delta-json）。
 *  - 全程零写入、无安装/删除/网络。核验通过只表示「相对于给定基线可重建声明目标且候选
 *    字节匹配」，不是数字签名、可信来源、当前安装状态或质量验收。
 *
 * 错误定位：每条错误带 source（base-manifest / pack-manifest / pack-delta / pack-files）、
 * code 与可能的 path。参数/越界/环境问题抛 UsageError（CLI 退出 2）；内容/不兼容问题
 * 汇入结果 errors（退出 1）。
 *
 * 只读复用（不修改这些库）：resource-manifest 的 SCHEMA_VERSION/UsageError/
 * compareManifests/resolveRealpathBoundary/verifyManifestEntries；resource-pack-delta 的
 * manifestContentIdentity。io 可注入（测试用记录型 fs 证明访问与写入边界）。
 */

const nodeFs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { SCHEMA_VERSION, UsageError, compareManifests, resolveRealpathBoundary, verifyManifestEntries }: typeof import('./resource-manifest') = require('./resource-manifest');
const { manifestContentIdentity }: typeof import('./resource-pack-delta') = require('./resource-pack-delta');

const DELTA_KIND = 'resource-pack-delta';
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

const VERIFY_SCOPE = Object.freeze({
  basis: '核验通过仅表示：相对于给定基线清单，移除 delta.removed 并叠加候选 added/changed 可重建 delta.newManifest 声明的目标身份（contentIdentity/entryCount/totalBytes），且候选包内已列文件字节与候选 manifest 一致',
  coverageNote: '这不是数字签名、可信来源、当前安装状态或质量验收；不发现候选包未登记文件；基线资产不被读取（removed 文件可已不存在）；空候选与仅删除候选可合法通过，通过不代表已安装更新',
});

function isNonNegativeInt(value: any) {
  return Number.isSafeInteger(value) && value >= 0;
}

function identityRecordErrors(record: any, field: string, errors: { source: string; code: string; message: string; }[]) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: `delta.${field} 必须是身份记录对象（path/contentIdentity/entryCount/totalBytes）` });
    return;
  }
  if (typeof record.path !== 'string' || record.path === '') {
    errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: `delta.${field}.path 必须是非空字符串` });
  }
  if (typeof record.contentIdentity !== 'string' || !HEX64_RE.test(record.contentIdentity)) {
    errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: `delta.${field}.contentIdentity 必须是 64 位十六进制字符串` });
  }
  if (!isNonNegativeInt(record.entryCount)) {
    errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: `delta.${field}.entryCount 必须是非负整数` });
  }
  if (!isNonNegativeInt(record.totalBytes)) {
    errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: `delta.${field}.totalBytes 必须是非负整数` });
  }
}

/** delta 元数据形态检查：kind/schemaVersion、身份记录、totals、removed 条目、candidate。 */
function checkDeltaMetadataForm(delta: any) {
  const errors = [];
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
    errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: 'delta 元数据必须是 JSON 对象' });
    return errors;
  }
  if (delta.schemaVersion !== SCHEMA_VERSION) {
    errors.push({ source: 'pack-delta', code: 'unsupported-delta-schema', message: `不支持的 delta schemaVersion: ${JSON.stringify(delta.schemaVersion)}（本工具支持 ${SCHEMA_VERSION}）` });
  }
  if (delta.kind !== DELTA_KIND) {
    errors.push({ source: 'pack-delta', code: 'bad-delta-kind', message: `delta 元数据 kind 必须是 ${DELTA_KIND}，收到 ${JSON.stringify(delta.kind)}；缺 delta.json 的全包不能按增量候选核验` });
  }
  identityRecordErrors(delta.baseManifest, 'baseManifest', errors);
  identityRecordErrors(delta.newManifest, 'newManifest', errors);
  if (!delta.totals || typeof delta.totals !== 'object' || Array.isArray(delta.totals)) {
    errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: 'delta.totals 必须是对象（added/removed/changed/unchanged）' });
  } else {
    for (const key of ['added', 'removed', 'changed', 'unchanged']) {
      if (!isNonNegativeInt(delta.totals[key])) {
        errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: `delta.totals.${key} 必须是非负整数` });
      }
    }
  }
  if (!Array.isArray(delta.removed)) {
    errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: 'delta.removed 必须是数组' });
  } else {
    delta.removed.forEach((item: any, index: any) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: `delta.removed[${index}] 必须是对象（path/bytes/sha256）` });
        return;
      }
      if (typeof item.path !== 'string' || item.path === '') {
        errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: `delta.removed[${index}].path 必须是非空字符串` });
      }
      if (!isNonNegativeInt(item.bytes)) {
        errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: `delta.removed[${index}].bytes 必须是非负整数` });
      }
      if (typeof item.sha256 !== 'string' || !HEX64_RE.test(item.sha256)) {
        errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: `delta.removed[${index}].sha256 必须是 64 位十六进制字符串` });
      }
    });
  }
  if (!delta.candidate || typeof delta.candidate !== 'object' || Array.isArray(delta.candidate)) {
    errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: 'delta.candidate 必须是对象（files/bytes/zeroAssets）' });
  } else {
    if (!isNonNegativeInt(delta.candidate.files)) {
      errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: 'delta.candidate.files 必须是非负整数' });
    }
    if (!isNonNegativeInt(delta.candidate.bytes)) {
      errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: 'delta.candidate.bytes 必须是非负整数' });
    }
    if (typeof delta.candidate.zeroAssets !== 'boolean') {
      errors.push({ source: 'pack-delta', code: 'bad-delta-metadata', message: 'delta.candidate.zeroAssets 必须是布尔值' });
    }
  }
  return errors;
}

function sumBytes(entries: any[]) {
  return entries.reduce((acc: any, e: any) => acc + e.bytes, 0);
}

function identityOf(entries: any) {
  return {
    contentIdentity: manifestContentIdentity({ entries }),
    entryCount: entries.length,
    totalBytes: sumBytes(entries),
  };
}

/**
 * 纯核验（不触 fs、不读环境）。任一侧清单结构错误或 delta 形态错误即拒绝，不在此
 * 基础上继续深层比对（不可信条目集合不产出可信结论）。返回结果对象，不抛内容性错误。
 */
function verifyDeltaPackContent({ baseManifest, packManifest, delta } = {}) {
  const errors = [];
  const struct: any = compareManifests({ oldManifest: baseManifest, newManifest: packManifest });
  for (const e of struct.errors) {
    errors.push({ ...e, source: e.side === 'old' ? 'base-manifest' : 'pack-manifest' });
  }
  const formErrors = checkDeltaMetadataForm(delta);
  errors.push(...formErrors);

  const result = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'resource-pack-delta-verification',
    ok: false,
    compatibility: null,
    errors,
    scope: VERIFY_SCOPE,
    notes: [],
  };
  if (errors.length > 0) return result;

  const baseEntries = baseManifest.entries;
  const packEntries = packManifest.entries;
  const baseByPath = new Map(baseEntries.map((e: any) => [e.path, e]));
  const packByPath = new Map(packEntries.map((e: any) => [e.path, e]));

  // 基线身份：contentIdentity/entryCount/totalBytes 与 delta.baseManifest 相符
  const baseIdentity = identityOf(baseEntries);
  if (baseIdentity.contentIdentity !== delta.baseManifest.contentIdentity.toLowerCase()) {
    errors.push({ source: 'pack-delta', code: 'base-identity-mismatch', message: `基线清单 contentIdentity 与 delta.baseManifest 不符：基线 ${baseIdentity.contentIdentity}，delta ${delta.baseManifest.contentIdentity.toLowerCase()}` });
  }
  if (baseIdentity.entryCount !== delta.baseManifest.entryCount) {
    errors.push({ source: 'pack-delta', code: 'base-entrycount-mismatch', message: `基线清单条目数与 delta.baseManifest.entryCount 不符：基线 ${baseIdentity.entryCount}，delta ${delta.baseManifest.entryCount}` });
  }
  if (baseIdentity.totalBytes !== delta.baseManifest.totalBytes) {
    errors.push({ source: 'pack-delta', code: 'base-totalbytes-mismatch', message: `基线清单字节合计与 delta.baseManifest.totalBytes 不符：基线 ${baseIdentity.totalBytes}，delta ${delta.baseManifest.totalBytes}` });
  }

  // removed 逐项核验：存在于基线、bytes/sha256 相符、路径唯一、不得同时在候选中
  const removedPaths = new Set();
  delta.removed.forEach((item: any, index: any) => {
    if (removedPaths.has(item.path)) {
      errors.push({ source: 'pack-delta', path: item.path, code: 'duplicate-removed-path', message: `delta.removed[${index}] 路径重复` });
      return;
    }
    removedPaths.add(item.path);
    const baseEntry: any = baseByPath.get(item.path);
    if (!baseEntry) {
      errors.push({ source: 'pack-delta', path: item.path, code: 'removed-not-in-baseline', message: `delta.removed[${index}] 不存在于基线清单` });
      return;
    }
    if (baseEntry.bytes !== item.bytes || baseEntry.sha256.toLowerCase() !== item.sha256.toLowerCase()) {
      errors.push({ source: 'pack-delta', path: item.path, code: 'removed-identity-mismatch', message: `removed 条目与基线记录不符：基线 bytes=${baseEntry.bytes} sha256=${baseEntry.sha256.toLowerCase()}，removed bytes=${item.bytes} sha256=${item.sha256.toLowerCase()}` });
    }
    if (packByPath.has(item.path)) {
      errors.push({ source: 'pack-delta', path: item.path, code: 'removed-in-candidate', message: 'removed 路径同时出现在候选 manifest 中' });
    }
  });

  // 候选与基线同路径同内容的条目不能冒充 changed
  for (const [rel, entry] of packByPath) {
    const baseEntry: any = baseByPath.get(rel);
    if (baseEntry && baseEntry.bytes === entry.bytes && baseEntry.sha256.toLowerCase() === entry.sha256.toLowerCase()) {
      errors.push({ source: 'pack-delta', path: rel, code: 'unchanged-as-changed', message: '候选条目与基线同路径同内容，不能作为差异项复制进候选' });
    }
  }

  // 重建目标：基线移除 removed 后叠加候选 added/changed（同路径候选条目覆盖基线条目）
  const targetEntries = [];
  for (const [rel, baseEntry] of baseByPath) {
    if (removedPaths.has(rel)) continue;
    targetEntries.push(packByPath.get(rel) || baseEntry);
  }
  for (const [rel, entry] of packByPath) {
    if (!baseByPath.has(rel)) targetEntries.push(entry);
  }
  // 分别合法的基线/候选合并后也可能产生 Windows 大小写路径冲突。
  const targetStructure: any = compareManifests({ oldManifest: baseManifest, newManifest: { schemaVersion: SCHEMA_VERSION, entries: targetEntries } });
  for (const error of targetStructure.errors) {
    errors.push({ ...error, source: 'pack-delta', message: '重建目标清单不合法: ' + error.message });
  }
  const targetIdentity = identityOf(targetEntries);
  if (targetIdentity.contentIdentity !== delta.newManifest.contentIdentity.toLowerCase()) {
    errors.push({ source: 'pack-delta', code: 'target-identity-mismatch', message: `重建目标 contentIdentity 与 delta.newManifest 不符：重建 ${targetIdentity.contentIdentity}，delta ${delta.newManifest.contentIdentity.toLowerCase()}` });
  }
  if (targetIdentity.entryCount !== delta.newManifest.entryCount) {
    errors.push({ source: 'pack-delta', code: 'target-entrycount-mismatch', message: `重建目标条目数与 delta.newManifest.entryCount 不符：重建 ${targetIdentity.entryCount}，delta ${delta.newManifest.entryCount}` });
  }
  if (targetIdentity.totalBytes !== delta.newManifest.totalBytes) {
    errors.push({ source: 'pack-delta', code: 'target-totalbytes-mismatch', message: `重建目标字节合计与 delta.newManifest.totalBytes 不符：重建 ${targetIdentity.totalBytes}，delta ${delta.newManifest.totalBytes}` });
  }

  // 按实际集合关系重算四类数量并与 delta.totals 逐项一致
  const recomputed: any = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const [rel, baseEntry] of baseByPath) {
    if (removedPaths.has(rel)) {
      recomputed.removed++;
      continue;
    }
    const after: any = packByPath.get(rel);
    if (!after) {
      recomputed.unchanged++;
    } else if (after.bytes !== baseEntry.bytes || after.sha256.toLowerCase() !== baseEntry.sha256.toLowerCase()) {
      recomputed.changed++;
    } else {
      recomputed.unchanged++;
    }
  }
  for (const rel of packByPath.keys()) {
    if (!baseByPath.has(rel)) recomputed.added++;
  }
  for (const key of ['added', 'removed', 'changed', 'unchanged']) {
    if (recomputed[key] !== delta.totals[key]) {
      errors.push({ source: 'pack-delta', code: 'totals-mismatch', kind: key, recomputed: recomputed[key], declared: delta.totals[key], message: `delta.totals.${key} 与按基线/候选实际集合关系重算值不符：重算 ${recomputed[key]}，声明 ${delta.totals[key]}` });
    }
  }

  // delta.candidate 与候选 manifest 实际条目一致
  const actualCandidate = { files: packEntries.length, bytes: sumBytes(packEntries), zeroAssets: packEntries.length === 0 };
  if (delta.candidate.files !== actualCandidate.files) {
    errors.push({ source: 'pack-delta', code: 'candidate-mismatch', field: 'files', message: `delta.candidate.files 与候选 manifest 实际条目数不符：声明 ${delta.candidate.files}，实际 ${actualCandidate.files}` });
  }
  if (delta.candidate.bytes !== actualCandidate.bytes) {
    errors.push({ source: 'pack-delta', code: 'candidate-mismatch', field: 'bytes', message: `delta.candidate.bytes 与候选 manifest 实际字节合计不符：声明 ${delta.candidate.bytes}，实际 ${actualCandidate.bytes}` });
  }
  if (delta.candidate.zeroAssets !== actualCandidate.zeroAssets) {
    errors.push({ source: 'pack-delta', code: 'candidate-mismatch', field: 'zeroAssets', message: `delta.candidate.zeroAssets 与候选实际状态不符：声明 ${delta.candidate.zeroAssets}，实际 ${actualCandidate.zeroAssets}` });
  }

  result.compatibility = {
    identities: {
      base: baseIdentity,
      target: targetIdentity,
      declaredBase: { path: delta.baseManifest.path, ...delta.baseManifest },
      declaredNew: { path: delta.newManifest.path, ...delta.newManifest },
    },
    recomputedTotals: recomputed,
    declaredTotals: { ...delta.totals },
    candidate: { declared: { ...delta.candidate }, actual: actualCandidate },
  };
  result.ok = errors.length === 0;
  if (result.ok && actualCandidate.zeroAssets) {
    result.notes.push('零资产候选（零差异或仅删除差异）通过核验；这不是已安装更新。');
  }
  return result;
}

/** root 解析（与 resource-manifest 同语义：realpath → stat → 必须是目录）。 */
function resolveRootReal(root: PathLike, io: typeof import("node:fs")) {
  if (!root || typeof root !== 'string') throw new UsageError('--root 缺失或不是字符串');
  let rootReal;
  try {
    rootReal = io.realpathSync(root);
  } catch (err) {
    throw new UsageError(`root 不可解析: ${runtimeErrorMessage(err)}`);
  }
  let st;
  try {
    st = io.statSync(rootReal);
  } catch (err) {
    throw new UsageError(`root 不可访问: ${runtimeErrorMessage(err)}`);
  }
  if (!st.isDirectory()) throw new UsageError('root 不是目录');
  return rootReal;
}

function isInsideRoot(rootReal: string, abs: string) {
  const relNative = path.relative(rootReal, abs);
  return relNative !== '' && relNative !== '..' && !relNative.startsWith('..' + path.sep) && !path.isAbsolute(relNative);
}

function relFromRoot(rootReal: string, abs: string) {
  return path.relative(rootReal, abs).split(path.sep).join('/');
}

/** 解析 root 内路径（拒绝 root 本身、越界与跨盘符绝对路径），返回绝对路径。 */
function resolveInsideRootPath(rootReal: string, relOrAbs: string, flag: string) {
  if (!relOrAbs || typeof relOrAbs !== 'string') throw new UsageError(`${flag} 缺失或不是字符串`);
  const abs = path.resolve(rootReal, relOrAbs);
  if (!isInsideRoot(rootReal, abs)) throw new UsageError(`${flag} 必须位于 root 内: ${relOrAbs}`);
  return abs;
}

/** 读取 root 内 JSON 文件：真实路径边界检查先于读取（junction/坏路径越界抛 UsageError）。
 *  allowMissing 时 ENOENT 返回 { missing: true }（由调用方决定内容级处理）；其余读取
 *  失败抛 UsageError。JSON 解析失败记入 parseError，由调用方按内容问题处理。 */
function readJsonFile({ absPath, flag, rootReal, io, allowMissing = false }: any) {
  const boundary = resolveRealpathBoundary(io, absPath, rootReal);
  if (!boundary.ok) throw new UsageError(`${flag} ${boundary.message}`);
  let raw;
  try {
    raw = io.readFileSync(absPath);
  } catch (err) {
    if (allowMissing && runtimeErrorCode(err) === 'ENOENT') return { missing: true };
    throw new UsageError(`${flag} 不可读取: ${runtimeErrorMessage(err)}`);
  }
  try {
    return { missing: false, parsed: JSON.parse(raw.toString('utf8')), parseError: null };
  } catch (err) {
    return { missing: false, parsed: null, parseError: err };
  }
}

/** 候选目录解析：必须在 root 内、存在且为目录、真实路径不越出 root（junction 逃逸拒绝）。 */
function resolvePackDir({ rootReal, packPath, io }: any) {
  const packAbs = resolveInsideRootPath(rootReal, packPath, '--pack');
  const boundary = resolveRealpathBoundary(io, packAbs, rootReal);
  if (!boundary.ok) throw new UsageError(`--pack ${boundary.message}`);
  let st;
  try {
    st = io.statSync(packAbs);
  } catch (err) {
    throw new UsageError(`--pack 候选目录不可访问: ${runtimeErrorMessage(err)}`);
  }
  if (!st.isDirectory()) throw new UsageError(`--pack 不是目录: ${packPath}`);
  return { packAbs: boundary.realTarget, packRel: relFromRoot(rootReal, packAbs) };
}

/**
 * 只读核验入口。只读取明确指定的基线 JSON、候选 manifest.json/delta.json 与候选已列
 * 资源；不 stat/read 基线资产，不扫描安装目录。基线清单缺失/不可读/越界、候选目录
 * 越界/缺失/不是目录抛 UsageError（退出 2）；元数据缺失/损坏/结构错误/身份失配等
 * 内容问题汇入结果 errors（退出 1）。全程零写入。
 */
function verifyDeltaPack({ root, baseManifestPath, packPath, io = nodeFs } = {}) {
  const rootReal = resolveRootReal(root, io);
  const baseAbs = resolveInsideRootPath(rootReal, baseManifestPath, '--base-manifest');
  const { packAbs, packRel } = resolvePackDir({ rootReal, packPath, io });

  const errors = [];
  // 解析成功但值为 null/基本类型/数组时照常进入纯核验，由结构检查/形态检查定位拒绝，
  // 不能因「解析成功」默认通过。
  let baseManifest = null;
  let haveBase = false;
  const baseRead: any = readJsonFile({ absPath: baseAbs, flag: '--base-manifest', rootReal, io });
  if (baseRead.parseError) {
    errors.push({ source: 'base-manifest', code: 'bad-base-manifest', message: `基线清单 JSON 解析失败: ${baseRead.parseError.message}` });
  } else {
    baseManifest = baseRead.parsed;
    haveBase = true;
  }

  let packManifest = null;
  let havePack = false;
  const manifestRead: any = readJsonFile({ absPath: path.join(packAbs, 'manifest.json'), flag: '候选 manifest.json', rootReal: packAbs, io, allowMissing: true });
  if (manifestRead.missing) {
    errors.push({ source: 'pack-manifest', path: 'manifest.json', code: 'missing-pack-manifest', message: `候选包内缺少 manifest.json（${packRel}/manifest.json），不是可核验的候选包` });
  } else if (manifestRead.parseError) {
    errors.push({ source: 'pack-manifest', path: 'manifest.json', code: 'bad-pack-manifest', message: `候选 manifest.json JSON 解析失败: ${manifestRead.parseError.message}` });
  } else {
    packManifest = manifestRead.parsed;
    havePack = true;
  }

  let delta = null;
  let haveDelta = false;
  const deltaRead: any = readJsonFile({ absPath: path.join(packAbs, 'delta.json'), flag: '候选 delta.json', rootReal: packAbs, io, allowMissing: true });
  if (deltaRead.missing) {
    errors.push({ source: 'pack-delta', path: 'delta.json', code: 'missing-delta-json', message: '候选包内缺少 delta.json：本入口仅核验增量候选，缺 delta.json 的全包不能按增量候选核验' });
  } else if (deltaRead.parseError) {
    errors.push({ source: 'pack-delta', path: 'delta.json', code: 'bad-delta-json', message: `候选 delta.json JSON 解析失败: ${deltaRead.parseError.message}` });
  } else {
    delta = deltaRead.parsed;
    haveDelta = true;
  }

  let compatibility: any = null;
  if (haveBase && havePack && haveDelta) {
    const contentResult = verifyDeltaPackContent({ baseManifest, packManifest, delta });
    errors.push(...contentResult.errors);
    compatibility = contentResult.compatibility;
  }

  // 候选实际字节核验（复用现有清单核验）：候选 manifest.json 可解析时执行；
  // 结构错误/非空 unverified/缺失/字节或哈希不匹配都在此被拒。
  let packVerification = null;
  if (havePack) {
    const disk = verifyManifestEntries({ root: packAbs, manifest: packManifest, io });
    for (const e of disk.errors) errors.push({ ...e, source: 'pack-files' });
    packVerification = { ok: disk.ok, verified: disk.totals.verified, errorCount: disk.totals.errorCount };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'resource-pack-delta-verification',
    ok: errors.length === 0,
    root: rootReal,
    baseManifestPath: relFromRoot(rootReal, baseAbs),
    packPath: packRel,
    compatibility,
    packVerification,
    errors,
    scope: VERIFY_SCOPE,
    notes: compatibility && compatibility.candidate.actual.zeroAssets && errors.length === 0
      ? ['零资产候选（零差异或仅删除差异）通过核验；这不是已安装更新。']
      : [],
  };
}

export = { DELTA_KIND, VERIFY_SCOPE, verifyDeltaPackContent, verifyDeltaPack, UsageError };
