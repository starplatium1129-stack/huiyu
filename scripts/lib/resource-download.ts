import { errorCode as runtimeErrorCode } from './runtime-errors';
'use strict';

const path: typeof import('node:path') = require('node:path');
const { context, locked, access, child, mkdir, noLinks, readJson, writeJson, writeAtomic, unlink,
  ensureSpace, writeAll, event, cancelled, fail, digest, flushDir, ResourceError, cleanAtomicTemps }: typeof import('./resource-install-fs') = require('./resource-install-fs');
const { releasePolicy, decodePack, readPack, verifyTree }: typeof import('./resource-install-policy') = require('./resource-install-policy');
const { fileMatches }: typeof import('./resource-install-copy') = require('./resource-install-copy');
const { sourceUrl, response, fetchMetadata, rangeStart }: typeof import('./resource-download-http') = require('./resource-download-http');

async function downloadEntry(ctx: any, release: unknown, pack: string, parts: string, entry: any, signal: any, timeoutMs: unknown) {
  const target = child(pack, entry.path);
  if (fileMatches(ctx, target, entry)) {
    await event(ctx, 'download-reused', { path: entry.path }, signal);
    return;
  }
  const partial = child(parts, digest(entry.path) + '.part');
  const checkpoint = child(parts, digest(entry.path) + '.json');
  const saved = readJson(ctx.io, checkpoint, true);
  let stat = noLinks(ctx.io, partial, { missing: true });
  if (stat && (!stat.isFile() || stat.size > entry.bytes)) fail('PARTIAL_INVALID', 'Invalid partial resource');
  // A checkpoint is only a resume hint. Final bytes always have to match the approved hash.
  if (stat && (!saved || saved.sha256 !== entry.sha256 || saved.bytes !== entry.bytes)) {
    unlink(ctx.io, partial);
    stat = null;
  }
  let offset = stat?.size || 0;
  if (stat && offset === entry.bytes) {
    if (fileMatches(ctx, partial, entry)) return publishEntry(ctx, partial, target, entry, signal);
    unlink(ctx.io, partial);
    offset = 0;
  }
  ensureSpace(ctx, entry.bytes - offset + 65536);
  const etag = typeof saved?.etag === 'string' && /^"[^\r\n]*"$/.test(saved.etag) ? saved.etag : null;
  const headers = offset ? { range: 'bytes=' + offset + '-', ...(etag ? { 'if-range': etag } : {}) } : {};
  const res: any = await response(sourceUrl(release, entry.path), { signal, headers, timeoutMs });
  let fd;
  try {
    const start = rangeStart(res, offset, entry.bytes, offset ? etag : null);
    ensureSpace(ctx, entry.bytes - start + 65536);
    const strongEtag = /^"[^\r\n]*"$/.test(res.headers.etag || '') ? res.headers.etag : null;
    writeJson(ctx.io, checkpoint, { schemaVersion: 1, sha256: entry.sha256, bytes: entry.bytes, etag: strongEtag });
    noLinks(ctx.io, partial, { missing: true });
    fd = ctx.io.openSync(partial, start ? 'a' : 'w', 0o600);
    noLinks(ctx.io, partial);
    let received = start;
    for await (const chunk of res) {
      cancelled(signal);
      access(ctx);
      if (received + chunk.length > entry.bytes) fail('HTTP_SIZE', 'Response exceeds approved resource length');
      noLinks(ctx.io, partial);
      writeAll(ctx.io, fd, chunk);
      received += chunk.length;
      await event(ctx, 'download-progress', { path: entry.path, bytes: received, total: entry.bytes, resumedFrom: start }, signal);
    }
    if (received !== entry.bytes) fail('HTTP_SIZE', 'Resource response is incomplete');
    ctx.io.fsyncSync(fd);
  } finally {
    res.destroy();
    if (fd !== undefined) {
      try { ctx.io.fsyncSync(fd); } finally { ctx.io.closeSync(fd); }
    }
  }
  if (!fileMatches(ctx, partial, entry)) {
    unlink(ctx.io, partial);
    fail('CONTENT_INVALID', 'Downloaded bytes differ from the approved hash; retry starts this file again');
  }
  return publishEntry(ctx, partial, target, entry, signal);
}
async function publishEntry(ctx: any, partial: string, target: string, entry: any, signal: any) {
  cancelled(signal);
  mkdir(ctx.io, path.dirname(target));
  noLinks(ctx.io, partial);
  noLinks(ctx.io, target, { missing: true });
  unlink(ctx.io, target);
  ctx.io.renameSync(partial, target);
  flushDir(ctx.io, path.dirname(target));
  await event(ctx, 'downloaded', { path: entry.path }, signal);
}
function createResourceDownloader(options: any) {
  const ctx = context(options);
  const timeoutMs = options.timeoutMs || 30000;
  return {
    root: ctx.store,
    async download({ releaseId, signal } = {}) {
      const release = releasePolicy(ctx, releaseId);
      if (release.source.kind !== 'http') fail('SOURCE_REQUIRED', 'Download requires a configured HTTP source');
      sourceUrl(release, 'manifest.json'); // Validate transport before any disk/network mutation.
      cancelled(signal);
      return locked(ctx, async () => {
        const directory = child(ctx.store, 'downloads/' + release.packageIdentity);
        const pack = child(directory, 'pack');
        const parts = child(directory, 'parts');
        const complete = child(directory, 'complete.json');
        const done = readJson(ctx.io, complete, true);
        if (done?.packageIdentity === release.packageIdentity) {
          try {
            const existing = readPack(ctx, release);
            return { ok: true, kind: 'resource-download-result', action: 'already-downloaded', releaseId,
              packRoot: existing.root, installed: false, files: existing.manifest.entries.length };
          } catch (error) {
            if (!['CONTENT_INVALID', 'PACKAGE_UNAPPROVED', 'TARGET_MISMATCH', 'METADATA_INVALID'].includes(runtimeErrorCode(error))) throw error;
            unlink(ctx.io, complete); // Re-fetch approved metadata and repair only corrupt cache files.
          }
        }
        const network = { signal, timeoutMs };
        const raw = await fetchMetadata(sourceUrl(release, 'manifest.json'), network);
        const delta = release.kind === 'delta' ? await fetchMetadata(sourceUrl(release, 'delta.json'), network) : null;
        const decoded = decodePack(raw, delta, release);
        access(ctx);
        ensureSpace(ctx, raw.length + (delta?.length || 0) + 65536);
        mkdir(ctx.io, pack);
        mkdir(ctx.io, parts);
        cleanAtomicTemps(ctx.io, pack, ['manifest.json', 'delta.json']);
        writeAtomic(ctx.io, child(pack, 'manifest.json'), raw);
        if (delta) writeAtomic(ctx.io, child(pack, 'delta.json'), delta);
        for (const entry of decoded.manifest.entries) {
          await downloadEntry(ctx, release, pack, parts, entry, signal, timeoutMs);
        }
        verifyTree(ctx, pack, decoded.manifest, delta ? ['manifest.json', 'delta.json'] : ['manifest.json']);
        access(ctx);
        cancelled(signal);
        writeJson(ctx.io, complete, { schemaVersion: 1, packageIdentity: release.packageIdentity });
        return { ok: true, kind: 'resource-download-result', action: 'downloaded', releaseId,
          packRoot: pack, installed: false, files: decoded.manifest.entries.length };
      }).catch(error => {
        if (signal?.aborted) throw new ResourceError('CANCELLED', 'Download cancelled; partial bytes are retained');
        throw error;
      });
    },
  };
}
export = { createResourceDownloader };
