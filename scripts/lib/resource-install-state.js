'use strict';

const { child, readJson, noLinks, fail } = require('./resource-install-fs');
const { manifest, verifyTree, validateReference } = require('./resource-install-policy');
const { manifestContentIdentity } = require('./resource-pack-delta');

function emptyState() { return { schemaVersion: 1, sequence: 0, current: null, previous: null }; }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function validateState(ctx, state) {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.sequence) || state.sequence < 0
    || !Object.hasOwn(state, 'current') || !Object.hasOwn(state, 'previous')) fail('STATE_INVALID', 'Installed state is malformed');
  for (const ref of [state.current, state.previous]) if (ref !== null) validateReference(ctx, ref);
  return state;
}
function readState(ctx) {
  return validateState(ctx, readJson(ctx.io, child(ctx.store, 'current.json'), true) || emptyState());
}
function versionRoot(ctx, ref) {
  validateReference(ctx, ref);
  return child(ctx.store, 'versions/' + ref.identity);
}
function verifyVersion(ctx, ref) {
  const root = versionRoot(ctx, ref);
  const saved = manifest(readJson(ctx.io, child(root, 'manifest.json')));
  if (manifestContentIdentity(saved) !== ref.identity) fail('INSTALLED_TAMPERED', 'Installed manifest identity differs from approved target');
  const receipt = readJson(ctx.io, child(root, 'receipt.json'));
  if (!equal(receipt, { schemaVersion: 1, reference: ref })) fail('INSTALLED_TAMPERED', 'Installed receipt is invalid');
  const verification = verifyTree(ctx, root, saved, ['manifest.json', 'receipt.json']);
  return { root, manifest: saved, reference: ref, verification };
}
function existingVersion(ctx, identity) {
  const root = child(ctx.store, 'versions/' + identity);
  if (!noLinks(ctx.io, root, { missing: true })) return null;
  const receipt = readJson(ctx.io, child(root, 'receipt.json'));
  if (receipt?.reference?.identity !== identity) fail('INSTALLED_TAMPERED', 'Existing target has an invalid receipt');
  return verifyVersion(ctx, receipt.reference);
}
function nextState(journal) {
  return { schemaVersion: 1, sequence: journal.before.sequence + 1, current: journal.target, previous: journal.before.current };
}
function readJournal(ctx) {
  const journal = readJson(ctx.io, child(ctx.store, 'pending.json'), true);
  if (!journal) return null;
  if (journal.schemaVersion !== 1 || !/^[\da-f-]{36}$/.test(journal.id || '')
    || !['install', 'rollback'].includes(journal.kind) || !['copying', 'prepared'].includes(journal.phase)) {
    fail('JOURNAL_INVALID', 'Recovery journal is malformed');
  }
  validateState(ctx, journal.before);
  validateReference(ctx, journal.target);
  if (!Number.isSafeInteger(journal.before.sequence + 1)) fail('JOURNAL_INVALID', 'State sequence overflow');
  return journal;
}
module.exports = { emptyState, equal, validateState, readState, versionRoot, verifyVersion, existingVersion, nextState, readJournal };
