'use strict';

const path: typeof import('node:path') = require('node:path');
const { createHash }: typeof import('node:crypto') = require('node:crypto');
const { child, noLinks, mkdir, ensureSpace, writeAll, event, cancelled, fail, digest, flushDir, unlink }: typeof import('./resource-install-fs') = require('./resource-install-fs');

const CHUNK = 512 * 1024;
function fileMatches(ctx: any, file: string, entry: { bytes: number; sha256: string; }) {
  const st = noLinks(ctx.io, file, { missing: true });
  if (!st) return false;
  if (!st.isFile()) fail('UNSAFE_FILE', 'Expected an ordinary resource file');
  if (st.size !== entry.bytes) return false;
  const fd = ctx.io.openSync(file, 'r');
  try {
    noLinks(ctx.io, file);
    const opened = ctx.io.fstatSync(fd);
    if (opened.ino !== st.ino || opened.dev !== st.dev) fail('FILE_CHANGED', 'Resource changed while opening');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(CHUNK);
    let total = 0;
    let read;
    while ((read = ctx.io.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      total += read;
      if (total > entry.bytes) return false;
      hash.update(buffer.subarray(0, read));
    }
    return total === entry.bytes && hash.digest('hex') === entry.sha256;
  } finally { ctx.io.closeSync(fd); }
}
async function copyEntry(ctx: any, { sourceRoot, tree, parts, entry, signal }: unknown) {
  cancelled(signal);
  const target = child(tree, entry.path);
  if (fileMatches(ctx, target, entry)) {
    await event(ctx, 'copy-reused', { path: entry.path }, signal);
    return;
  }
  ensureSpace(ctx, entry.bytes + 65536);
  const source = child(sourceRoot, entry.path);
  const sourceStat = noLinks(ctx.io, source);
  if (!sourceStat.isFile() || sourceStat.size !== entry.bytes) fail('CONTENT_INVALID', 'Source resource changed before copy');
  mkdir(ctx.io, path.dirname(target));
  mkdir(ctx.io, parts);
  const partial = child(parts, digest(entry.path) + '.part');
  // An incomplete local copy restarts this file; completed files are rehashed and reused.
  unlink(ctx.io, partial);
  const input = ctx.io.openSync(source, 'r');
  let output;
  try {
    noLinks(ctx.io, source);
    const opened = ctx.io.fstatSync(input);
    if (opened.ino !== sourceStat.ino || opened.dev !== sourceStat.dev) fail('FILE_CHANGED', 'Source changed while opening');
    output = ctx.io.openSync(partial, 'wx', 0o600);
    noLinks(ctx.io, partial);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(CHUNK);
    let total = 0;
    let count;
    while ((count = ctx.io.readSync(input, buffer, 0, buffer.length, null)) > 0) {
      cancelled(signal);
      total += count;
      if (total > entry.bytes) fail('CONTENT_INVALID', 'Source grew while copying');
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      noLinks(ctx.io, partial);
      writeAll(ctx.io, output, bytes);
      await event(ctx, 'copy-progress', { path: entry.path, bytes: total, total: entry.bytes }, signal);
    }
    if (total !== entry.bytes || hash.digest('hex') !== entry.sha256) fail('CONTENT_INVALID', 'Copied source no longer matches approved manifest');
    ctx.io.fsyncSync(output);
  } finally {
    ctx.io.closeSync(input);
    if (output !== undefined) ctx.io.closeSync(output);
  }
  if (!fileMatches(ctx, partial, entry)) fail('CONTENT_INVALID', 'Copied bytes failed readback');
  noLinks(ctx.io, target, { missing: true });
  unlink(ctx.io, target);
  ctx.io.renameSync(partial, target);
  flushDir(ctx.io, path.dirname(target));
  await event(ctx, 'copied', { path: entry.path }, signal);
}
export = { CHUNK, fileMatches, copyEntry };
