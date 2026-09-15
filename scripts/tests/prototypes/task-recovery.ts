import { errorMessage as runtimeErrorMessage } from '../../lib/runtime-errors';
'use strict';

/**
 * Isolated design prototype for plan 005, never imported by a runtime route.
 * The caller supplies an empty fixture directory and fake backend adapters.
 * This is a single-writer journal, not a production cross-process lock service.
 * Checksums detect accidental corruption, not malicious changes or valid-prefix
 * truncation. Directory fsync, native power loss and result delivery are outside
 * this prototype. Recovery deliberately has no submit operation.
 */
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { createHash }: typeof import('node:crypto') = require('node:crypto');

const ACTIVE = new Set(['prepared', 'submitting', 'running', 'cancelling']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const FIELDS = [
  'id', 'ownerHash', 'requestKey', 'requestHash', 'engine', 'backendFingerprint',
  'upstreamId', 'state', 'revision', 'createdAt', 'updatedAt', 'deadline',
  'cancelRequestedAt', 'cancelDeadline', 'cancelAttemptedAt', 'upstreamSettled',
  'resultDisposition', 'code',
];
const IMMUTABLE = [
  'id', 'ownerHash', 'requestKey', 'requestHash', 'engine', 'backendFingerprint',
  'createdAt', 'deadline',
];
const EDGES = {
  prepared: new Set(['submitting', 'cancelled', 'interrupted']),
  submitting: new Set(['running', 'cancelling', 'interrupted']),
  running: new Set(['running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  cancelling: new Set(['cancelling', 'cancelled', 'interrupted']),
};
const digest = (value: any) => createHash('sha256').update(value).digest('hex');
const copy = (value: any) => JSON.parse(JSON.stringify(value));
const token = (value: any) => typeof value === 'string' && /^[\w-]{1,160}$/.test(value);
const hash = (value: any) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = (value: any) => Number.isSafeInteger(value) && value >= 0;

function assertRecord(record: any, previous: any) {
  if (!record || Object.keys(record).sort().join() !== [...FIELDS].sort().join()) throw Error('INVALID_RECORD_FIELDS');
  if (!token(record.id) || !token(record.requestKey) || !hash(record.ownerHash)
    || !hash(record.requestHash) || !hash(record.backendFingerprint)) throw Error('INVALID_IDENTITY');
  if (!['comfy', 'webui', 'video-batch'].includes(record.engine)
    || (record.upstreamId !== null && !token(record.upstreamId))) throw Error('INVALID_BACKEND');
  if ((!ACTIVE.has(record.state) && !TERMINAL.has(record.state))
    || !['none', 'available', 'discard'].includes(record.resultDisposition)
    || typeof record.upstreamSettled !== 'boolean'
    || (record.code !== null && !token(record.code))) throw Error('INVALID_STATE');
  if (!time(record.createdAt) || !time(record.updatedAt) || !time(record.deadline)
    || record.updatedAt < record.createdAt || record.deadline < record.createdAt
    || !['cancelRequestedAt', 'cancelDeadline', 'cancelAttemptedAt'].every(key => record[key] === null || time(record[key]))) throw Error('INVALID_TIME');
  if (!previous) {
    if (record.state !== 'prepared' || record.revision !== 1 || record.upstreamId !== null
      || record.cancelRequestedAt !== null || record.upstreamSettled) throw Error('INVALID_INITIAL_STATE');
    return;
  }
  if (record.revision !== previous.revision + 1 || IMMUTABLE.some(key => record[key] !== previous[key])
    || record.updatedAt < previous.updatedAt) throw Error('STALE_OR_CHANGED_IDENTITY');
  if (!EDGES[previous.state]?.has(record.state)) throw Error('INVALID_TRANSITION');
  if (previous.upstreamId && previous.upstreamId !== record.upstreamId) throw Error('BACKEND_ID_CHANGED');
  if (previous.cancelRequestedAt !== null && previous.cancelRequestedAt !== record.cancelRequestedAt) throw Error('CANCEL_INTENT_CHANGED');
  if (record.state === 'succeeded' && record.cancelRequestedAt !== null) throw Error('CANCELLED_RESULT_REVIVAL');
}

class RecoveryJournal {
  constructor(directory: any) {
    this.file = path.join(path.resolve(directory), 'task-recovery.jsonl');
    this.records = new Map();
    this.sequence = 0;
    this.head = '0'.repeat(64);
    this.error = null;
    this.length = 0;
    fs.mkdirSync(directory, { recursive: true });
    this.replay();
  }

  replay() {
    if (!fs.existsSync(this.file)) return;
    const bytes = fs.readFileSync(this.file);
    this.length = bytes.length;
    try {
      const raw = bytes.toString('utf8');
      if (raw && !raw.endsWith('\n')) throw Error('TORN_JOURNAL_TAIL');
      for (const line of raw.split('\n').slice(0, -1)) {
        const envelope = JSON.parse(line);
        if (Object.keys(envelope).sort().join() !== 'checksum,payload') throw Error('INVALID_ENVELOPE');
        const event = envelope.payload;
        if (Object.keys(event).sort().join() !== 'previous,record,sequence,version'
          || event.version !== 1 || event.sequence !== this.sequence + 1 || event.previous !== this.head
          || envelope.checksum !== digest(JSON.stringify(event))) throw Error('JOURNAL_INTEGRITY');
        const previous = this.records.get(event.record.id);
        assertRecord(event.record, previous);
        this.assertUnique(event.record);
        this.records.set(event.record.id, event.record);
        this.sequence = event.sequence;
        this.head = envelope.checksum;
      }
    } catch (error) {
      // Preserve the entire journal and valid prefix for diagnosis, but forbid
      // all recovery side effects: the invalid suffix may contain cancel intent.
      this.error = runtimeErrorMessage(error);
    }
  }

  assertHealthy() {
    if (this.error) throw Error(`JOURNAL_BLOCKED:${this.error}`);
  }

  assertUnique(record: any) {
    for (const other of this.records.values()) {
      if (other.id !== record.id && other.ownerHash === record.ownerHash
        && other.requestKey === record.requestKey) throw Error('DUPLICATE_REQUEST_KEY');
    }
  }

  get(id: any) { return this.records.has(id) ? copy(this.records.get(id)) : null; }

  write(record: any) {
    this.assertHealthy();
    const previous = this.records.get(record.id);
    assertRecord(record, previous);
    this.assertUnique(record);
    const payload = { version: 1, sequence: this.sequence + 1, previous: this.head, record };
    const checksum = digest(JSON.stringify(payload));
    const line = Buffer.from(JSON.stringify({ payload, checksum }) + '\n');
    try {
      // Detect an unexpected writer; this check is intentionally not a claim
      // of cross-process serialization. Production requires an exclusive owner.
      const length = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      if (length !== this.length) throw Error('JOURNAL_WRITER_CHANGED');
      const fd = fs.openSync(this.file, 'a');
      try { fs.writeFileSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) {
      this.error = runtimeErrorMessage(error);
      throw error;
    }
    this.length += line.length;
    this.sequence = payload.sequence;
    this.head = checksum;
    this.records.set(record.id, copy(record));
    return copy(record);
  }

  create(input: any, now: any) {
    this.assertHealthy();
    for (const existing of this.records.values()) {
      if (existing.ownerHash !== input.ownerHash || existing.requestKey !== input.requestKey) continue;
      if (existing.requestHash !== input.requestHash || existing.engine !== input.engine
        || existing.backendFingerprint !== input.backendFingerprint) throw Error('IDEMPOTENCY_CONFLICT');
      return copy(existing);
    }
    return this.write({
      id: input.id, ownerHash: input.ownerHash, requestKey: input.requestKey,
      requestHash: input.requestHash, engine: input.engine, backendFingerprint: input.backendFingerprint,
      upstreamId: null, state: 'prepared', revision: 1, createdAt: now, updatedAt: now,
      deadline: input.deadline, cancelRequestedAt: null, cancelDeadline: null,
      cancelAttemptedAt: null, upstreamSettled: false, resultDisposition: 'none', code: null,
    });
  }

  change(id: any, patch: any, now: any) {
    const current = this.get(id);
    if (!current) throw Error('UNKNOWN_JOB');
    return this.write({ ...current, ...patch, revision: current.revision + 1, updatedAt: Math.max(now, current.updatedAt) });
  }

  cleanupCandidates(now: any, retentionMs: any) {
    this.assertHealthy();
    // Preview only. Unknown upstream state and pending result delivery are never
    // treated as permission to delete files or remove an idempotency tombstone.
    return [...this.records.values()].filter(record => TERMINAL.has(record.state)
      && record.upstreamSettled && record.resultDisposition !== 'available'
      && record.updatedAt + retentionMs <= now).map(record => record.id);
  }
}

class RecoveryCoordinator {
  constructor(journal: any, adapters: any, options = {}) {
    this.journal = journal;
    this.adapters = adapters;
    this.now = options.now || Date.now;
    this.cancelTimeoutMs = options.cancelTimeoutMs || 30_000;
    this.cancelRetryMs = options.cancelRetryMs || 5_000;
    this.inflight = new Map();
  }

  markSubmitting(id: any) {
    // The real submitter must durably record this BEFORE any upstream request.
    return this.journal.change(id, { state: 'submitting' }, this.now());
  }

  acknowledge(id: any, upstreamId: any) {
    const current = this.journal.get(id);
    if (!current) throw Error('UNKNOWN_JOB');
    // A late submit acknowledgement identifies the backend but must not clear
    // a cancellation that was durably requested while the submit was in flight.
    return this.journal.change(id, {
      state: current.cancelRequestedAt !== null ? 'cancelling' : 'running', upstreamId,
    }, this.now());
  }

  requestCancel(id: any) {
    this.journal.assertHealthy();
    const current = this.journal.get(id);
    if (!current) throw Error('UNKNOWN_JOB');
    if (TERMINAL.has(current.state) || current.cancelRequestedAt !== null) return current;
    return this.journal.change(id, {
      state: current.state === 'prepared' ? 'cancelled' : 'cancelling',
      cancelRequestedAt: this.now(), cancelDeadline: this.now() + this.cancelTimeoutMs,
      upstreamSettled: current.state === 'prepared', code: 'CANCEL_REQUESTED',
    }, this.now());
  }

  reconcile(id: any) {
    if (this.inflight.has(id)) return this.inflight.get(id);
    const task = Promise.resolve().then(() => this.run(id)).finally(() => this.inflight.delete(id));
    this.inflight.set(id, task);
    return task;
  }

  interrupt(id: any, code: any) {
    return this.journal.change(id, { state: 'interrupted', code }, this.now());
  }

  async run(id: any) {
    this.journal.assertHealthy();
    let current = this.journal.get(id);
    if (!current) throw Error('UNKNOWN_JOB');
    if (TERMINAL.has(current.state)) return current;
    if (current.state === 'prepared') return this.interrupt(id, 'NOT_SUBMITTED');
    const adapter = this.adapters[current.engine];
    if (!adapter || adapter.fingerprint !== current.backendFingerprint) return this.interrupt(id, 'BACKEND_IDENTITY_UNVERIFIED');
    if (!current.upstreamId) return this.interrupt(id, 'SUBMIT_OUTCOME_UNKNOWN');
    if (!adapter.queryById) return this.interrupt(id, 'BACKEND_NOT_QUERYABLE');

    let observation;
    try { observation = await adapter.queryById(current.upstreamId); } catch {
      current = this.journal.get(id);
      const deadline = current.cancelRequestedAt !== null ? current.cancelDeadline : current.deadline;
      return this.now() >= deadline ? this.interrupt(id, 'RECONCILE_TIMEOUT_UNKNOWN') : current;
    }
    // Read current intent after every asynchronous boundary. A cancel committed
    // during query wins over result adoption; a completed job is never revived.
    current = this.journal.get(id);
    if (!observation || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'missing'].includes(observation.state)) return this.interrupt(id, 'BACKEND_RESPONSE_INVALID');
    if (['succeeded', 'failed', 'cancelled'].includes(observation.state)) {
      const cancelled = current.cancelRequestedAt !== null || observation.state === 'cancelled';
      return this.journal.change(id, {
        state: cancelled ? 'cancelled' : observation.state,
        upstreamSettled: true,
        resultDisposition: observation.state === 'succeeded' ? (cancelled ? 'discard' : 'available') : 'none',
        code: cancelled ? 'CANCEL_CONFIRMED' : 'BACKEND_TERMINAL_OBSERVED',
      }, this.now());
    }
    // Missing history is not proof of failure or safe cancellation.
    if (observation.state === 'missing') return this.interrupt(id, 'BACKEND_HISTORY_MISSING');
    if (current.cancelRequestedAt !== null) {
      if (this.now() >= current.cancelDeadline) return this.interrupt(id, 'CANCEL_TIMEOUT_UNKNOWN');
      if (!adapter.cancelById || !adapter.idempotentCancel) return this.interrupt(id, 'SAFE_CANCEL_UNAVAILABLE');
      if (current.cancelAttemptedAt !== null && this.now() < current.cancelAttemptedAt + this.cancelRetryMs) return current;
      this.journal.change(id, { state: 'cancelling', cancelAttemptedAt: this.now() }, this.now());
      try {
        await adapter.cancelById(current.upstreamId, `${current.id}:cancel`);
      } catch { /* Lost response remains cancelling; query before any retry. */ }
      return this.journal.get(id); // HTTP acknowledgement is not cancellation proof.
    }
    if (this.now() >= current.deadline) return this.interrupt(id, 'EXECUTION_TIMEOUT_UNKNOWN');
    return current;
  }
}

export = { RecoveryJournal, RecoveryCoordinator, digest };
