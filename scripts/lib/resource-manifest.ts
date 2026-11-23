import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
import type { ManifestEntry, ManifestIssue } from './resource-manifest-types';
import { SCAN_ROOT, EXCLUDED_PATHS, UsageError, checkManifestPath, isExcluded, isInsideRoot, resolveRealpathBoundary, resolveRoot, type ManifestOptions } from './resource-manifest/paths';
import { SCHEMA_VERSION, DIFF_SCOPE, comparePath, parseManifestStructure, compareManifests } from './resource-manifest/schema';

/**
 * scripts/lib/resource-manifest.js — 本地资源清单生成与校验（只读纯函数，schemaVersion 1）
 *
 * 职责（G5 批次，G7 增补差异比较）：
 *  - 显式 root 下 root/assets 普通文件清单：root 相对 posix 路径、字节数、SHA-256，路径按
 *    码元顺序稳定排序；generatedAt 仅信息性，不作为内容版本；首版以路径标识文件，
 *    不声称跨重命名身份稳定。
 *  - 校验清单：重复路径、非法/越界路径、文件缺失、字节或哈希不匹配；结构错误不得
 *    返回无条件成功。
 *  - 比较两份清单（G7）：纯函数，不触 fs、不读取实际资产；先做与核验一致的结构检查，
 *    再按精确路径输出新增/移除/改变/未改变。不用 generatedAt 判定新旧，不按相同哈希
 *    猜测重命名；非空 unverified 或结构错误时不得得出「完整一致」的成功结论。
 *  - 只读：不写、不下载、不转换、不删除；清单落盘由调用者显式重定向。
 *
 * 路径边界复用 glm-next-b/RB 夹具已验证的经验（未整搬临时脚本）：
 *  - 清单路径按字面文件路径处理（非 URL，不拆 query/fragment）。含 %XX 时做单字节
 *    字面解码核对：解码引入反斜杠/冒号/控制字符、改变段结构或引入空/点段即拒绝
 *    （编码反斜杠与编码穿越先于任何 fs 访问被拒）；无有效转义或解码无害（如字面
 *    文件名 my%20file.txt）按字面接受。
 *  - stat/读取之前先做真实路径边界检查；目标不存在时沿最近存在祖先解析，
 *    junction/symlink 指向 root 外即拒绝，不以「目标不存在」跳过边界。
 *  - 目录遍历不跟随符号链接/junction；非普通文件、目录不可读、无法合规表示的
 *    文件名单列 unverified，不伪造完整覆盖。
 *
 * 生成端从 realpath(root)/assets 物理遍历，不进入任何链接，因此记录路径的中间
 * 段天然无链接，不需要逐文件 realpath；校验端面对不可信清单，逐条先做边界检查。
 * 哈希相等只证明字节一致；文件存在不代表内容已交付、图片质量或审核通过。
 */

const nodeFs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { createHash }: typeof import('node:crypto') = require('node:crypto');

type ScanItem = { kind: string; path: string; message?: string };

function hashFile(io: typeof import("node:fs"), abs: string) {
  const fd = io.openSync(abs, 'r');
  try {
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let size;
    while ((size = io.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { io.closeSync(fd); }
}

/** 物理遍历 assets：符号链接/junction 不跟随不进入；目录仅作容器；异常目录单列。 */
function collectFiles(io: typeof import("node:fs"), absDir: string, relPrefix: string, out: ScanItem[]) {
  let dirents;
  try {
    dirents = io.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    out.push({ kind: 'scan-error', path: relPrefix, message: `目录不可读: ${runtimeErrorMessage(err)}` });
    return;
  }
  dirents.sort((a, b) => comparePath(a.name, b.name));
  for (const dirent of dirents) {
    const childPath = `${relPrefix}/${dirent.name}`;
    if (isExcluded(childPath)) continue;
    if (dirent.isSymbolicLink()) {
      out.push({ kind: 'symlink', path: childPath, message: '符号链接/junction 不跟随、不哈希；真实目标未知' });
    } else if (dirent.isDirectory()) {
      collectFiles(io, path.join(absDir, dirent.name), childPath, out);
    } else if (dirent.isFile()) {
      out.push({ kind: 'file', path: childPath });
    } else {
      out.push({ kind: 'not-regular-file', path: childPath, message: '非普通文件（FIFO/设备等），不哈希' });
    }
  }
}

/**
 * 生成清单。io 可注入（测试用记录器包装真实 fs）；除打印外无任何写操作。
 * 扫描根缺失/非目录/真实路径越界为参数环境级失败（UsageError）。
 */
function generateManifest({ root, io = nodeFs }: ManifestOptions) {
  const rootReal = resolveRoot({ root, io });
  const scanAbs = path.join(rootReal, SCAN_ROOT);
  let scanStat;
  try {
    scanStat = io.lstatSync(scanAbs);
  } catch (err) {
    throw new UsageError(`扫描根 ${SCAN_ROOT} 不可用: ${runtimeErrorMessage(err)}`);
  }
  if (scanStat.isSymbolicLink()) throw new UsageError(`扫描根 ${SCAN_ROOT} 是符号链接/junction，不跟随`);
  if (!scanStat.isDirectory()) throw new UsageError(`扫描根 ${SCAN_ROOT} 不是目录`);
  const scanBoundary = resolveRealpathBoundary(io, scanAbs, rootReal);
  if (!scanBoundary.ok) throw new UsageError(`扫描根 ${SCAN_ROOT} ${scanBoundary.message}`);

  const discovered: ScanItem[] = [];
  collectFiles(io, scanAbs, SCAN_ROOT, discovered);

  const entries: ManifestEntry[] = [];
  const unverified: ScanItem[] = [];
  for (const item of discovered) {
    if (item.kind !== 'file') {
      unverified.push({ path: item.path, kind: item.kind, message: item.message });
      continue;
    }
    const check = checkManifestPath(item.path);
    if (!check.ok) {
      unverified.push({ path: item.path, kind: 'unrepresentable-path', message: check.message });
      continue;
    }
    const abs = path.join(rootReal, ...item.path.split('/'));
    let st;
    try {
      st = io.statSync(abs);
    } catch (err) {
      unverified.push({ path: item.path, kind: 'stat-error', message: runtimeErrorMessage(err) });
      continue;
    }
    if (!st.isFile()) {
      unverified.push({ path: item.path, kind: 'not-regular-file', message: '扫描与 stat 之间不再是普通文件' });
      continue;
    }
    let sha256;
    try {
      sha256 = hashFile(io, abs);
    } catch (err) {
      unverified.push({ path: item.path, kind: 'read-error', message: runtimeErrorMessage(err) });
      continue;
    }
    entries.push({ path: item.path, bytes: st.size, sha256 });
  }
  entries.sort((a, b) => comparePath(a.path, b.path));
  unverified.sort((a, b) => comparePath(a.path, b.path));
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'resource-manifest',
    generatedAt: new Date().toISOString(),
    root: rootReal,
    scope: {
      scanRoot: `${SCAN_ROOT}/`,
      excluded: [...EXCLUDED_PATHS],
      followsSymbolicLinks: false,
      pathIdentity: 'root 相对 posix 路径；首版以路径标识文件，不声称跨重命名身份稳定',
      coverageNote: '排除域不遍历不计入 totals；unverified 单列（符号链接、非普通文件、目录不可读、无法合规表示的文件名），不伪造完整覆盖',
    },
    totals: { files: entries.length, bytes: entries.reduce((acc, e) => acc + e.bytes, 0), unverified: unverified.length },
    entries,
    unverified,
  };
}

/** 清单条目内容核验（不可信数据）：先结构，再边界，最后 stat/字节/哈希。 */
function verifyEntries(rootReal: string, manifest: unknown, io: typeof import("node:fs")) {
  const { errors, listed, byPath, invalidPaths } = parseManifestStructure(manifest);
  const push = (error: ManifestIssue) => errors.push(error);
  for (const [rel, record] of byPath) {
    if (invalidPaths.has(rel)) continue;
    const abs = path.join(rootReal, ...rel.split('/'));
    const boundary = resolveRealpathBoundary(io, abs, rootReal);
    if (!boundary.ok) {
      push({ path: rel, code: boundary.code, message: boundary.message });
      continue;
    }
    const realRel = path.relative(rootReal, boundary.realTarget).split(path.sep).join('/');
    const realCheck = checkManifestPath(realRel);
    if (!realCheck.ok) {
      push({ path: rel, code: 'out-of-scope', message: '真实目标不在允许资源域内或位于排除域，未读取文件' });
      continue;
    }
    let st;
    try {
      st = io.statSync(abs);
    } catch (err) {
      push({ path: rel, code: runtimeErrorCode(err) === 'ENOENT' ? 'missing' : 'read-error', message: runtimeErrorCode(err) === 'ENOENT' ? '清单条目对应的文件不存在' : runtimeErrorMessage(err) });
      continue;
    }
    if (!st.isFile()) {
      push({ path: rel, code: 'not-file', message: '对应路径不是普通文件（目录或其他）' });
      continue;
    }
    if (st.size !== record.bytes) {
      push({ path: rel, code: 'size-mismatch', expected: record.bytes, actual: st.size, message: `字节数不匹配：清单 ${record.bytes}，实际 ${st.size}` });
      continue;
    }
    let actual;
    try {
      actual = hashFile(io, abs);
    } catch (err) {
      push({ path: rel, code: 'read-error', message: runtimeErrorMessage(err) });
      continue;
    }
    if (actual !== record.sha256.toLowerCase()) {
      push({ path: rel, code: 'hash-mismatch', expected: record.sha256.toLowerCase(), actual, message: 'SHA-256 不匹配：实际内容与清单记录不一致' });
    }
  }
  errors.sort((a, b) => comparePath(a.path || '', b.path || '') || comparePath(a.code, b.code));
  return { errors, listed, uniquePaths: byPath.size, byPath };
}

/**
 * 校验内存清单对象（测试/调用者可直接传入）。返回结果对象，不抛内容性错误。
 */
function verifyManifestEntries({ root, manifest, io = nodeFs }: ManifestOptions & { manifest: unknown }) {
  const rootReal = resolveRoot({ root, io });
  const { errors, listed, uniquePaths, byPath } = verifyEntries(rootReal, manifest, io);
  const errorPaths = new Set(errors.map((e) => e.path).filter((e): e is string => Boolean(e)));
  // verified/failedPaths 只统计结构合法的唯一路径；bad-entry 等无 path 或路径未入
  // 索引的结构错误只计入 errorCount，不虚增 verified，也不使 verified 变负。
  const failedPaths = [...byPath].filter(([rel]) => errorPaths.has(rel)).map(([rel]) => rel);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'resource-manifest-verification',
    root: rootReal,
    ok: errors.length === 0,
    totals: { listed, uniquePaths, verified: uniquePaths - failedPaths.length, failedPaths: failedPaths.length, errorCount: errors.length },
    errors,
  };
}

/** 读取 root 内指定清单文件（--manifest/--compare-manifest 共用）：路径与真实路径
 *  边界检查先于任何读取；越界/不可读抛 UsageError（退出 2）。 */
function readManifestFile(rootReal: string, manifestPath: string, flag: string, io: typeof import("node:fs")) {
  const resolved = path.resolve(rootReal, manifestPath);
  if (!isInsideRoot(rootReal, resolved)) throw new UsageError(`${flag} 必须位于 root 内: ${manifestPath}`);
  const boundary = resolveRealpathBoundary(io, resolved, rootReal);
  if (!boundary.ok) throw new UsageError(`${flag} ${boundary.message}`);
  let raw;
  try {
    raw = io.readFileSync(resolved);
  } catch (err) {
    throw new UsageError(`${flag} 不可读取: ${runtimeErrorMessage(err)}`);
  }
  return { resolved, raw };
}

/** root 相对 posix 形式的清单路径（结果标注用）。 */
function manifestRelPath(rootReal: string, resolved: string) {
  return path.relative(rootReal, resolved).split(path.sep).join('/');
}

/**
 * 校验 --manifest 指定的 root 内 JSON 文件。清单路径越界/不可读、root 问题抛
 * UsageError（退出 2）；JSON 解析失败与结构问题返回结果对象（退出 1）。
 */
function verifyManifest({ root, manifestPath, io = nodeFs }: { root: string; manifestPath: string; io?: typeof import('node:fs') } ) {
  if (!manifestPath || typeof manifestPath !== 'string') throw new UsageError('--manifest 缺失或不是字符串');
  const rootReal = resolveRoot({ root, io });
  const { resolved, raw } = readManifestFile(rootReal, manifestPath, '--manifest', io);
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: 'resource-manifest-verification',
      root: rootReal,
      ok: false,
      totals: { listed: 0, uniquePaths: 0, verified: 0, failedPaths: 0, errorCount: 1 },
      errors: [{ code: 'bad-manifest', message: `清单 JSON 解析失败: ${runtimeErrorMessage(err)}` }],
    };
  }
  const result = verifyManifestEntries({ root: rootReal, manifest, io });
  return { ...result, manifestPath: manifestRelPath(rootReal, resolved) };
}

/**
 * 读取 root 内两份指定清单并比较（G7）。只读取这两份 JSON，不读取/哈希实际
 * assets；旧清单已移除的文件不因当前磁盘缺失而无法比较。清单路径越界/不可读、
 * root 问题抛 UsageError（退出 2）；JSON 解析失败与结构问题返回结果对象（退出 1）。
 */
function compareManifestFiles({ root, manifestPath, compareManifestPath, io = nodeFs }: { root: string; manifestPath: string; compareManifestPath: string; io?: typeof nodeFs }) {
  if (!manifestPath || typeof manifestPath !== 'string') throw new UsageError('--manifest 缺失或不是字符串（差异比较需要 --manifest <旧清单> 与 --compare-manifest <新清单>）');
  if (!compareManifestPath || typeof compareManifestPath !== 'string') throw new UsageError('--compare-manifest 缺失或不是字符串（差异比较需要 --manifest <旧清单> 与 --compare-manifest <新清单>）');
  const rootReal = resolveRoot({ root, io });
  const oldRead = readManifestFile(rootReal, manifestPath, '--manifest', io);
  const newRead = readManifestFile(rootReal, compareManifestPath, '--compare-manifest', io);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'resource-manifest-diff',
    root: rootReal,
    oldManifestPath: manifestRelPath(rootReal, oldRead.resolved),
    newManifestPath: manifestRelPath(rootReal, newRead.resolved),
  };
  let oldManifest: unknown = null;
  let newManifest: unknown = null;
  const parseErrors = [];
  try {
    oldManifest = JSON.parse(oldRead.raw.toString('utf8'));
  } catch (err) {
    parseErrors.push({ side: 'old', code: 'bad-manifest', message: `旧清单 JSON 解析失败: ${runtimeErrorMessage(err)}` });
  }
  try {
    newManifest = JSON.parse(newRead.raw.toString('utf8'));
  } catch (err) {
    parseErrors.push({ side: 'new', code: 'bad-manifest', message: `新清单 JSON 解析失败: ${runtimeErrorMessage(err)}` });
  }
  if (parseErrors.length) {
    return { ...base, ok: false, identical: false, totals: { added: 0, removed: 0, changed: 0, unchanged: 0 }, added: [], removed: [], changed: [], errors: parseErrors, scope: DIFF_SCOPE };
  }
  return { ...base, ...compareManifests({ oldManifest, newManifest }) };
}

export = { SCHEMA_VERSION, UsageError, generateManifest, verifyManifest, verifyManifestEntries, compareManifests, compareManifestFiles, checkManifestPath, resolveRealpathBoundary, resolveRoot };
