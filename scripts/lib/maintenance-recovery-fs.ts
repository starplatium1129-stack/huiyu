import { errorCode as runtimeErrorCode } from './runtime-errors';
'use strict';

// Shared filesystem boundary. No function creates anything unless explicitly asked.
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const { VERSIONED_FILES }: typeof import('./data-version') = require('./data-version');

function failure(code: any, message: any) {
  return Object.assign(new Error(message), { code, statusCode: 409, recoveryRequired: true });
}
const keyPath = (value: any) => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a: any, b: any) => keyPath(path.resolve(a)) === keyPath(path.resolve(b));
function within(parent: any, file: any) {
  const relative = path.relative(keyPath(path.resolve(parent)), keyPath(path.resolve(file)));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function canonical(value: any): any {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = (bytes: any) => crypto.createHash('sha256').update(bytes).digest('hex');
const equal = (a: any, b: any) => canonical(a) === canonical(b);

function stat(file: any) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (runtimeErrorCode(error) === 'ENOENT') return null; throw error; }
}
function safePath(file: any, kind = 'file', allowMissing = true) {
  const abs = path.resolve(file);
  const parsed = path.parse(abs);
  let cursor = parsed.root;
  const segments = abs.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (/[\x00-\x1f:*?"<>|]/.test(segment) || /[. ]$/.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) throw failure('MAINTENANCE_PATH', '不安全的路径：' + abs);
    cursor = path.join(cursor, segment);
    const info = stat(cursor);
    if (!info) {
      if (allowMissing) return null;
      throw failure('MAINTENANCE_PATH', '路径不存在：' + cursor);
    }
    const last = index === segments.length - 1;
    if (info.isSymbolicLink() || !samePath(fs.realpathSync(cursor), cursor)) throw failure('MAINTENANCE_PATH', '拒绝符号链接或 junction：' + cursor);
    if ((!last || kind === 'directory') ? !info.isDirectory() : !info.isFile()) throw failure('MAINTENANCE_PATH', '文件类型不符：' + cursor);
    if (last && info.isFile() && info.nlink !== 1n) throw failure('MAINTENANCE_PATH', '拒绝硬链接文件：' + cursor);
    if (last) return info;
  }
  if (kind !== 'directory') throw failure('MAINTENANCE_PATH', '目标不能是文件系统根');
  return stat(abs);
}
function directoryIdentity(file: any) {
  const info = safePath(file, 'directory', false);
  return { path: keyPath(path.resolve(file)), dev: String(info!.dev), ino: String(info!.ino) };
}
function ensureDirectory(file: any) {
  if (safePath(file, 'directory')) return;
  ensureDirectory(path.dirname(file));
  try { fs.mkdirSync(file); } catch (error) { if (runtimeErrorCode(error) !== 'EEXIST') throw error; }
  safePath(file, 'directory', false);
}
function syncDirectory(dir: any) {
  // Windows does not expose directory fsync through Node. File contents are flushed.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readBytes(file: any, allowMissing = false) {
  const before = safePath(file, 'file', allowMissing);
  if (!before) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== opened.dev || before.ino !== opened.ino || !opened.isFile()) throw failure('MAINTENANCE_CONFLICT', '读取期间文件被替换：' + file);
    const bytes = fs.readFileSync(fd);
    const after = safePath(file, 'file', false);
    if (after!.ino !== before.ino || after!.dev !== before.dev || after!.size !== before.size || after!.mtimeNs !== before.mtimeNs) throw failure('MAINTENANCE_CONFLICT', '读取期间文件发生变化：' + file);
    return bytes;
  } finally { fs.closeSync(fd); }
}
function fileState(file: any) {
  const bytes = readBytes(file, true);
  if (bytes === null) return { exists: false, sha256: null, size: 0 };
  return { exists: true, sha256: digest(bytes), size: bytes.length };
}
function snapshotFiles(files: any) {
  const seen = new Set();
  return files.filter((file: any) => { const key = keyPath(path.resolve(file)); if (seen.has(key)) return false; seen.add(key); return true; }).map((file: any) => {
    file = path.resolve(file);
    const content = readBytes(file, true);
    return { file, exists: content !== null, content };
  });
}
function atomicWrite(file: any, bytes: any, createParents = false) {
  if (createParents) ensureDirectory(path.dirname(file));
  safePath(path.dirname(file), 'directory', false);
  const old = safePath(file);
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
  let owned = false;
  try {
    const fd = fs.openSync(temp, 'wx', old ? Number(old.mode & 0o777n) : 0o600);
    owned = true;
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    safePath(file);
    fs.renameSync(temp, file);
    owned = false;
    syncDirectory(path.dirname(file));
  } finally {
    if (owned) { try { fs.unlinkSync(temp); } catch { /* Only this call's temporary file. */ } }
  }
}
function removeFile(file: any) {
  if (!safePath(file)) return;
  fs.unlinkSync(file);
  syncDirectory(path.dirname(file));
}
function writeJson(file: any, value: any) { atomicWrite(file, JSON.stringify(value, null, 2) + '\n'); }
function readJson(file: any) {
  const bytes = readBytes(file);
  if (bytes!.length > 32 * 1024 * 1024) throw failure('MAINTENANCE_INVALID_JOURNAL', '元数据过大');
  try { return JSON.parse(bytes!.toString('utf8')); }
  catch { throw failure('MAINTENANCE_INVALID_JOURNAL', '元数据不是有效 JSON：' + file); }
}

function context(options: any = {}) {
  if (!options.rootDir) throw failure('MAINTENANCE_ARGUMENT', '必须明确指定 rootDir');
  const rootDir = path.resolve(options.rootDir);
  const root = directoryIdentity(rootDir);
  const runtimeRoot = path.resolve(options.runtimeRoot || path.join(rootDir, 'runtime'));
  if (samePath(runtimeRoot, rootDir) || !path.dirname(runtimeRoot) || samePath(runtimeRoot, path.parse(runtimeRoot).root)
    || ['data', 'src', '.git'].some(name => samePath(path.join(rootDir, name), runtimeRoot) || within(path.join(rootDir, name), runtimeRoot))) {
    throw failure('MAINTENANCE_PATH', 'runtime 必须是独立目录');
  }
  safePath(runtimeRoot, 'directory');
  // A fixed root-local anchor prevents two runtime configurations from bypassing each other.
  const stateDir = path.join(rootDir, 'runtime', 'maintenance-transactions');
  safePath(stateDir, 'directory');
  const showcaseRoot = options.showcaseRoot ? path.resolve(options.showcaseRoot) : null;
  if (showcaseRoot) {
    safePath(showcaseRoot, 'directory', false);
    if (samePath(showcaseRoot, rootDir) || within(showcaseRoot, rootDir)
      || ['data', 'src', '.git', 'runtime'].some(name => samePath(path.join(rootDir, name), showcaseRoot) || within(path.join(rootDir, name), showcaseRoot))
      || samePath(showcaseRoot, runtimeRoot) || within(runtimeRoot, showcaseRoot) || within(showcaseRoot, runtimeRoot)) throw failure('MAINTENANCE_PATH', '样张根与受保护范围重叠');
  }
  return { rootDir, root, runtimeRoot, showcaseRoot, stateDir, leaseDir: path.join(stateDir, 'lease'), backupRoot: path.join(runtimeRoot, 'maintenance-backups') };
}
const DATA_NAMES = new Set([...VERSIONED_FILES, 'retired-scenes.json']);
function targetPath(ctx: any, source: any) {
  if (typeof source !== 'string' || !path.isAbsolute(source)) throw failure('MAINTENANCE_PATH', '备份 source 必须是绝对路径');
  const file = path.resolve(source);
  const relative = path.relative(ctx.rootDir, file).replace(/\\/g, '/');
  const stem = relative.replace(/\.(gz|br)$/, '');
  const inData = stem.startsWith('data/') && (DATA_NAMES.has(stem.slice(5)) || /^data\/(scenes|blueprints|popular)\/[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(stem));
  if (within(ctx.rootDir, file) && (inData || relative === 'src/stores/sceneStore.ts')) {
    safePath(file);
    return file;
  }
  if (ctx.showcaseRoot && within(ctx.showcaseRoot, file)) {
    const rel = path.relative(ctx.showcaseRoot, file).replace(/\\/g, '/');
    if (/^(manifest|home-hero)\.json$/.test(rel) || /^(images|thumbs|home)\/[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(rel)) { safePath(file); return file; }
  }
  throw failure('MAINTENANCE_UNSUPPORTED_SCOPE', '未授权的恢复范围；外部样张必须显式配置 showcaseRoot：' + file);
}
function readKey(ctx: any, create = false) {
  const file = path.join(ctx.stateDir, 'key');
  if (create) {
    ensureDirectory(ctx.stateDir);
    if (!safePath(file)) {
      let fd;
      try { fd = fs.openSync(file, 'wx', 0o600); }
      catch (error) { if (runtimeErrorCode(error) !== 'EEXIST') throw error; }
      if (fd !== undefined) { try { fs.writeFileSync(fd, crypto.randomBytes(32)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    }
  }
  const key = readBytes(file);
  if (key!.length !== 32) throw failure('MAINTENANCE_INVALID_JOURNAL', '维护签名密钥不完整，拒绝恢复');
  return key;
}
function seal(value: any, key: any) { return { ...value, hmacSha256: crypto.createHmac('sha256', key).update(canonical(value)).digest('hex') }; }
function unseal(value: any, key: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('MAINTENANCE_INVALID_JOURNAL', '签名记录格式无效');
  const { hmacSha256, ...body } = value;
  const expected = seal(body, key).hmacSha256;
  if (typeof hmacSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(hmacSha256)
    || !crypto.timingSafeEqual(Buffer.from(hmacSha256, 'hex'), Buffer.from(expected, 'hex'))) throw failure('MAINTENANCE_INVALID_JOURNAL', '元数据签名不匹配，拒绝篡改或损坏记录');
  return body;
}

export = { fs, path, crypto, failure, keyPath, samePath, within, canonical, digest, equal, stat, safePath, directoryIdentity,
  ensureDirectory, syncDirectory, readBytes, fileState, snapshotFiles, atomicWrite, removeFile, writeJson, readJson, context, targetPath, readKey, seal, unseal };
