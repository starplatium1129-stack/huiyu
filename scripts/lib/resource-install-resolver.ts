import { errorCode as runtimeErrorCode } from './runtime-errors';
'use strict';

// Synchronous startup snapshot. This module never initializes storage, takes/reaps a lock,
// repairs state, imports data, or contacts a source. Keep the result inside the trusted gateway.
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { context, access, child, noLinks, readBytes, fail }: typeof import('./resource-install-fs') = require('./resource-install-fs');
const { validateState, versionRoot, verifyVersion }: typeof import('./resource-install-state') = require('./resource-install-state');
const { releasePolicy }: typeof import('./resource-install-policy') = require('./resource-install-policy');
const { sourceUrl }: typeof import('./resource-download-http') = require('./resource-download-http');

function object(value: any) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function parse(bytes: any, description: any) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail('METADATA_INVALID', description + ' is not valid JSON'); }
}
function protectedPaths(value: any) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
    fail('CONFIG_REQUIRED', 'protectedRoots must be an array of absolute application/artwork paths');
  }
  return value;
}
function configuration(options: any, io: any) {
  let config = options;
  let evidence = null;
  if (options.configPath !== undefined) {
    if (typeof options.configPath !== 'string' || !path.isAbsolute(options.configPath)) {
      fail('CONFIG_REQUIRED', 'configPath must be an absolute trusted local JSON path');
    }
    if (options.userDataRoot !== undefined || options.policy !== undefined) {
      fail('CONFIG_REQUIRED', 'Choose configPath or direct userDataRoot/policy, not both');
    }
    const bytes = readBytes(io, options.configPath);
    evidence = { path: options.configPath, bytes };
    config = parse(bytes, 'Resource configuration');
  }
  if (!object(config) || !object(config.policy) || !object(config.policy.sources) || !object(config.policy.releases)) {
    fail('CONFIG_REQUIRED', 'Resource configuration requires policy.sources and policy.releases');
  }
  // Access callbacks and IO always come from the trusted caller, never from JSON configuration.
  const protectedRoots = [...protectedPaths(config.protectedRoots),
    ...(evidence ? protectedPaths(options.protectedRoots) : [])];
  const ctx = context({ userDataRoot: config.userDataRoot, policy: config.policy, protectedRoots,
    access: options.access, io });
  for (const root of protectedRoots) {
    const stat = noLinks(io, root, { missing: true });
    if (stat && !stat.isDirectory()) fail('CONFIG_REQUIRED', 'protectedRoots must identify directories');
  }
  return { ctx, evidence };
}

function idle(ctx: any) {
  // Presence alone blocks mounting, even if pending.json is null, damaged, or a directory.
  // Never turn an uncertain/in-progress installation into a usable root by parsing it loosely.
  if (noLinks(ctx.io, child(ctx.store, 'pending.json'), { missing: true })) {
    fail('PENDING_TRANSACTION', 'Resource transaction requires explicit recovery before mounting');
  }
  const locks = child(ctx.store, 'locks');
  const stat = noLinks(ctx.io, locks, { missing: true });
  if (stat && !stat.isDirectory()) fail('STATE_INVALID', 'Resource lock area is not a directory');
  if (stat && ctx.io.readdirSync(locks).length) {
    fail('BUSY', 'Resource writer/claim/recovery lock exists; read-only resolution does not reclaim locks');
  }
}
function controls(ctx: any) {
  access(ctx);
  const stat = noLinks(ctx.io, ctx.store, { missing: true });
  if (!stat) return { marker: null, current: null };
  if (!stat.isDirectory()) fail('UNOWNED_ROOT', 'Resource store is not a directory');
  const marker = readBytes(ctx.io, child(ctx.store, 'store.json'));
  const value = parse(marker, 'Resource ownership marker');
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== 'aics-resource-library'
    || Object.keys(value).length !== 2) fail('UNOWNED_ROOT', 'Resource ownership marker is invalid');
  idle(ctx);
  const file = child(ctx.store, 'current.json');
  const current = noLinks(ctx.io, file, { missing: true }) ? readBytes(ctx.io, file) : null;
  return { marker, current };
}
function unchanged(before: any, after: any) {
  return before === null ? after === null : after !== null && before.equals(after);
}
function stable(ctx: any, before: any, evidence: any) {
  const after = controls(ctx);
  if (!unchanged(before.marker, after.marker) || !unchanged(before.current, after.current)) {
    fail('STATE_CONFLICT', 'Installed state changed during verification; retry a fresh read-only snapshot');
  }
  if (evidence && !evidence.bytes.equals(readBytes(ctx.io, evidence.path))) {
    fail('CONFIG_CHANGED', 'Trusted resource configuration changed during verification');
  }
  access(ctx);
}
function absentPointer(ctx: any) {
  // A missing pointer is not proof that a formerly installed library was never installed.
  for (const name of ['versions', 'transactions']) {
    const dir = child(ctx.store, name);
    const stat = noLinks(ctx.io, dir, { missing: true });
    if (stat && (!stat.isDirectory() || ctx.io.readdirSync(dir).length)) {
      fail('STATE_INVALID', 'current.json is missing while version/transaction evidence exists');
    }
  }
}

// A serving allowlist, not a file executor or general-purpose path resolver. All manifest
// entries are verified even if excluded here. SVG/CSS/HTML/scripts, fonts, arbitrary JSON,
// source data, and package metadata are intentionally not public resource overrides.
function serviceable(rel: any) {
  if (!rel.startsWith('assets/') || rel.split('/').some((part: any) => part.startsWith('.'))
    || /^assets\/character-references(?:\/|$)/i.test(rel)) return false;
  if (/\.(?:png|jpe?g|webp|avif|gif|ico|mp3|ogg|wav|flac|m4a|mp4|webm)$/i.test(rel)) return true;
  return rel.startsWith('assets/live2d/') && (/\.(?:moc3?|mtn)$/i.test(rel)
    || /\.(?:model3?|physics3?|pose3?|motion3|exp3?|cdi3)\.json$/i.test(rel));
}

/**
 * @param {object} options Same userDataRoot/protectedRoots/policy/access/io as the installer,
 *   OR {configPath, access, protectedRoots?, io?}. configPath is supplied by the trusted host
 *   (e.g. process.env.AICS_RESOURCE_CONFIG); this library never reads ambient env automatically.
 * @returns {object|null} Frozen {status, versionRoot, assetsRoot, identity, sequence,
 *   relativePaths, verifiedFiles}. relativePaths retain their exact assets/... spelling.
 *   assetsRoot is null when there are no serviceable entries; null means not installed.
 * @throws {Error} Coded errors for missing/invalid config, access, pending/busy/bad/changed state.
 * This verifies current bytes at startup, not future bytes or per-request access permission.
 */
function resolveInstalledResourceRoots(options = {}) {
  if (!object(options) || (options.configPath === undefined && options.userDataRoot === undefined)) {
    fail('CONFIG_REQUIRED', 'Explicit resource configuration is required');
  }
  if (typeof options.access?.isLocalStudioHost !== 'function' || typeof options.access?.isAuthorized !== 'function') {
    fail('ACCESS_DENIED', 'Trusted local-host and authorization callbacks are required');
  }
  access(options); // Reject unauthorized callers before even reading the configuration file.
  const { ctx, evidence } = configuration(options, options.io || fs);
  const before = controls(ctx);
  if (before.current === null) {
    if (before.marker !== null) absentPointer(ctx);
    stable(ctx, before, evidence);
    return null;
  }
  const state = validateState(ctx, parse(before.current, 'Installed state'));
  for (const ref of [state.current, state.previous].filter(Boolean)) {
    const release = releasePolicy(ctx, ref.releaseId);
    // URL construction is a pure configuration check. No HTTP request, DNS or source stat.
    if (release.source.kind === 'http') {
      try { sourceUrl(release, 'manifest.json'); }
      catch (error) {
        if (runtimeErrorCode(error)) throw error;
        fail('SOURCE_REQUIRED', 'Configured resource source URL is invalid');
      }
    }
  }
  if (state.current === null) {
    if (state.sequence !== 0 || state.previous !== null) fail('STATE_INVALID', 'Empty installed state has invalid history');
    stable(ctx, before, evidence);
    return null;
  }
  if (state.sequence === 0) fail('STATE_INVALID', 'Installed state requires a positive sequence');
  const root = versionRoot(ctx, state.current);
  const metadataFiles = ['manifest.json', 'receipt.json'].map(name => child(root, name));
  const metadata = metadataFiles.map(file => readBytes(ctx.io, file));
  // Reuses approved-reference, manifest identity, receipt, complete inventory, and all-byte
  // checks, including unlisted files, traversal, junctions and hard links. No source IO.
  const verified = verifyVersion(ctx, state.current);
  metadataFiles.forEach((file, index) => {
    if (!metadata[index].equals(readBytes(ctx.io, file))) fail('STATE_CONFLICT', 'Installed metadata changed during verification');
  });
  stable(ctx, before, evidence);
  const entries = Object.freeze(verified.manifest.entries.filter((entry: any) => serviceable(entry.path))
    .map((entry: any) => Object.freeze({ ...entry })).sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const relativePaths = Object.freeze(entries.map((entry: any) => entry.path));
  return Object.freeze({ status: 'verified', versionRoot: verified.root,
    assetsRoot: relativePaths.length ? child(verified.root, 'assets') : null,
    identity: state.current.identity, sequence: state.sequence, relativePaths,
    releaseId: state.current.releaseId, previousIdentity: state.previous?.identity || null,
    entries, verifiedFiles: verified.manifest.entries.length });
}

export = { resolveInstalledResourceRoots };
