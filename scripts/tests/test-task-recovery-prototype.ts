'use strict';

import { TestContext } from 'node:test';

const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { RecoveryJournal, RecoveryCoordinator, digest }: typeof import('./prototypes/task-recovery') = require('./prototypes/task-recovery');

const fingerprint = digest('isolated-comfy-fixture');
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-task-recovery-'));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    const temporary = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), temporary);
    assert.match(path.basename(resolved), /^aics-task-recovery-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  let timestamp = 1_000;
  const calls = { query: 0, cancel: [], submit: 0 };
  const backend = {
    fingerprint, idempotentCancel: true, state: 'running',
    async queryById() { calls.query += 1; return { state: this.state }; },
    async cancelById(id: any, key: any) { calls.cancel.push({ id, key }); this.state = 'cancelled'; },
    async submit() { calls.submit += 1; throw Error('RECOVERY_MUST_NEVER_SUBMIT'); },
  };
  let journal: any;
  let recovery: any;
  function restart() {
    journal = new RecoveryJournal(directory);
    recovery = new RecoveryCoordinator(journal, { comfy: backend }, { now: () => timestamp });
  }
  restart();
  const input = {
    id: 'gateway-job-a', ownerHash: digest('fixture-owner'), requestKey: 'request-a',
    requestHash: digest('fixture-parameters'), engine: 'comfy', backendFingerprint: fingerprint,
    deadline: 61_000,
  };
  function accepted(overrides: any = {}) {
    const job = journal.create({ ...input, ...overrides }, timestamp);
    recovery.markSubmitting(job.id);
    recovery.acknowledge(job.id, `upstream-${job.id}`);
    return job.id;
  }
  return {
    directory, calls, backend, input, accepted, restart,
    get journal() { return journal; }, get recovery() { return recovery; },
    advance(ms: number) { timestamp += ms; }, get now() { return timestamp; },
  };
}

test('concurrent recovery and repeated restarts query one identity without submission or duplicate completion', async t => {
  const f = fixture(t);
  const id = f.accepted();
  f.backend.state = 'succeeded';
  f.restart();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.recovery.reconcile(id)));
  assert.ok(results.every(job => job.state === 'succeeded' && job.resultDisposition === 'available'));
  assert.equal(f.calls.query, 1);
  const revision = f.journal.get(id).revision;
  f.restart();
  await f.recovery.reconcile(id);
  assert.equal(f.journal.get(id).revision, revision);
  assert.equal(f.calls.query, 1);
  assert.equal(f.calls.submit, 0);
});

test('durable cancel intent during an in-flight completion query prevents result revival', async t => {
  const f = fixture(t);
  const id = f.accepted();
  let release;
  let entered: (value: any) => void;
  const started = new Promise(resolve => { entered = resolve; });
  f.backend.queryById = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const recovery = f.recovery.reconcile(id);
  await started;
  f.recovery.requestCancel(id);
  release!({ state: 'succeeded' });
  assert.equal((await recovery).state, 'cancelled');
  f.restart();
  assert.equal(f.journal.get(id).resultDisposition, 'discard');
  assert.equal((await f.recovery.reconcile(id)).state, 'cancelled');
  assert.equal(f.calls.submit, 0);
});

test('a completion committed before a cancel stays terminal; delete-result semantics belong to engine adapters', async t => {
  const f = fixture(t);
  const id = f.accepted();
  f.backend.state = 'succeeded';
  await f.recovery.reconcile(id);
  assert.equal(f.recovery.requestCancel(id).state, 'succeeded');
  assert.equal(f.calls.cancel.length, 0);
});

test('cancel acknowledgement is not termination; a restart queries before an idempotent cancel retry', async t => {
  const f = fixture(t);
  const id = f.accepted();
  f.backend.cancelById = async (upstreamId, key) => { f.calls.cancel.push({ id: upstreamId, key }); };
  f.recovery.requestCancel(id);
  assert.equal((await f.recovery.reconcile(id)).state, 'cancelling');
  f.restart();
  await f.recovery.reconcile(id);
  assert.equal(f.calls.cancel.length, 1);
  f.advance(5_000);
  await f.recovery.reconcile(id);
  assert.equal(f.calls.query, 3);
  assert.equal(f.calls.cancel.length, 2);
  assert.deepEqual(f.calls.cancel[1], f.calls.cancel[0]);
  f.backend.state = 'cancelled';
  assert.equal((await f.recovery.reconcile(id)).state, 'cancelled');
  assert.equal(f.calls.cancel.length, 2);
});

test('cancel accepted upstream with a lost response is confirmed by query after restart', async t => {
  const f = fixture(t);
  const id = f.accepted();
  f.backend.cancelById = async () => { f.calls.cancel.push('accepted'); f.backend.state = 'cancelled'; throw Error('LOST_RESPONSE'); };
  f.recovery.requestCancel(id);
  assert.equal((await f.recovery.reconcile(id)).state, 'cancelling');
  f.restart();
  assert.equal((await f.recovery.reconcile(id)).state, 'cancelled');
  assert.equal(f.calls.cancel.length, 1);
});

test('late submit acknowledgement retains cancellation and enables targeted reconciliation', async t => {
  const f = fixture(t);
  f.journal.create(f.input, f.now);
  f.recovery.markSubmitting(f.input.id);
  f.recovery.requestCancel(f.input.id);
  assert.equal(f.recovery.acknowledge(f.input.id, 'late-prompt-id').state, 'cancelling');
  f.restart();
  assert.equal((await f.recovery.reconcile(f.input.id)).state, 'cancelling');
  assert.deepEqual(f.calls.cancel, [{ id: 'late-prompt-id', key: `${f.input.id}:cancel` }]);
  assert.equal((await f.recovery.reconcile(f.input.id)).state, 'cancelled');
  assert.equal(f.calls.submit, 0);
});

test('accepted submission with lost prompt_id is explicitly interrupted and never resubmitted', async t => {
  const f = fixture(t);
  f.journal.create(f.input, f.now);
  f.recovery.markSubmitting(f.input.id);
  // The fixture represents an accepted upstream request whose response was lost.
  f.backend.state = 'running';
  f.restart();
  const job = await f.recovery.reconcile(f.input.id);
  assert.equal(job.code, 'SUBMIT_OUTCOME_UNKNOWN');
  assert.equal(job.state, 'interrupted');
  assert.equal(job.upstreamSettled, false);
  assert.equal(f.calls.query, 0);
  assert.equal(f.calls.submit, 0);
});

test('lost gateway response reuses the durable owner-scoped request key; mismatched parameters are rejected', t => {
  const f = fixture(t);
  const id = f.accepted();
  f.restart();
  const same = f.journal.create({ ...f.input, id: 'new-client-id', prompt: 'must-not-persist', token: 'secret' }, f.now);
  assert.equal(same.id, id);
  assert.equal(same.upstreamId, `upstream-${id}`);
  assert.throws(() => f.journal.create({ ...f.input, requestHash: digest('different') }, f.now), /IDEMPOTENCY_CONFLICT/);
  const anotherOwner = f.journal.create({ ...f.input, id: 'another-owner', ownerHash: digest('another-owner') }, f.now);
  assert.equal(anotherOwner.id, 'another-owner');
  const contents = fs.readFileSync(f.journal.file, 'utf8');
  assert.ok(!contents.includes('must-not-persist') && !contents.includes('secret'));
});

test('corrupt or torn journal blocks all backend side effects and preserves the original bytes', async t => {
  for (const damage of ['torn', 'checksum', 'sequence', 'schema']) {
    await t.test(damage, async subtest => {
      const f = fixture(subtest);
      const id = f.accepted();
      const lines = fs.readFileSync(f.journal.file, 'utf8').trimEnd().split('\n');
      let contents;
      if (damage === 'torn') contents = lines.join('\n') + '\n{"payload":';
      else {
        const last = JSON.parse(lines.at(-1));
        if (damage === 'checksum') last.payload.record.state = 'succeeded';
        if (damage === 'sequence') last.payload.sequence += 2;
        if (damage === 'schema') last.payload.record.prompt = 'unexpected-private-field';
        if (damage !== 'checksum') last.checksum = digest(JSON.stringify(last.payload));
        lines[lines.length - 1] = JSON.stringify(last);
        contents = lines.join('\n') + '\n';
      }
      fs.writeFileSync(f.journal.file, contents);
      f.restart();
      assert.ok(f.journal.error);
      await assert.rejects(f.recovery.reconcile(id), /JOURNAL_BLOCKED/);
      assert.throws(() => f.recovery.requestCancel(id), /JOURNAL_BLOCKED/);
      assert.equal(f.calls.query + f.calls.cancel.length + f.calls.submit, 0);
      assert.equal(fs.readFileSync(f.journal.file, 'utf8'), contents);
    });
  }
});

test('an unexpected second writer blocks append before changing the in-memory task', t => {
  const f = fixture(t);
  const second = new RecoveryJournal(f.directory);
  f.accepted();
  assert.throws(() => second.create({ ...f.input, id: 'second', requestKey: 'second' }, f.now), /JOURNAL_WRITER_CHANGED/);
  assert.equal(second.get('second'), null);
  assert.ok(second.error);
});

test('changed backend identity and missing history require review, never global interruption or resubmit', async t => {
  const f = fixture(t);
  const first = f.accepted();
  f.backend.fingerprint = digest('replacement-backend');
  assert.equal((await f.recovery.reconcile(first)).code, 'BACKEND_IDENTITY_UNVERIFIED');
  assert.equal(f.calls.query, 0);
  const second = f.accepted({ id: 'second', requestKey: 'second' });
  f.backend.fingerprint = fingerprint;
  f.backend.state = 'missing';
  assert.equal((await f.recovery.reconcile(second)).code, 'BACKEND_HISTORY_MISSING');
  assert.equal(f.calls.cancel.length + f.calls.submit, 0);
});

test('unsubmitted work and WebUI jobs have no automatic continuation capability', async t => {
  const f = fixture(t);
  f.journal.create(f.input, f.now);
  assert.equal((await f.recovery.reconcile(f.input.id)).code, 'NOT_SUBMITTED');
  const id = f.accepted({ id: 'web', requestKey: 'web', engine: 'webui' });
  const recovery = new RecoveryCoordinator(f.journal, { webui: { fingerprint } }, { now: () => f.now });
  assert.equal((await recovery.reconcile(id)).code, 'BACKEND_NOT_QUERYABLE');
  assert.equal(f.calls.submit, 0);
});

test('sleep beyond deadline reconciles a finished backend before applying timeout; uncertain work is retained', async t => {
  const f = fixture(t);
  const completed = f.accepted();
  f.advance(90_000);
  f.backend.state = 'succeeded';
  assert.equal((await f.recovery.reconcile(completed)).state, 'succeeded');
  const uncertain = f.accepted({ id: 'uncertain', requestKey: 'uncertain', deadline: f.now });
  f.backend.queryById = async () => { throw Error('BACKEND_OFFLINE'); };
  assert.equal((await f.recovery.reconcile(uncertain)).code, 'RECONCILE_TIMEOUT_UNKNOWN');
  f.advance(100_000);
  assert.deepEqual(f.journal.cleanupCandidates(f.now, 1_000), []);
  assert.ok(f.journal.get(uncertain));
});

test('cancel timeout and unsafe cancellation are explicit uncertainty, never false cancellation', async t => {
  const f = fixture(t);
  const first = f.accepted();
  f.recovery.requestCancel(first);
  f.advance(31_000);
  assert.equal((await f.recovery.reconcile(first)).code, 'CANCEL_TIMEOUT_UNKNOWN');
  assert.equal(f.calls.cancel.length, 0);
  const second = f.accepted({ id: 'unsafe', requestKey: 'unsafe' });
  f.recovery.requestCancel(second);
  f.backend.idempotentCancel = false;
  assert.equal((await f.recovery.reconcile(second)).code, 'SAFE_CANCEL_UNAVAILABLE');
  assert.equal(f.calls.cancel.length, 0);
});

test('cleanup is preview-only and selects settled cancelled records after retention', async t => {
  const f = fixture(t);
  const id = f.accepted();
  f.recovery.requestCancel(id);
  f.backend.state = 'cancelled';
  await f.recovery.reconcile(id);
  assert.deepEqual(f.journal.cleanupCandidates(f.now, 1_000), []);
  f.advance(1_000);
  assert.deepEqual(f.journal.cleanupCandidates(f.now, 1_000), [id]);
  assert.ok(fs.existsSync(f.journal.file));
  assert.equal(f.journal.get(id).state, 'cancelled');
});
