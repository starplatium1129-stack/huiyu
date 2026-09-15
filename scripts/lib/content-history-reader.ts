import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

import { PathLike } from 'node:fs';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { createHash }: typeof import('node:crypto') = require('node:crypto');
const { TextDecoder }: typeof import('node:util') = require('node:util');
const { isSceneId }: typeof import('./scene-id') = require('./scene-id');

const MAX_BYTES = 16 * 1024 * 1024;
const object = (value: null) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value: string) => typeof value === 'string' && value.length > 0 && value.trim() === value;
// Keep the existing three-digit namespace; wider IDs cannot have redundant zeroes.
const canonicalSceneId = isSceneId;
const digest = (bytes: string|NodeJS.ArrayBufferView<ArrayBufferLike>) => createHash('sha256').update(bytes).digest('hex');

function safeRelative(file: string) {
  if (typeof file !== 'string' || !file || /[\\:\x00]/.test(file)
    || file.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('Unsafe repository-relative path');
  }
  return file;
}

// Preflight before Git reads working files too: a safe leaf can have an unsafe
// junction parent. Missing/deleted paths are allowed; existing links are not.
function assertWorktreePaths(root: PathLike, files: unknown) {
  const base = fs.realpathSync(root);
  for (const file of files) {
    let current = base;
    for (const part of safeRelative(file).split('/')) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (runtimeErrorCode(error) === 'ENOENT' || runtimeErrorCode(error) === 'ENOTDIR') break; throw error; }
      const relative = path.relative(base, fs.realpathSync(current));
      if (stat.isSymbolicLink() || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        throw new Error(`${file}: symbolic link/junction or path outside root; Git diff not executed`);
      }
    }
  }
}

function localReader(root: PathLike) {
  const base = fs.realpathSync(root);
  const inside = (file: string) => {
    const relative = path.relative(base, file);
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  };
  const resolve = (file: string) => {
    safeRelative(file);
    let current = base;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      // Refuse even in-root symlinks: Git stores links, not their targets.
      if (stat.isSymbolicLink() || !inside(fs.realpathSync(current))) throw new Error(`${file}: symbolic link/junction or path outside root`);
    }
    return current;
  };
  return reader({
    side: 'working-tree',
    bytes(file: string) {
      const target = resolve(file);
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`${file}: not a regular file or exceeds ${MAX_BYTES} bytes`);
      return fs.readFileSync(target);
    },
    list(directory: string) {
      return fs.readdirSync(resolve(directory)).sort();
    },
  });
}

function reader(source: { side: unknown; bytes: unknown; list: unknown; }) {
  const cache = new Map();
  const evidence = new Map();
  const directories = new Map();
  return {
    side: source.side,
    list(directory: string) {
      safeRelative(directory);
      if (!directories.has(directory)) {
        const names = source.list(directory).sort();
        directories.set(directory, names);
        evidence.set(`${directory}/`, { file: `${directory}/`, side: source.side, kind: 'directory', status: 'read', sha256: digest(JSON.stringify(names)) });
      }
      return [...directories.get(directory)];
    },
    evidence,
    read(file: string) {
      safeRelative(file);
      if (cache.has(file)) return cache.get(file);
      let item;
      try {
        const bytes = source.bytes(file);
        if (bytes.length > MAX_BYTES) throw new Error('Content exceeds read limit');
        const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        item = { file, status: 'read', raw, sha256: digest(bytes), bytes: bytes.length };
      } catch (error) {
        item = { file, status: runtimeErrorCode(error) === 'ENOENT' ? 'missing' : 'unknown', reason: runtimeErrorMessage(error) };
      }
      cache.set(file, item);
      evidence.set(file, { file, side: source.side, status: item.status, sha256: item.sha256 || null });
      return item;
    },
    json(file: string) {
      const item = this.read(file);
      if (item.status !== 'read') throw new Error(`${file}: ${item.status}: ${item.reason}`);
      try { return JSON.parse(item.raw); } catch { throw new Error(`${file}: invalid JSON`); }
    },
    verify() {
      const errors = [];
      for (const [directory, names] of directories) {
        try {
          if (JSON.stringify(source.list(directory).sort()) !== JSON.stringify(names)) errors.push(`${directory}: directory membership changed during snapshot read`);
        } catch { errors.push(`${directory}: directory unavailable during snapshot read`); }
      }
      for (const [file, original] of cache) {
        try {
          const now = source.bytes(file);
          if (original.status !== 'read' || digest(now) !== original.sha256) errors.push(`${file}: changed during snapshot read`);
        } catch (error) {
          if (original.status === 'read' || (original.status === 'missing' && runtimeErrorCode(error) !== 'ENOENT')) errors.push(`${file}: changed or unavailable during snapshot read`);
        }
      }
      return errors;
    },
  };
}

export = { MAX_BYTES, object, validId, canonicalSceneId, safeRelative, assertWorktreePaths, localReader, reader };
