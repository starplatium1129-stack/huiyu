'use strict';

import { createCharacterReferenceReader, sendCharacterReferenceProfile } from '../server/character-reference-profile';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const security: typeof import('../server/security') = require('../server/security');
const { resolveReferenceRelease }: typeof import('../scripts/lib/reference-candidate-publish') = require('../scripts/lib/reference-candidate-publish');
const { child, readBytes, digest }: typeof import('../scripts/lib/resource-install-fs') = require('../scripts/lib/resource-install-fs');

// Bind a published projection and its images to one verified immutable release. This route
// precedes precompression and generic static handlers so a bad release cannot use an old index.
function createReferenceResources(config: any) {
  const readProfile = createCharacterReferenceReader(config.ROOT_DIR);
  const root = config.CHARACTER_REF_EXPLICIT_ROOT || config.CHARACTER_REF_ROOT;
  let release: any = null;
  let blocked = false;
  let markerBytes: any = null;
  let entries: any;
  if (root) {
    try {
      if (!fs.statSync(root).isDirectory()) throw new Error('Reference root unavailable');
      release = resolveReferenceRelease(root, { dataRoot: config.ROOT_DIR });
      if (release) {
        markerBytes = readBytes(fs, path.join(root, 'reference-release.json'));
        entries = new Map(release.release.files.map((file: any) => [file.path, file]));
      }
    } catch { blocked = true; }
  }
  function bytes(file: any, sha256: any, max?: any) {
    const value = readBytes(fs, file, max);
    if (digest(value) !== sha256) throw new Error('Reference bytes changed');
    return value;
  }
  function controls() {
    if (!markerBytes.equals(readBytes(fs, path.join(root, 'reference-release.json')))) throw new Error('Reference release changed');
    bytes(path.join(config.ROOT_DIR, 'data/character-reference-standards.json'), release.release.sourceStandardsSha256);
    bytes(path.join(config.ROOT_DIR, 'data/character-reference-view.json'), release.release.sourceViewSha256);
    return bytes(release.viewFile, release.release.viewSha256);
  }
  return function referenceResources(req: any, res: any, next: any) {
    let pathname;
    try { pathname = decodeURIComponent(String(req.path)); } catch { return next(); }
    const profileMatch = /^\/api\/character-reference-profile\/([^/]+)\/?$/i.exec(pathname);
    const isView = /^\/data\/character-reference-view\.json\/?$/i.test(pathname);
    const isImage = /^\/character-references(?:\/|$)/i.test(pathname);
    if (!isView && !isImage && !profileMatch) return next();
    res.setHeader('Cache-Control', 'private, no-cache');
    // Hashes do not prove content classification. Until an approved per-resource remote
    // projection exists, versioned references retain the conservative local-only boundary.
    if (!security.isDirectLocalRequest(req) || !security.hostAllowed(req.headers.host, config.PORT, '')) {
      return res.status(403).json({ ok: false, code: 'REFERENCE_LOCAL_ONLY', error: '该参考资源仅限本机使用' });
    }
    if (profileMatch && !/^[a-z0-9][a-z0-9_-]*$/i.test(profileMatch[1])) return res.status(400).json({ error: '角色 ID 无效' });
    if (!root || (!release && !blocked)) {
      if (!profileMatch) return next(); // Local legacy fallback remains intact.
      if (!/^(GET|HEAD)$/.test(req.method)) return res.status(405).end();
      try { return sendCharacterReferenceProfile(res, profileMatch[1], readProfile); }
      catch { return res.status(503).json({ error: '参考档案暂不可用' }); }
    }
    if (blocked) return res.status(503).json({ ok: false, code: 'REFERENCE_RELEASE_INVALID', error: '参考资源版本未通过校验' });
    if (!/^(GET|HEAD)$/.test(req.method)) return res.status(405).end();
    try {
      const view = controls();
      if (profileMatch) return sendCharacterReferenceProfile(res, profileMatch[1], readProfile, view);
      if (isView) {
        res.type('json');
        res.setHeader('ETag', '"' + release.release.viewSha256 + '"');
        return req.fresh ? res.status(304).end() : res.send(view);
      }
      const rel = pathname.slice('/character-references/'.length);
      const entry = entries.get(rel);
      if (!entry || rel.split('/').some(part => part.startsWith('.'))) return res.status(404).end();
      const image = bytes(child(release.referenceRoot, rel), entry.sha256, entry.bytes);
      res.type(path.extname(rel));
      res.setHeader('ETag', '"' + entry.sha256 + '"');
      return req.fresh ? res.status(304).end() : res.send(image);
    } catch {
      blocked = true;
      return res.status(503).json({ ok: false, code: 'REFERENCE_RELEASE_INVALID', error: '参考资源版本未通过校验' });
    }
  };
}
export = { createReferenceResources };
