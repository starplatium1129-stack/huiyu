'use strict';

const { child, readJson, noLinks, fail, object }: typeof import('./resource-install-fs') = require('./resource-install-fs');
const { manifest, verifyTree, validateReference }: typeof import('./resource-install-policy') = require('./resource-install-policy');
const { manifestContentIdentity }: typeof import('./resource-pack-delta') = require('./resource-pack-delta');

type Context = ReturnType<typeof import('./resource-install-fs').context>;
type Reference = ReturnType<typeof validateReference>;
type State = { schemaVersion: 1; sequence: number; current: Reference | null; previous: Reference | null };
type Journal = { schemaVersion: 1; id: string; phase: 'copying' | 'prepared'; before: State; target: Reference } & (
  { kind: 'install'; releaseId: string; packageIdentity: string } | { kind: 'rollback'; releaseId?: unknown; packageIdentity?: unknown }
);
function emptyState(): State { return { schemaVersion: 1, sequence: 0, current: null, previous: null }; }
function equal(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function validateState(ctx: Context, state: unknown): State {
  if (!object(state) || state.schemaVersion !== 1 || typeof state.sequence !== 'number' || !Number.isSafeInteger(state.sequence) || state.sequence < 0
    || !Object.hasOwn(state, 'current') || !Object.hasOwn(state, 'previous')) throw fail('STATE_INVALID', 'Installed state is malformed');
  for (const ref of [state.current, state.previous]) if (ref !== null) validateReference(ctx, ref);
  return state as State; // Sequence and both references were validated above.
}
function readState(ctx: Context) {
  return validateState(ctx, readJson(ctx.io, child(ctx.store, 'current.json'), true) || emptyState());
}
function verifyVersion(ctx: Context, input: unknown) {
  const ref = validateReference(ctx, input);
  const root = child(ctx.store, 'versions/' + ref.identity);
  const saved = manifest(readJson(ctx.io, child(root, 'manifest.json')));
  if (manifestContentIdentity(saved) !== ref.identity) fail('INSTALLED_TAMPERED', 'Installed manifest identity differs from approved target');
  const receipt = readJson(ctx.io, child(root, 'receipt.json'));
  if (!equal(receipt, { schemaVersion: 1, reference: ref })) fail('INSTALLED_TAMPERED', 'Installed receipt is invalid');
  const verification = verifyTree(ctx, root, saved, ['manifest.json', 'receipt.json']);
  return { root, manifest: saved, reference: ref, verification };
}
function existingVersion(ctx: Context, identity: string) {
  const root = child(ctx.store, 'versions/' + identity);
  if (!noLinks(ctx.io, root, { missing: true })) return null;
  const receipt = readJson(ctx.io, child(root, 'receipt.json'));
  if (!object(receipt) || !object(receipt.reference) || receipt.reference.identity !== identity) throw fail('INSTALLED_TAMPERED', 'Existing target has an invalid receipt');
  return verifyVersion(ctx, receipt.reference);
}
function nextState(journal: Journal): State {
  return { schemaVersion: 1, sequence: journal.before.sequence + 1, current: journal.target, previous: journal.before.current };
}
function readJournal(ctx: Context): Journal | null {
  const journal = readJson(ctx.io, child(ctx.store, 'pending.json'), true);
  if (!journal) return null;
  if (!object(journal) || journal.schemaVersion !== 1 || typeof journal.id !== 'string' || !/^[\da-f-]{36}$/.test(journal.id)
    || (journal.kind !== 'install' && journal.kind !== 'rollback') || (journal.phase !== 'copying' && journal.phase !== 'prepared')
    || (journal.kind === 'install' && (typeof journal.releaseId !== 'string' || typeof journal.packageIdentity !== 'string'))) {
    throw fail('JOURNAL_INVALID', 'Recovery journal is malformed');
  }
  const before = validateState(ctx, journal.before);
  validateReference(ctx, journal.target);
  if (!Number.isSafeInteger(before.sequence + 1)) fail('JOURNAL_INVALID', 'State sequence overflow');
  return journal as Journal; // Header, baseline state and target reference are all checked.
}
export = { equal, readState, verifyVersion, existingVersion, nextState, readJournal };
