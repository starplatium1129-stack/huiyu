import { errorCode as runtimeErrorCode } from './runtime-errors';
'use strict';

// Private, local resource storage. No app files, artwork, links, or package code are executed.
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const { randomUUID, createHash }: typeof import('node:crypto') = require('node:crypto');

interface LockOwner { host: string; pid: number; token: string; }
interface ResourceContext {
  io: typeof fs;
  userRoot: string;
  store: string;
  policy: any;
  access?: { isLocalStudioHost?: () => boolean; isAuthorized?: () => boolean };
  onEvent?: (event: { phase: string; [key: string]: any }) => any;
  freeBytes?: () => number;
}
interface ContextOptions {
  userDataRoot: string;
  io?: typeof fs;
  protectedRoots?: string[];
  policy?: any;
  access?: { isLocalStudioHost?: () => boolean; isAuthorized?: () => boolean };
  onEvent?: (event: { phase: string; [key: string]: any }) => any;
  freeBytes?: () => number;
}

const STORE_NAME = 'resource-library-v1';
const MARKER = { schemaVersion: 1, kind: 'aics-resource-library' };
const MAX_JSON = 16 * 1024 * 1024;

class ResourceError extends Error {
  code: string;
  details?: any;
  constructor(code: string, message: string, details?: any) {
    super(message);
    this.name = 'ResourceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
function fail(code: string, message: string, details?: any): never { throw new ResourceError(code, message, details); }
function digest(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}
function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function relativePath(value: string): string {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f\x7f<>"|?*]/.test(value)
    || path.posix.normalize(value) !== value || value.startsWith('/')) fail('UNSAFE_PATH', 'Expected a relative POSIX path');
  const segments = value.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) {
      fail('UNSAFE_PATH', 'Windows path alias or reserved name rejected');
    }
    const decoded = segment.replace(/%([\da-f]{2})/gi, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded !== segment && (/[\\/:\x00-\x1f\x7f]/.test(decoded) || decoded === '.' || decoded === '..')) {
      fail('UNSAFE_PATH', 'Encoded path separator or traversal rejected');
    }
  }
  return value;
}
function child(root: string, rel: string): string {
  relativePath(rel);
  const target = path.join(root, ...rel.split('/'));
  if (!within(root, target) || samePath(root, target)) fail('UNSAFE_PATH', 'Path escapes dedicated root');
  return target;
}

// Check every existing ancestor, including the selected root. Missing leaves do not bypass this.
function noLinks(io: typeof fs, target: string, options: { missing?: boolean; hardlinks?: boolean } = {}): import('node:fs').Stats | null {
  const { missing = false, hardlinks = false } = options;
  const absolute = path.resolve(target);
  if (/^(\\\\|\/\/)/.test(absolute)) fail('UNSAFE_PATH', 'Network filesystem roots are not supported');
  const volume = path.parse(absolute).root;
  const parts = path.relative(volume, absolute).split(path.sep).filter(Boolean);
  let cursor = volume;
  let stat = io.lstatSync(volume);
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    try { stat = io.lstatSync(cursor); } catch (error) {
      if (runtimeErrorCode(error) === 'ENOENT' && missing) return null;
      throw error;
    }
    if (stat.isSymbolicLink()) fail('UNSAFE_LINK', 'Symlink/junction rejected: ' + cursor);
    let resolved;
    try { resolved = io.realpathSync(cursor); } catch (error) {
      // A concurrent lock owner may release this file after lstat. Only callers
      // already allowing missing paths can treat that as an absent claim.
      if (missing && runtimeErrorCode(error) === 'ENOENT') return null;
      throw error;
    }
    if (!samePath(cursor, resolved)) fail('UNSAFE_LINK', 'Symlink/junction rejected: ' + cursor);
    if (index < parts.length - 1 && !stat.isDirectory()) fail('UNSAFE_PATH', 'Non-directory ancestor');
    if (!stat.isDirectory() && !stat.isFile()) fail('UNSAFE_FILE', 'Only ordinary files and directories are accepted');
    if (stat.isFile() && stat.nlink !== 1 && !hardlinks) fail('UNSAFE_LINK', 'Hard-linked resource or metadata rejected');
  }
  return stat;
}
function mkdir(io: typeof fs, target: string): void {
  noLinks(io, target, { missing: true });
  io.mkdirSync(target, { recursive: true });
  const existingStat = noLinks(io, target);
  if (!existingStat || !existingStat.isDirectory()) fail('UNSAFE_PATH', 'Expected a directory');
}
function readBytes(io: typeof fs, target: string, max: number = MAX_JSON, hardlinks: boolean = false): Buffer {
  const st = noLinks(io, target, { hardlinks });
  if (!st || !st.isFile() || st.size > max) fail('METADATA_INVALID', 'Metadata must be a bounded ordinary file');
  const fd = io.openSync(target, 'r');
  try {
    const opened = io.fstatSync(fd);
    noLinks(io, target, { hardlinks });
    if (opened.ino !== st.ino || opened.dev !== st.dev || opened.size !== st.size) fail('FILE_CHANGED', 'Metadata changed while opening');
    const bytes = io.readFileSync(fd);
    if (bytes.length > max) fail('METADATA_INVALID', 'Metadata exceeds size limit');
    return bytes;
  } finally { io.closeSync(fd); }
}
function readJson(io: typeof fs, target: string, optional: boolean = false, hardlinks: boolean = false): any {
  try { return JSON.parse(readBytes(io, target, MAX_JSON, hardlinks).toString('utf8')); } catch (error) {
    if (optional && runtimeErrorCode(error) === 'ENOENT') return null;
    if (error instanceof SyntaxError) fail('METADATA_INVALID', 'Invalid JSON: ' + target);
    throw error;
  }
}
function flushDir(io: typeof fs, target: string): void {
  // Node cannot portably FlushFileBuffers on a Windows directory. File bytes are fsynced;
  // process interruption is covered, sudden power loss still requires native device acceptance.
  if (process.platform === 'win32') return;
  const fd = io.openSync(target, 'r');
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
function writeAll(io: typeof fs, fd: number, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) fail('WRITE_FAILED', 'Write made no progress');
    offset += written;
  }
}
function writeAtomic(io: typeof fs, target: string, bytes: Buffer): void {
  noLinks(io, target, { missing: true });
  const tmp = path.join(path.dirname(target), '.' + path.basename(target) + '.' + randomUUID() + '.tmp');
  const fd = io.openSync(tmp, 'wx', 0o600);
  try {
    noLinks(io, tmp);
    writeAll(io, fd, bytes);
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
  noLinks(io, tmp);
  noLinks(io, target, { missing: true });
  io.renameSync(tmp, target);
  flushDir(io, path.dirname(target));
}
function writeJson(io: typeof fs, target: string, value: any): void { writeAtomic(io, target, Buffer.from(JSON.stringify(value) + '\n')); }
function cleanAtomicTemps(io: typeof fs, directory: string, names: string[]): void {
  noLinks(io, directory);
  for (const name of io.readdirSync(directory)) {
    const owned = names.some(base => name.startsWith('.' + base + '.')
      && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.tmp$/.test(name.slice(base.length + 2)));
    if (owned) unlink(io, child(directory, name));
  }
}
function unlink(io: typeof fs, target: string): void {
  if (noLinks(io, target, { missing: true })) {
    io.unlinkSync(target);
    flushDir(io, path.dirname(target));
  }
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail('CANCELLED', 'Operation cancelled; verified files and previous installation are retained');
}
async function event(ctx: ResourceContext, phase: string, details: Record<string, any> = {}, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  if (ctx.onEvent) await ctx.onEvent({ phase, ...details });
  await new Promise((resolve) => setImmediate(resolve));
  cancelled(signal);
}
function access(ctx: ResourceContext): void {
  if (ctx.access?.isLocalStudioHost?.() !== true || ctx.access?.isAuthorized?.() !== true) {
    fail('ACCESS_DENIED', 'A positively identified local studio and authorized caller are required');
  }
}
function context(options: Partial<ContextOptions> = {}): ResourceContext {
  if (typeof options.userDataRoot !== 'string' || !path.isAbsolute(options.userDataRoot)) fail('CONFIG_REQUIRED', 'An absolute userDataRoot is required');
  const io = options.io || fs;
  const userRoot = path.resolve(options.userDataRoot);
  const store = path.join(userRoot, STORE_NAME);
  const protectedRoots = [path.resolve(__dirname, '../..'), ...(options.protectedRoots || [])];
  for (const root of protectedRoots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('CONFIG_REQUIRED', 'protectedRoots must be absolute paths');
    if (within(root, store) || within(store, root)) fail('PROTECTED_ROOT', 'Resource storage overlaps application/artwork storage');
  }
  const userStat = noLinks(io, userRoot);
  if (!userStat || !userStat.isDirectory()) fail('CONFIG_REQUIRED', 'userDataRoot must already be a directory');
  return { io, userRoot, store, policy: JSON.parse(JSON.stringify(options.policy || {})), access: options.access,
    onEvent: options.onEvent, freeBytes: options.freeBytes };
}
function initialize(ctx: ResourceContext): void {
  access(ctx);
  const { io, store } = ctx;
  const st = noLinks(io, store, { missing: true });
  if (st && !st.isDirectory()) fail('UNOWNED_ROOT', 'Resource store is not a directory');
  if (!st) mkdir(io, store);
  const marker = child(store, 'store.json');
  const existing = readJson(io, marker, true);
  if (!existing) {
    const leftovers = io.readdirSync(store);
    if (leftovers.some(name => !/^\.store\.json\.[\da-f-]+\.tmp$/.test(name))) fail('UNOWNED_ROOT', 'Refusing an existing unowned resource directory');
    writeJson(io, marker, MARKER);
  } else if (JSON.stringify(existing) !== JSON.stringify(MARKER)) fail('UNOWNED_ROOT', 'Resource ownership marker is invalid');
  mkdir(io, child(store, 'locks'));
}
function ensureSpace(ctx: ResourceContext, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) fail('SIZE_INVALID', 'Invalid required byte count');
  let available;
  if (ctx.freeBytes) available = BigInt(ctx.freeBytes());
  else {
    const stat = ctx.io.statfsSync(ctx.store, { bigint: true });
    available = stat.bavail * stat.bsize;
  }
  if (available < BigInt(bytes)) fail('ENOSPC', 'Not enough free space; previous installation is retained', { required: bytes, available: available.toString() });
}
function alive(owner: LockOwner): boolean {
  if (!owner || owner.host !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0
    || !/^[\da-f-]{36}$/.test(owner.token || '')) fail('LOCK_UNCERTAIN', 'Lock owner cannot be established safely');
  try { process.kill(owner.pid, 0); return true; } catch (error) {
    if (runtimeErrorCode(error) === 'ESRCH') return false;
    return true; // PID reuse/permission uncertainty must never steal a live lock.
  }
}

// Publish a fully written claim with an exclusive hard link: no empty-owner crash window.
// Stale takeover is itself locked by the old nonce, preventing two recoverers from unlinking
// a new owner's lock. A killed reaper is handled by the same bounded protocol.
function lockFile(ctx: ResourceContext, name: string = 'writer', depth: number = 0): () => void {
  if (depth > 8) fail('LOCK_UNCERTAIN', 'Too many interrupted lock recoveries');
  const { io } = ctx;
  const target = child(ctx.store, 'locks/' + name + '.json');
  const owner = { pid: process.pid, host: os.hostname(), token: randomUUID() };
  const claim = child(ctx.store, 'locks/claim-' + owner.token + '.json');
  writeJson(io, claim, owner);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      noLinks(io, target, { missing: true, hardlinks: true });
      try {
        io.linkSync(claim, target);
        flushDir(io, path.dirname(target));
        return () => {
          const current = readJson(io, target, true, true);
          if (current?.token === owner.token) {
            io.unlinkSync(target);
            flushDir(io, path.dirname(target));
          }
        };
      } catch (error) { if (runtimeErrorCode(error) !== 'EEXIST') throw error; }
      const old = readJson(io, target, true, true);
      if (!old) continue;
      if (alive(old)) fail('BUSY', 'Another resource operation is active');
      const releaseReaper = lockFile(ctx, 'reap-' + old.token, depth + 1);
      try {
        const now = readJson(io, target, true, true);
        if (now?.token === old.token && !alive(now)) io.unlinkSync(target);
      } finally { releaseReaper(); }
    }
    throw fail('BUSY', 'Resource lock changed during recovery');
  } finally {
    // Claim and lock deliberately share an inode until this finally finishes.
    if (noLinks(io, claim, { missing: true, hardlinks: true })) io.unlinkSync(claim);
  }
}
async function locked(ctx: ResourceContext, fn: () => any): Promise<any> {
  initialize(ctx);
  const release = lockFile(ctx);
  try { return await fn(); } finally { release(); }
}
export = { STORE_NAME, MAX_JSON, ResourceError, fail, digest, within, samePath, relativePath, child,
  noLinks, mkdir, readBytes, readJson, writeAtomic, writeJson, writeAll, unlink, flushDir, cleanAtomicTemps,
  cancelled, event, access, context, initialize, ensureSpace, lockFile, locked };
