'use strict';

/**
 * scripts/lib/resource-manifest.js — 本地资源清单生成与校验（只读纯函数，schemaVersion 1）
 *
 * 职责（G5 批次）：
 *  - 显式 root 下 root/assets 普通文件清单：root 相对 posix 路径、字节数、SHA-256，路径按
 *    码元顺序稳定排序；generatedAt 仅信息性，不作为内容版本；首版以路径标识文件，
 *    不声称跨重命名身份稳定。
 *  - 校验清单：重复路径、非法/越界路径、文件缺失、字节或哈希不匹配；结构错误不得
 *    返回无条件成功。
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

const nodeFs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const SCHEMA_VERSION = 1;
const SCAN_ROOT = 'assets';
const EXCLUDED_PATHS = Object.freeze(['assets/character-references']);
const HEX_ESCAPE_RE = /%[0-9a-fA-F]{2}/;
const FORBIDDEN_CHARS_RE = /[\\:\u0000-\u001f\u007f]/;

/** 参数/环境级失败；CLI 捕获后退出 2，区别于目标内容问题（退出 1）。 */
class UsageError extends Error {}

function isExcluded(rel) {
  const value = process.platform === 'win32' ? rel.toLowerCase() : rel;
  return EXCLUDED_PATHS.some((p) => value === p || value.startsWith(p + '/'));
}

function isInsideRoot(rootReal, target) {
  const rel = path.relative(rootReal, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** 单字节字面解码：仅还原合法 %XX（含孤立 % 的文件名不受影响）；无变化返回 null。 */
function tryDecodePercent(text) {
  if (!text.includes('%')) return null;
  let out = '';
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && HEX_ESCAPE_RE.test(text.slice(i, i + 3))) {
      out += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
      changed = true;
    } else out += text[i];
  }
  return changed ? out : null;
}

/**
 * 清单路径合规检查（字面路径，非 URL）。返回 { ok: true } 或 { ok: false, code, message }。
 * 非法路径不得触发任何 fs 访问。
 */
function checkManifestPath(rel) {
  if (typeof rel !== 'string' || rel === '') return { ok: false, code: 'bad-entry', message: '路径必须是非空字符串' };
  if (FORBIDDEN_CHARS_RE.test(rel)) return { ok: false, code: 'illegal-path', message: '路径包含反斜杠、冒号或控制字符（Windows 分隔符/盘符/数据流形态不是资源路径）' };
  const normalized = path.posix.normalize(rel);
  if (normalized !== rel || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return { ok: false, code: 'illegal-path', message: `路径必须使用归一化的 root 相对 posix 形式，收到: ${rel}` };
  }
  const segments = normalized.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return { ok: false, code: 'illegal-path', message: '路径含空段或点段' };
  }
  if (normalized === SCAN_ROOT || !normalized.startsWith(SCAN_ROOT + '/')) {
    return { ok: false, code: 'out-of-scope', message: `条目必须在 ${SCAN_ROOT}/ 下` };
  }
  if (isExcluded(normalized)) {
    return { ok: false, code: 'out-of-scope', message: `条目位于排除域 ${EXCLUDED_PATHS.join(', ')} 内` };
  }
  if (normalized.includes('%')) {
    const decoded = tryDecodePercent(normalized);
    if (decoded !== null) {
      if (FORBIDDEN_CHARS_RE.test(decoded)) return { ok: false, code: 'illegal-path', message: '百分号解码后出现分隔符/盘符/控制字符（编码越界被拒绝）' };
      if (decoded.split('/').length !== segments.length || decoded.split('/').some((s) => s === '' || s === '.' || s === '..')) {
        return { ok: false, code: 'illegal-path', message: '百分号解码改变路径段结构（编码分隔符或编码穿越被拒绝）' };
      }
    }
  }
  return { ok: true };
}

/**
 * 真实路径边界检查：解析 absPath 的真实位置，要求落在 rootReal 内。目标不存在时
 * 向上找最近存在祖先（覆盖悬空链接），不能以「目标不存在」跳过边界。只解析路径，
 * 不读取任何文件内容；junction/symlink 越界在 stat/读取之前被拒绝。
 */
function resolveRealpathBoundary(io, absPath, rootReal) {
  let cur = absPath;
  const missingTail = [];
  for (;;) {
    let real;
    try {
      real = io.realpathSync(cur);
    } catch (err) {
      if (err.code === 'ENOENT') {
        const parent = path.dirname(cur);
        if (parent === cur) return { ok: false, code: 'realpath-error', message: '无法解析任何存在祖先的真实路径' };
        missingTail.unshift(path.basename(cur));
        cur = parent;
        continue;
      }
      return { ok: false, code: 'realpath-error', message: `realpath 失败: ${err.code || err.message}` };
    }
    const realTarget = missingTail.length ? path.join(real, ...missingTail) : real;
    if (isInsideRoot(rootReal, realTarget)) return { ok: true, realTarget };
    return { ok: false, code: 'realpath-outside-root', message: `真实路径 ${realTarget} 落在 root 外（junction/symlink 越界），未做任何读取` };
  }
}

function hashFile(io, abs) {
  return createHash('sha256').update(io.readFileSync(abs)).digest('hex');
}

function comparePath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 物理遍历 assets：符号链接/junction 不跟随不进入；目录仅作容器；异常目录单列。 */
function collectFiles(io, absDir, relPrefix, out) {
  let dirents;
  try {
    dirents = io.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    out.push({ kind: 'scan-error', path: relPrefix, message: `目录不可读: ${err.message}` });
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

function resolveRoot({ root, io }) {
  if (!root || typeof root !== 'string') throw new UsageError('root 缺失或不是字符串');
  let rootReal;
  try {
    rootReal = io.realpathSync(root);
  } catch (err) {
    throw new UsageError(`root 不可解析: ${err.message}`);
  }
  let st;
  try {
    st = io.statSync(rootReal);
  } catch (err) {
    throw new UsageError(`root 不可访问: ${err.message}`);
  }
  if (!st.isDirectory()) throw new UsageError('root 不是目录');
  return rootReal;
}

/**
 * 生成清单。io 可注入（测试用记录器包装真实 fs）；除打印外无任何写操作。
 * 扫描根缺失/非目录/真实路径越界为参数环境级失败（UsageError）。
 */
function generateManifest({ root, io = nodeFs } = {}) {
  const rootReal = resolveRoot({ root, io });
  const scanAbs = path.join(rootReal, SCAN_ROOT);
  let scanStat;
  try {
    scanStat = io.lstatSync(scanAbs);
  } catch (err) {
    throw new UsageError(`扫描根 ${SCAN_ROOT} 不可用: ${err.message}`);
  }
  if (scanStat.isSymbolicLink()) throw new UsageError(`扫描根 ${SCAN_ROOT} 是符号链接/junction，不跟随`);
  if (!scanStat.isDirectory()) throw new UsageError(`扫描根 ${SCAN_ROOT} 不是目录`);
  const scanBoundary = resolveRealpathBoundary(io, scanAbs, rootReal);
  if (!scanBoundary.ok) throw new UsageError(`扫描根 ${SCAN_ROOT} ${scanBoundary.message}`);

  const discovered = [];
  collectFiles(io, scanAbs, SCAN_ROOT, discovered);

  const entries = [];
  const unverified = [];
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
      unverified.push({ path: item.path, kind: 'stat-error', message: err.message });
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
      unverified.push({ path: item.path, kind: 'read-error', message: err.message });
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

/** 清单条目内容核验（不可信数据）：先结构，后合规，再边界，最后 stat/字节/哈希。 */
function verifyEntries(rootReal, manifest, io) {
  const errors = [];
  const push = (error) => errors.push(error);
  const done = () => ({ errors, listed: 0, uniquePaths: 0, byPath: new Map() });
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    push({ code: 'bad-manifest', message: '清单必须是 JSON 对象' });
    return done();
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    push({ code: 'unsupported-schema', message: `不支持的 schemaVersion: ${JSON.stringify(manifest.schemaVersion)}（本工具支持 ${SCHEMA_VERSION}）` });
    return done();
  }
  if (!Array.isArray(manifest.entries)) {
    push({ code: 'bad-manifest', message: 'entries 必须是数组' });
    return done();
  }
  if (manifest.unverified !== undefined) {
    if (!Array.isArray(manifest.unverified)) {
      push({ code: 'bad-manifest', message: 'unverified 必须是数组' });
    } else if (manifest.unverified.length) {
      push({ code: 'unverified-items', count: manifest.unverified.length, message: '清单仍包含未核验项；已列条目字节正确不代表完整清单通过' });
    }
  }
  const byPath = new Map();
  const pathIdentities = new Map();
  let listed = 0;
  for (const entry of manifest.entries) {
    listed++;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      push({ code: 'bad-entry', message: '条目必须是对象' });
      continue;
    }
    const { path: rel, bytes, sha256 } = entry;
    if (typeof rel !== 'string' || rel === '') {
      push({ code: 'bad-entry', message: '条目缺少非空字符串 path' });
      continue;
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      push({ path: rel, code: 'bad-entry', message: `bytes 必须是非负整数，收到 ${JSON.stringify(bytes)}` });
      continue;
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
      push({ path: rel, code: 'bad-entry', message: 'sha256 必须是 64 位十六进制字符串' });
      continue;
    }
    const identity = process.platform === 'win32' ? rel.toLowerCase() : rel;
    const previous = pathIdentities.get(identity);
    if (previous !== undefined && previous !== rel) {
      push({ path: rel, code: 'duplicate-path', message: '路径与 ' + previous + ' 指向相同的 Windows 路径' });
      push({ path: previous, code: 'duplicate-path', message: '路径存在 Windows 大小写重复条目' });
    }
    pathIdentities.set(identity, rel);
    byPath.set(rel, { count: (byPath.get(rel)?.count || 0) + 1, bytes, sha256 });
  }
  for (const [rel, record] of byPath) {
    if (record.count > 1) push({ path: rel, code: 'duplicate-path', message: `路径在清单中出现 ${record.count} 次` });
    const check = checkManifestPath(rel);
    if (!check.ok) {
      push({ path: rel, code: check.code, message: check.message });
      continue;
    }
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
      push({ path: rel, code: err.code === 'ENOENT' ? 'missing' : 'read-error', message: err.code === 'ENOENT' ? '清单条目对应的文件不存在' : err.message });
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
      push({ path: rel, code: 'read-error', message: err.message });
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
function verifyManifestEntries({ root, manifest, io = nodeFs } = {}) {
  const rootReal = resolveRoot({ root, io });
  const { errors, listed, uniquePaths, byPath } = verifyEntries(rootReal, manifest, io);
  const errorPaths = new Set(errors.map((e) => e.path).filter(Boolean));
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

/**
 * 校验 --manifest 指定的 root 内 JSON 文件。清单路径越界/不可读、root 问题抛
 * UsageError（退出 2）；JSON 解析失败与结构问题返回结果对象（退出 1）。
 */
function verifyManifest({ root, manifestPath, io = nodeFs } = {}) {
  if (!manifestPath || typeof manifestPath !== 'string') throw new UsageError('--manifest 缺失或不是字符串');
  const rootReal = resolveRoot({ root, io });
  const resolved = path.resolve(rootReal, manifestPath);
  if (!isInsideRoot(rootReal, resolved)) throw new UsageError(`--manifest 必须位于 root 内: ${manifestPath}`);
  const boundary = resolveRealpathBoundary(io, resolved, rootReal);
  if (!boundary.ok) throw new UsageError(`--manifest ${boundary.message}`);
  let raw;
  try {
    raw = io.readFileSync(resolved);
  } catch (err) {
    throw new UsageError(`--manifest 不可读取: ${err.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: 'resource-manifest-verification',
      root: rootReal,
      ok: false,
      totals: { listed: 0, uniquePaths: 0, verified: 0, failedPaths: 0, errorCount: 1 },
      errors: [{ code: 'bad-manifest', message: `清单 JSON 解析失败: ${err.message}` }],
    };
  }
  const result = verifyManifestEntries({ root: rootReal, manifest, io });
  result.manifestPath = path.relative(rootReal, resolved).split(path.sep).join('/');
  return result;
}

module.exports = { SCHEMA_VERSION, SCAN_ROOT, EXCLUDED_PATHS, UsageError, generateManifest, verifyManifest, verifyManifestEntries, checkManifestPath, resolveRealpathBoundary };
