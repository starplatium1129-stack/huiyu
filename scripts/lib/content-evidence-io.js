'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { safeRelative } = require('./content-history-reader');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value) => hash(JSON.stringify(value));
const SHA = /^[a-f0-9]{64}$/;

function evidencePath(file) {
  safeRelative(file);
  if (/[\x00-\x1f\x7f%]/.test(file) || file.split('/').some((part) => /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe evidence path');
  return file;
}

function evidenceReader(root, label) {
  const base = fs.realpathSync(root);
  const cache = new Map(), directories = new Map();
  const resolve = (file) => {
    let current = base;
    for (const part of evidencePath(file).split('/')) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      const rel = path.relative(base, fs.realpathSync(current));
      if (stat.isSymbolicLink() || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Evidence links/junctions are not allowed');
    }
    return current;
  };
  const read = (file, limit) => {
    const target = resolve(file);
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > limit) throw new Error('Expected a bounded ordinary evidence file');
    const value = fs.readFileSync(target);
    if (value.length > limit) throw new Error('Evidence file grew beyond the read limit');
    return value;
  };
  return {
    root: base,
    bytes(file, limit = 16 * 1024 * 1024) {
      evidencePath(file);
      if (!cache.has(file)) {
        try { const value = read(file, limit); cache.set(file, { value, sha256: hash(value), bytes: value.length, status: 'read', limit }); }
        catch (error) { cache.set(file, { status: error.code === 'ENOENT' ? 'missing' : 'invalid', error, limit }); }
      }
      const item = cache.get(file);
      if (item.error) throw item.error;
      if (item.bytes > limit) throw new Error('Evidence exceeds this caller read limit');
      if (!item.value) {
        const value = read(file, limit);
        if (hash(value) !== item.sha256) throw new Error('Evidence changed after fingerprinting');
        item.value = value;
      }
      return item.value;
    },
    fingerprint(file, limit) {
      this.bytes(file, limit);
      const item = cache.get(file);
      // Keep hashes, not all image buffers, for the final stability check.
      item.value = null;
      return { bytes: item.bytes, sha256: item.sha256 };
    },
    json(file) { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.bytes(file))); },
    list(directory) {
      if (!directories.has(directory)) directories.set(directory, fs.readdirSync(resolve(directory)).sort());
      return [...directories.get(directory)];
    },
    evidence() {
      return [...[...cache].map(([file, item]) => ({ scope: label, file, status: item.status, sha256: item.sha256 || null, bytes: item.bytes ?? null })),
        ...[...directories].map(([file, names]) => ({ scope: label, file, kind: 'directory', sha256: jsonHash(names) }))];
    },
    verify() {
      const changed = [];
      for (const [file, item] of cache) {
        try { if (hash(read(file, item.limit)) !== item.sha256) changed.push(`${label}:${file}: changed during audit`); }
        catch (error) { if (!item.error || error.code !== item.error.code || error.message !== item.error.message) changed.push(`${label}:${file}: changed during audit`); }
      }
      for (const [directory, names] of directories) {
        try { if (jsonHash(fs.readdirSync(resolve(directory)).sort()) !== jsonHash(names)) changed.push(`${label}:${directory}: membership changed during audit`); }
        catch { changed.push(`${label}:${directory}: unavailable during audit`); }
      }
      return changed;
    },
  };
}

// Imported absolute source paths are identities only. They never grant read access.
function explicitSource(root, embedded, allowed) {
  if (typeof embedded !== 'string' || embedded.includes('\0')) return null;
  let relative = path.isAbsolute(embedded) ? path.relative(root, embedded).replace(/\\/g, '/') : embedded.replace(/\\/g, '/');
  try { relative = evidencePath(relative); } catch { return null; }
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  return allowed.find((file) => same(file, relative)) || null;
}

module.exports = { hash, jsonHash, SHA, evidencePath, evidenceReader, explicitSource };
