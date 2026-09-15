import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { createHash }: typeof import('node:crypto') = require('node:crypto');

// All generated records live here. It is excluded from BOTH content identities.
const EVIDENCE_DIR = 'runtime/delivery-evidence';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
}
function relative(value, allowRoot = false) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f:]/.test(value)
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw Error('路径必须为 root 内相对路径');
  const result = value.replaceAll('\\', '/');
  if (allowRoot && result === '.') return result;
  if (result.split('/').some(v => !v || v === '.' || v === '..' || /[. ]$/.test(v))) throw Error('路径含不安全或不规范的分段');
  return result;
}
const within = (parent, child) => child === parent || child.startsWith(`${parent}/`);
function excluded(name) {
  const lower = name.toLowerCase();
  return within(EVIDENCE_DIR, lower) || lower.split('/').includes('.git');
}
function evidencePath(value) {
  const name = relative(value);
  if (!within(EVIDENCE_DIR, name.toLowerCase()) || name.toLowerCase() === EVIDENCE_DIR) throw Error(`证据必须位于 ${EVIDENCE_DIR}/`);
  return name;
}
function rootPath(value) {
  const root = fs.realpathSync(value);
  if (!fs.statSync(root).isDirectory()) throw Error('root 不是目录');
  return root;
}
// Reject links even when they point inside root: aliases could bypass exclusions,
// introduce cycles, or make a saved evidence file part of its own source identity.
function resolveSafe(root, value, allowMissing = false) {
  const name = relative(value, true);
  let current = root;
  for (const part of name === '.' ? [] : name.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (allowMissing && runtimeErrorCode(error) === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw Error(`不允许 symlink/junction: ${name}`);
    const rel = path.relative(root, fs.realpathSync(current));
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw Error(`真实路径越过 root: ${name}`);
  }
  return current;
}
function fileEntry(root, name) {
  let fd;
  try {
    const file = resolveSafe(root, name);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink > 1) throw Error('目标必须为无硬链接的普通文件');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0, size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, size)); bytes += size; }
    const after = fs.fstatSync(fd);
    const visible = fs.lstatSync(resolveSafe(root, name));
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || after.ino !== visible.ino || after.dev !== visible.dev) throw Error('读取期间文件发生变化');
    return { path: name, status: 'file', bytes, sha256: hash.digest('hex') };
  } catch (error) {
    return { path: name, status: runtimeErrorCode(error) === 'ENOENT' ? 'missing' : 'unsafe-or-unreadable', message: runtimeErrorMessage(error) };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readJson(root, name, dedicated = false) {
  name = dedicated ? evidencePath(name) : relative(name);
  const entry = fileEntry(root, name);
  if (entry.status !== 'file') throw Error(`${name}: ${entry.message}`);
  const raw = fs.readFileSync(resolveSafe(root, name), 'utf8');
  if (sha256(Buffer.from(raw)) !== entry.sha256) throw Error(`读取期间记录发生变化: ${name}`);
  const value = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!object(value)) throw Error(`记录必须为 JSON 对象: ${name}`);
  return { value, entry };
}
function saveJson(root, name, value) {
  name = evidencePath(name);
  if (!name.endsWith('.json')) throw Error('--save 必须为 .json 文件');
  resolveSafe(root, name, true);
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = resolveSafe(root, parts.slice(0, i).join('/'), true);
    try { fs.mkdirSync(dir); } catch (error) { if (runtimeErrorCode(error) !== 'EEXIST') throw error; }
    if (!fs.statSync(resolveSafe(root, parts.slice(0, i).join('/'))).isDirectory()) throw Error('证据父路径不是目录');
  }
  // Exclusive creation preserves earlier evidence; an existing file is never overwritten.
  fs.writeFileSync(resolveSafe(root, name, true), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}
export = { EVIDENCE_DIR, object, canonical, sha256, relative, within, excluded, evidencePath, rootPath, resolveSafe, fileEntry, readJson, saveJson };
