'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const security: typeof import('../server/security') = require('../server/security');
const { child, readBytes, digest, fail }: typeof import('../scripts/lib/resource-install-fs') = require('../scripts/lib/resource-install-fs');

function resourcePath(raw: any) {
  const pathname = String(raw || '').split('?')[0];
  if (!/^\/assets(?:\/|$)/i.test(pathname)) return null;
  if (/%(?:2f|5c|25|00)/i.test(pathname)) return null;
  let value;
  try { value = decodeURIComponent(pathname); } catch { return null; }
  if (/[\\\x00-\x1f:%?#]/.test(value) || value.split('/').slice(1).some(part => !part || part.startsWith('.'))
    || path.posix.normalize(value) !== value) return null;
  // Both existing aliases refer to exactly the same manifest namespace.
  return value.slice(1).replace(/^assets\/live2d-current\//, 'assets/live2d/');
}
function checkedBytes(root: any, entry: any) {
  const bytes = readBytes(fs, child(root, entry.path), entry.bytes);
  if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) fail('CONTENT_INVALID', 'Installed bytes changed');
  return bytes;
}
function createResourceStatic(manager: any) {
  return function resources(req: any, res: any, next: any) {
    if (!/^(GET|HEAD)$/.test(req.method) || !security.isDirectLocalRequest(req)
      || !security.hostAllowed(req.headers.host, 0, '')) return next();
    const rel = resourcePath(req.originalUrl);
    if (!rel) return next();
    const mounted = manager.mount();
    if (!mounted) return next();
    const { snapshot, modelGroups } = mounted;
    const entries = new Map(snapshot.entries.map((entry: any) => [entry.path, entry]));
    const entry = entries.get(rel);
    if (!entry) return next();
    try {
      if (rel.startsWith('assets/live2d/')) {
        const group = modelGroups.find((group: any) => group.paths.includes(rel));
        if (!group) return next();
        // Check the entire dependency group before serving any part; reject hybrid models.
        for (const dependency of group.paths) checkedBytes(snapshot.versionRoot, entries.get(dependency));
      }
      const bytes = checkedBytes(snapshot.versionRoot, entry);
      // Snapshot and configuration may have been revoked by an external local lifecycle tool.
      if (!manager.mount()) return next();
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Resource-Version', snapshot.identity);
      res.setHeader('ETag', '"' + entry.sha256 + '"');
      res.type(path.extname(rel));
      if (req.fresh) return res.status(304).end();
      return res.send(bytes);
    } catch (error) {
      manager.invalidate(error);
      return next(); // Bundled base resource is served under the existing policy.
    }
  };
}
export = { createResourceStatic, resourcePath };
