import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

import { PathLike } from 'node:fs';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { createHash }: typeof import('node:crypto') = require('node:crypto');
const { TextDecoder }: typeof import('node:util') = require('node:util');
const { safeRelative }: typeof import('./content-history-reader') = require('./content-history-reader');
const hash = (value: string|NodeJS.ArrayBufferView<ArrayBufferLike>|NonSharedBuffer) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value: string[]) => hash(JSON.stringify(value));
const SHA = /^[a-f0-9]{64}$/;

function evidencePath(file: string) {
  safeRelative(file);
  if (/[\x00-\x1f\x7f%]/.test(file) || file.split('/').some((part: string) => /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe evidence path');
  return file;
}

function evidenceReader(root: PathLike, label: unknown) {
  const base = fs.realpathSync(root);
  const cache = new Map(), directories = new Map();
  const resolve = (file: string) => {
    let current = base;
    for (const part of evidencePath(file).split('/')) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      const rel = path.relative(base, fs.realpathSync(current));
      if (stat.isSymbolicLink() || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Evidence links/junctions are not allowed');
    }
    return current;
  };
  const read = (file: unknown, limit: number) => {
    const target = resolve(file);
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > limit) throw new Error('Expected a bounded ordinary evidence file');
    const value = fs.readFileSync(target);
    if (value.length > limit) throw new Error('Evidence file grew beyond the read limit');
    return value;
  };
  return {
    root: base,
    bytes(file: string, limit = 16 * 1024 * 1024) {
      evidencePath(file);
      if (!cache.has(file)) {
        try { const value = read(file, limit); cache.set(file, { value, sha256: hash(value), bytes: value.length, status: 'read', limit }); }
        catch (error) { cache.set(file, { status: runtimeErrorCode(error) === 'ENOENT' ? 'missing' : 'invalid', error, limit }); }
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
    fingerprint(file: unknown, limit: number|undefined) {
      this.bytes(file, limit);
      const item = cache.get(file);
      // Keep hashes, not all image buffers, for the final stability check.
      item.value = null;
      return { bytes: item.bytes, sha256: item.sha256 };
    },
    json(file: string) { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.bytes(file))); },
    list(directory: string) {
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
        catch (error) { if (!item.error || runtimeErrorCode(error) !== item.error.code || runtimeErrorMessage(error) !== item.error.message) changed.push(`${label}:${file}: changed during audit`); }
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
function explicitSource(root: string, embedded: string, allowed: unknown[]) {
  if (typeof embedded !== 'string' || embedded.includes('\0')) return null;
  let relative = path.isAbsolute(embedded) ? path.relative(root, embedded).replace(/\\/g, '/') : embedded.replace(/\\/g, '/');
  try { relative = evidencePath(relative); } catch { return null; }
  const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  return allowed.find((file: string) => same(file, relative)) || null;
}

export = { hash, jsonHash, SHA, evidencePath, evidenceReader, explicitSource };
