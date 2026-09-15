'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { isSceneId } = require('./scene-id');

const MAX_BYTES = 16 * 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => typeof value === 'string' && value.length > 0 && value.trim() === value;
// Keep the existing three-digit namespace; wider IDs cannot have redundant zeroes.
const canonicalSceneId = isSceneId;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function safeRelative(file) {
  if (typeof file !== 'string' || !file || /[\\:\x00]/.test(file)
    || file.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('Unsafe repository-relative path');
  }
  return file;
}

// Preflight before Git reads working files too: a safe leaf can have an unsafe
// junction parent. Missing/deleted paths are allowed; existing links are not.
function assertWorktreePaths(root, files) {
  const base = fs.realpathSync(root);
  for (const file of files) {
    let current = base;
    for (const part of safeRelative(file).split('/')) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') break; throw error; }
      const relative = path.relative(base, fs.realpathSync(current));
      if (stat.isSymbolicLink() || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        throw new Error(`${file}: symbolic link/junction or path outside root; Git diff not executed`);
      }
    }
  }
}

function localReader(root) {
  const base = fs.realpathSync(root);
  const inside = (file) => {
    const relative = path.relative(base, file);
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  };
  const resolve = (file) => {
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
    bytes(file) {
      const target = resolve(file);
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`${file}: not a regular file or exceeds ${MAX_BYTES} bytes`);
      return fs.readFileSync(target);
    },
    list(directory) {
      return fs.readdirSync(resolve(directory)).sort();
    },
  });
}

function reader(source) {
  const cache = new Map();
  const evidence = new Map();
  const directories = new Map();
  return {
    side: source.side,
    list(directory) {
      safeRelative(directory);
      if (!directories.has(directory)) {
        const names = source.list(directory).sort();
        directories.set(directory, names);
        evidence.set(`${directory}/`, { file: `${directory}/`, side: source.side, kind: 'directory', status: 'read', sha256: digest(JSON.stringify(names)) });
      }
      return [...directories.get(directory)];
    },
    evidence,
    read(file) {
      safeRelative(file);
      if (cache.has(file)) return cache.get(file);
      let item;
      try {
        const bytes = source.bytes(file);
        if (bytes.length > MAX_BYTES) throw new Error('Content exceeds read limit');
        const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        item = { file, status: 'read', raw, sha256: digest(bytes), bytes: bytes.length };
      } catch (error) {
        item = { file, status: error.code === 'ENOENT' ? 'missing' : 'unknown', reason: error.message };
      }
      cache.set(file, item);
      evidence.set(file, { file, side: source.side, status: item.status, sha256: item.sha256 || null });
      return item;
    },
    json(file) {
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
          if (original.status === 'read' || (original.status === 'missing' && error.code !== 'ENOENT')) errors.push(`${file}: changed or unavailable during snapshot read`);
        }
      }
      return errors;
    },
  };
}

module.exports = { MAX_BYTES, object, validId, canonicalSceneId, safeRelative, assertWorktreePaths, localReader, reader };
