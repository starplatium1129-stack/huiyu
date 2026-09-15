'use strict';

const path: typeof import('node:path') = require('node:path');
const { compareManifests, checkManifestPath, verifyManifestEntries }: typeof import('./resource-manifest') = require('./resource-manifest');
const { manifestContentIdentity }: typeof import('./resource-pack-delta') = require('./resource-pack-delta');
const { verifyDeltaPackContent }: typeof import('./resource-pack-verify') = require('./resource-pack-verify');
const { access, fail, digest, child, noLinks, readBytes, relativePath }: typeof import('./resource-install-fs') = require('./resource-install-fs');

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const EXECUTABLE = /\.(exe|dll|com|bat|cmd|ps1|psm1|sh|bash|msi|msp|scr|vbs|vbe|hta|js|mjs|cjs|html|htm|wasm)$/i;

function manifest(value: any) {
  const result = compareManifests({ oldManifest: value, newManifest: value });
  if (!result.ok) fail('MANIFEST_INVALID', 'Manifest structure is invalid', result.errors);
  const identities = new Set();
  let total = 0;
  for (const entry of value.entries) {
    relativePath(entry.path);
    if (!checkManifestPath(entry.path).ok || /^assets\/character-references(?:\/|$)/i.test(entry.path)) fail('UNSAFE_PATH', 'Excluded resource domain');
    if (EXECUTABLE.test(entry.path)) fail('EXECUTABLE_REJECTED', 'Executable/web script content is not a resource update');
    const identity = entry.path.toLowerCase();
    if (identities.has(identity)) fail('MANIFEST_INVALID', 'Case-insensitive path collision');
    identities.add(identity);
    total += entry.bytes;
    if (!Number.isSafeInteger(total)) fail('SIZE_INVALID', 'Manifest byte total is not a safe integer');
  }
  for (const identity of identities) {
    const segments = identity.split('/');
    while (segments.length > 1) {
      segments.pop();
      if (identities.has(segments.join('/'))) fail('MANIFEST_INVALID', 'A file is also used as a directory');
    }
  }
  return { schemaVersion: 1, kind: 'resource-manifest', entries: value.entries.map((e: any) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256.toLowerCase() })), unverified: [] };
}
function releasePolicy(ctx: any, releaseId: any) {
  access(ctx);
  if (!ID.test(releaseId || '')) fail('CONFIG_REQUIRED', 'A configured release ID is required');
  const release = ctx.policy.releases?.[releaseId];
  if (!release || release.approved !== true || !HASH.test(release.packageIdentity || '')
    || !HASH.test(release.targetIdentity || '') || !['full', 'delta'].includes(release.kind)) {
    fail('APPROVAL_REQUIRED', 'Release requires independent approval and pinned package/target identities');
  }
  if (!ID.test(release.sourceId || '')) fail('SOURCE_REQUIRED', 'A configured source ID is required');
  const source = ctx.policy.sources?.[release.sourceId];
  if (!source || source.approved !== true || !['offline', 'http'].includes(source.kind)) fail('SOURCE_REQUIRED', 'An approved source is required');
  relativePath(release.path);
  if (source.kind === 'offline' && (typeof source.root !== 'string' || !path.isAbsolute(source.root))) fail('SOURCE_REQUIRED', 'Offline source root must be absolute');
  return { ...release, releaseId, source: { ...source } };
}
function reference(release: any) {
  return { identity: release.targetIdentity, packageIdentity: release.packageIdentity, releaseId: release.releaseId, sourceId: release.sourceId };
}
function validateReference(ctx: any, ref: any) {
  if (!ref || !HASH.test(ref.identity || '') || !HASH.test(ref.packageIdentity || '')) fail('STATE_INVALID', 'Invalid installed reference');
  const expected = reference(releasePolicy(ctx, ref.releaseId));
  if (JSON.stringify(expected) !== JSON.stringify(ref)) fail('APPROVAL_REQUIRED', 'Installed receipt differs from the independently approved release');
  return ref;
}
function packageIdentity(manifestBytes: any, deltaBytes = null) {
  return digest(JSON.stringify([digest(manifestBytes), deltaBytes === null ? null : digest(deltaBytes)]));
}
function parse(bytes: any) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail('METADATA_INVALID', 'Package metadata is not JSON'); }
}
function decodePack(manifestBytes: any, deltaBytes: any, release: any) {
  if (packageIdentity(manifestBytes, deltaBytes) !== release.packageIdentity) fail('PACKAGE_UNAPPROVED', 'Package metadata differs from the approved fingerprint');
  if ((release.kind === 'delta') !== (deltaBytes !== null)) fail('PACKAGE_KIND', 'Full/delta package kind differs from approval');
  const normalized = manifest(parse(manifestBytes));
  const delta = deltaBytes === null ? null : parse(deltaBytes);
  if (!delta && manifestContentIdentity(normalized) !== release.targetIdentity) fail('TARGET_MISMATCH', 'Full package target differs from approval');
  if (delta && delta.newManifest?.contentIdentity !== release.targetIdentity) fail('TARGET_MISMATCH', 'Delta target differs from approval');
  return { manifest: normalized, delta, manifestBytes, deltaBytes };
}
function inventory(ctx: any, root: any, declared: any) {
  if (!noLinks(ctx.io, root).isDirectory()) fail('UNSAFE_PATH', 'Package/version root is not a directory');
  const seen = new Set();
  const directories = new Set(['assets']);
  for (const rel of declared) {
    const segments = rel.split('/');
    while (segments.length > 1) { segments.pop(); directories.add(segments.join('/')); }
  }
  const visit = (dir: any, prefix = '') => {
    noLinks(ctx.io, dir);
    for (const name of ctx.io.readdirSync(dir)) {
      const rel = prefix + name;
      const absolute = child(root, rel);
      const st = noLinks(ctx.io, absolute);
      if (st.isDirectory()) {
        if (!directories.has(rel)) fail('UNLISTED_FILE', 'Unlisted directory in resource tree: ' + rel);
        visit(absolute, rel + '/');
      } else {
        if (!declared.has(rel)) fail('UNLISTED_FILE', 'Unlisted file in resource tree: ' + rel);
        seen.add(rel);
      }
    }
  };
  visit(root);
  if (seen.size !== declared.size) fail('CONTENT_INVALID', 'Resource tree is incomplete');
}
function verifyTree(ctx: any, root: any, value: any, metadata = ['manifest.json']) {
  const normalized = manifest(value);
  inventory(ctx, root, new Set([...metadata, ...normalized.entries.map((e: any) => e.path)]));
  // Reuse the existing verifier for all bytes/hash checks, after stronger install path checks.
  const result = verifyManifestEntries({ root, manifest: normalized, io: ctx.io });
  if (!result.ok) fail('CONTENT_INVALID', 'Resource bytes failed verification', result.errors);
  return result;
}
function packRoot(ctx: any, release: any) {
  return release.source.kind === 'offline'
    ? child(path.resolve(release.source.root), release.path)
    : child(ctx.store, 'downloads/' + release.packageIdentity + '/pack');
}
function readPack(ctx: any, release: any) {
  const root = packRoot(ctx, release);
  noLinks(ctx.io, root);
  const raw = readBytes(ctx.io, child(root, 'manifest.json'));
  const deltaFile = child(root, 'delta.json');
  const delta = noLinks(ctx.io, deltaFile, { missing: true }) ? readBytes(ctx.io, deltaFile) : null;
  const decoded = decodePack(raw, delta, release);
  verifyTree(ctx, root, decoded.manifest, delta === null ? ['manifest.json'] : ['manifest.json', 'delta.json']);
  return { root, ...decoded };
}
function targetManifest(pack: any, base: any, release: any) {
  if (!pack.delta) return pack.manifest;
  if (!base) fail('BASELINE_REQUIRED', 'Delta installation needs a verified installed baseline');
  const result = verifyDeltaPackContent({ baseManifest: base, packManifest: pack.manifest, delta: pack.delta });
  if (!result.ok) fail('BASELINE_MISMATCH', 'Delta is incompatible with installed baseline', result.errors);
  const removed = new Set(pack.delta.removed.map((e: any) => e.path));
  const entries = new Map(base.entries.filter((e: any) => !removed.has(e.path)).map((e: any) => [e.path, e]));
  for (const entry of pack.manifest.entries) entries.set(entry.path, entry);
  const target = manifest({ schemaVersion: 1, entries: [...entries.values()], unverified: [] });
  if (manifestContentIdentity(target) !== release.targetIdentity) fail('TARGET_MISMATCH', 'Reconstructed target differs from approval');
  return target;
}
export = { HASH, ID, manifest, releasePolicy, reference, validateReference, packageIdentity, decodePack,
  inventory, verifyTree, packRoot, readPack, targetManifest };
