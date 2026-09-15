import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

const { randomUUID }: typeof import('node:crypto') = require('node:crypto');
const { context, access, locked, child, noLinks, mkdir, readJson, writeJson, unlink, ensureSpace,
  cancelled, event, fail, flushDir, cleanAtomicTemps }: typeof import('./resource-install-fs') = require('./resource-install-fs');
const { HASH, releasePolicy, reference, readPack, targetManifest, verifyTree }: typeof import('./resource-install-policy') = require('./resource-install-policy');
const { equal, readState, verifyVersion, existingVersion, nextState, readJournal }: typeof import('./resource-install-state') = require('./resource-install-state');
const { copyEntry, fileMatches }: typeof import('./resource-install-copy') = require('./resource-install-copy');

function savedJournal(ctx: any, journal: any) { writeJson(ctx.io, child(ctx.store, 'pending.json'), journal); }
function forgetJournal(ctx: any) { unlink(ctx.io, child(ctx.store, 'pending.json')); }
function verifyBefore(ctx: any, journal: any) {
  if (journal.before.current) verifyVersion(ctx, journal.before.current);
}
function result(ctx: any, state: any, action: any, extra = {}) {
  return { ok: true, kind: 'resource-install-result', action, state,
    installedRoot: state.current ? child(ctx.store, 'versions/' + state.current.identity) : null, ...extra };
}
function quarantineFailedTarget(ctx: any, journal: any) {
  if (journal.kind !== 'install' || [journal.before.current, journal.before.previous]
    .some(ref => ref?.identity === journal.target.identity)) return;
  const target = child(ctx.store, 'versions/' + journal.target.identity);
  if (!noLinks(ctx.io, target, { missing: true })) return;
  const receipt = readJson(ctx.io, child(target, 'receipt.json'));
  if (!equal(receipt, { schemaVersion: 1, reference: journal.target })) fail('INSTALLED_TAMPERED', 'Cannot quarantine a target with unknown ownership');
  const transaction = child(ctx.store, 'transactions/' + journal.id);
  mkdir(ctx.io, transaction);
  const rejected = child(transaction, 'rejected-' + randomUUID());
  noLinks(ctx.io, target);
  ctx.io.renameSync(target, rejected);
  flushDir(ctx.io, transaction);
}

// A pointer written before a process exit is accepted only after re-reading all installed
// bytes. Invalid new bytes restore the independently verified old pointer.
function finishInterruptedSwitch(ctx: any, journal: any, state: any) {
  if (!equal(state, nextState(journal))) return null;
  try {
    verifyVersion(ctx, journal.target);
  } catch (error) {
    verifyBefore(ctx, journal);
    writeJson(ctx.io, child(ctx.store, 'current.json'), journal.before);
    quarantineFailedTarget(ctx, journal);
    forgetJournal(ctx);
    return result(ctx, journal.before, 'rolled-back', { cause: { code: runtimeErrorCode(error), message: runtimeErrorMessage(error) } });
  }
  forgetJournal(ctx);
  return result(ctx, state, 'recovered');
}
async function commit(ctx: any, journal: any, signal: any) {
  cancelled(signal);
  access(ctx);
  const state = readState(ctx);
  if (!equal(state, journal.before)) fail('STATE_CONFLICT', 'Installed state changed during transaction');
  verifyVersion(ctx, journal.target);
  const next = nextState(journal);
  try {
    ensureSpace(ctx, 65536);
    writeJson(ctx.io, child(ctx.store, 'current.json'), next);
    await event(ctx, 'switched', { identity: journal.target.identity }, signal);
    access(ctx);
    verifyVersion(ctx, journal.target);
    cancelled(signal);
    forgetJournal(ctx);
    return result(ctx, next, journal.kind === 'rollback' ? 'rolled-back' : 'installed');
  } catch (error: any) {
    const current = readState(ctx);
    if (equal(current, next)) {
      try {
        verifyBefore(ctx, journal);
        writeJson(ctx.io, child(ctx.store, 'current.json'), journal.before);
        error.rolledBack = true;
      } catch (rollbackError) {
        error.recoveryRequired = true;
        error.rollbackError = { code: runtimeErrorCode(rollbackError), message: runtimeErrorMessage(rollbackError) };
      }
    }
    throw error;
  }
}
async function performInstall(ctx: any, releaseId: any, signal: any) {
  const release = releasePolicy(ctx, releaseId);
  cancelled(signal);
  let journal = readJournal(ctx);
  const before: any = readState(ctx);
  if (journal) {
    if (journal.kind !== 'install' || journal.releaseId !== releaseId || journal.packageIdentity !== release.packageIdentity) {
      fail('PENDING_TRANSACTION', 'Recover the existing transaction before starting another release');
    }
    const finished = finishInterruptedSwitch(ctx, journal, before);
    if (finished) return finished;
    if (!equal(before, journal.before)) fail('STATE_CONFLICT', 'Journal baseline differs from installed state');
    if (journal.target.identity !== release.targetIdentity) fail('JOURNAL_INVALID', 'Journal target differs from approved release');
    // A prepared version is self-contained: recovery no longer depends on the removable source.
    let existing;
    try { existing = existingVersion(ctx, release.targetIdentity); }
    catch (error) {
      if (!['CONTENT_INVALID', 'INSTALLED_TAMPERED', 'UNLISTED_FILE'].includes(runtimeErrorCode(error))) throw error;
      quarantineFailedTarget(ctx, journal);
      existing = existingVersion(ctx, release.targetIdentity);
    }
    if (existing) {
      verifyBefore(ctx, journal);
      journal.target = existing.reference;
      journal.phase = 'prepared';
      savedJournal(ctx, journal);
      return commit(ctx, journal, signal);
    }
  }
  const installed: any = before.current ? verifyVersion(ctx, before.current) : null;
  const pack = readPack(ctx, release);
  if (!journal && before.current?.identity === release.targetIdentity) {
    if (pack.delta) {
      const identity = pack.delta.baseManifest?.contentIdentity;
      if (!HASH.test(identity || '')) fail('BASELINE_MISMATCH', 'Invalid delta baseline identity');
      const base = existingVersion(ctx, identity);
      targetManifest(pack, base?.manifest, release);
    }
    return result(ctx, before, 'already-installed');
  }
  const target = targetManifest(pack, installed?.manifest, release);
  if (!journal) {
    const reusable = existingVersion(ctx, release.targetIdentity);
    journal = { schemaVersion: 1, id: randomUUID(), kind: 'install', phase: 'copying',
      releaseId, packageIdentity: release.packageIdentity, before, target: reusable?.reference || reference(release) };
    ensureSpace(ctx, 65536);
    savedJournal(ctx, journal);
    await event(ctx, 'journal', { id: journal.id }, signal);
    if (reusable) {
      journal.phase = 'prepared';
      savedJournal(ctx, journal);
      return commit(ctx, journal, signal);
    }
  }
  const transaction = child(ctx.store, 'transactions/' + journal.id);
  const tree = child(transaction, 'tree');
  const parts = child(transaction, 'parts');
  mkdir(ctx.io, tree);
  cleanAtomicTemps(ctx.io, tree, ['manifest.json', 'receipt.json']);
  let remaining = Buffer.byteLength(JSON.stringify(target)) + 65536;
  for (const entry of target.entries) {
    if (!fileMatches(ctx, child(tree, entry.path), entry)) remaining += entry.bytes;
  }
  ensureSpace(ctx, remaining);
  const candidatePaths = new Set(pack.manifest.entries.map((entry: any) => entry.path));
  for (const entry of target.entries) {
    access(ctx);
    const sourceRoot = candidatePaths.has(entry.path) ? pack.root : installed.root;
    await copyEntry(ctx, { sourceRoot, tree, parts, entry, signal });
  }
  writeJson(ctx.io, child(tree, 'manifest.json'), target);
  writeJson(ctx.io, child(tree, 'receipt.json'), { schemaVersion: 1, reference: journal.target });
  verifyTree(ctx, tree, target, ['manifest.json', 'receipt.json']);
  await event(ctx, 'staged', { identity: journal.target.identity }, signal);
  const versions = child(ctx.store, 'versions');
  mkdir(ctx.io, versions);
  const destination = child(versions, journal.target.identity);
  if (noLinks(ctx.io, destination, { missing: true })) fail('TARGET_EXISTS', 'Target appeared during installation');
  noLinks(ctx.io, tree);
  ctx.io.renameSync(tree, destination);
  flushDir(ctx.io, versions);
  verifyVersion(ctx, journal.target);
  journal.phase = 'prepared';
  savedJournal(ctx, journal);
  await event(ctx, 'prepared', { identity: journal.target.identity }, signal);
  return commit(ctx, journal, signal);
}

function createResourceInstaller(options: any) {
  const ctx = context(options);
  return {
    root: ctx.store,
    async install({ releaseId, signal } = {}) {
      releasePolicy(ctx, releaseId); // Fail closed before creating a directory or lock.
      return locked(ctx, () => performInstall(ctx, releaseId, signal));
    },
    async recover({ signal } = {}) {
      access(ctx);
      return locked(ctx, async () => {
        const journal = readJournal(ctx);
        const state: any = readState(ctx);
        if (!journal) {
          if (state.current) verifyVersion(ctx, state.current);
          return result(ctx, state, 'nothing-to-recover');
        }
        const finished = finishInterruptedSwitch(ctx, journal, state);
        if (finished) return finished;
        if (journal.kind === 'install') return performInstall(ctx, journal.releaseId, signal);
        return commit(ctx, journal, signal);
      });
    },
    async rollback({ signal } = {}) {
      access(ctx);
      return locked(ctx, async () => {
        if (readJournal(ctx)) fail('PENDING_TRANSACTION', 'Recover the pending transaction first');
        const before: any = readState(ctx);
        if (!before.previous) fail('NO_PREVIOUS_VERSION', 'No previous resource installation is retained');
        verifyVersion(ctx, before.previous);
        const journal = { schemaVersion: 1, id: randomUUID(), kind: 'rollback', phase: 'prepared',
          before, target: before.previous };
        savedJournal(ctx, journal);
        return commit(ctx, journal, signal);
      });
    },
    async status() {
      access(ctx);
      if (!noLinks(ctx.io, ctx.store, { missing: true })) return { ok: true, action: 'not-installed', state: null, installedRoot: null };
      return locked(ctx, async () => {
        const state: any = readState(ctx);
        const current = state.current ? verifyVersion(ctx, state.current) : null;
        const pending = readJournal(ctx);
        let previous = null;
        if (state.previous) {
          try { verifyVersion(ctx, state.previous); previous = { ok: true, identity: state.previous.identity }; }
          catch (error) { previous = { ok: false, code: runtimeErrorCode(error), message: runtimeErrorMessage(error) }; }
        }
        return result(ctx, state, current ? 'verified-installed' : 'not-installed', {
          verifiedFiles: current?.manifest.entries.length || 0,
          pending: pending ? { kind: pending.kind, phase: pending.phase, releaseId: pending.releaseId || null } : null, previous });
      });
    },
    plan({ releaseId } = {}) {
      const release = releasePolicy(ctx, releaseId);
      return { ok: true, mode: 'preview', releaseId, sourceId: release.sourceId, sourceKind: release.source.kind,
        kind: release.kind, targetIdentity: release.targetIdentity, store: ctx.store,
        note: 'No writes or network requests. Approval is external; a matching hash alone is not a trusted source.' };
    },
  };
}
export = { createResourceInstaller };
