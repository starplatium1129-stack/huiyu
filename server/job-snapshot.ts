'use strict';

import type { SnapshotJob, JobSnapshot, JobSnapshotStore } from './job-types';
import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');

// This is a loss ledger, not an execution journal: never resubmit GPU work from it.
// Keep crash evidence across repeated restarts, bounded by age and record count.
const LOST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOST_JOBS = 256;
const MAX_SNAPSHOT_BYTES = 16 * 1024;
type RetainedSnapshot = JobSnapshot & { lostAt?: number };

function safeId(id: unknown): string {
  // Reject, do not strip/truncate: otherwise different IDs can overwrite/delete one another.
  return typeof id === 'string' && /^[\w-][\w.-]{0,79}$/.test(id) ? id : '';
}
function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
function validOwner(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

/** Apply the same field/type whitelist on write AND restore. Never trust disk JSON. */
function toSnapshot(job: SnapshotJob): JobSnapshot {
  const input = job.input || {};
  return {
    id: safeId(job.id),
    owner: validOwner(job.owner) ? job.owner : null,
    status: 'running',
    createdAt: positive(job.createdAt) ?? undefined,
    estimatedSeconds: positive(job.estimatedSeconds),
    input: {
      modelId: typeof input.modelId === 'string' && input.modelId.length <= 200 ? input.modelId : null,
      width: positive(input.width), height: positive(input.height), duration: positive(input.duration),
      family: typeof input.family === 'string' && input.family.length <= 80 && !/[\x00-\x1f\x7f]/.test(input.family) ? input.family : null,
    },
  };
}

function createJobSnapshotStore(dir?: string | null): JobSnapshotStore {
  if (!dir) return { save() {}, remove() {}, drain() { return []; } };
  const directory = path.resolve(dir);
  const warned = new Set<string>();
  function warn(code: string) {
    if (warned.has(code)) return;
    warned.add(code);
    // No paths, prompts, owner IDs or caught exception text in diagnostics.
    console.warn('[job-snapshot] ' + code + '：任务中断记录可能不完整，请检查运行目录。');
  }
  function usableDirectory(): boolean {
    try { return fs.lstatSync(directory).isDirectory(); } catch { return false; }
  }
  function fileOf(id: unknown): string | null {
    const key = safeId(id);
    return key ? path.join(directory, key + '.json') : null;
  }
  function write(target: string, value: RetainedSnapshot): void {
    const temporary = target + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
    try {
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error('size');
      fs.writeFileSync(temporary, bytes, { flag:'wx', mode:0o600, flush:true });
      fs.renameSync(temporary, target);
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
  function save(job: SnapshotJob) {
    try {
      const target = fileOf(job.id);
      if (!target || !validOwner(job.owner)) { warn('INVALID_SNAPSHOT'); return; }
      fs.mkdirSync(directory, { recursive:true });
      if (!usableDirectory()) { warn('UNSAFE_DIRECTORY'); return; }
      write(target, toSnapshot(job));
    } catch { warn('SAVE_FAILED'); }
  }
  function remove(id: unknown) {
    const target = fileOf(id);
    if (!target || !usableDirectory()) return;
    try { if (fs.lstatSync(target).isFile()) fs.unlinkSync(target); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') warn('REMOVE_FAILED'); }
  }
  function read(full: string): unknown {
    const before = fs.lstatSync(full);
    if (!before.isFile() || before.size > MAX_SNAPSHOT_BYTES) throw new Error('unsafe snapshot');
    const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const after = fs.fstatSync(fd);
      if (!after.isFile() || after.size > MAX_SNAPSHOT_BYTES || after.ino !== before.ino || after.dev !== before.dev)
        throw new Error('changed snapshot');
      const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > MAX_SNAPSHOT_BYTES) throw new Error('size');
      return JSON.parse(buffer.toString('utf8', 0, length)) as unknown;
    } finally { fs.closeSync(fd); }
  }

  /** Drain active snapshots into a retained loss ledger; a second restart still returns JOB_LOST. */
  function drain(): JobSnapshot[] {
    if (!usableDirectory()) return [];
    let names: string[];
    try { names = fs.readdirSync(directory).filter(name => name.endsWith('.json') && !name.includes('.tmp-')); }
    catch { warn('READ_FAILED'); return []; }
    const now = Date.now();
    const records: Array<{ snapshot: JobSnapshot; lostAt: number }> = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      const full = fileOf(id);
      if (!full) continue;
      try {
        const raw = read(full);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('schema');
        const parsed = raw as RetainedSnapshot;
        if (parsed.id !== id || parsed.status !== 'running' || !validOwner(parsed.owner)) throw new Error('identity');
        const snapshot = toSnapshot(parsed);
        const lostAt = Math.min(positive(parsed.lostAt) ?? now, now);
        if (now - lostAt >= LOST_RETENTION_MS) { remove(id); continue; }
        // Atomically retain before exposing the tombstone; no destructive read-then-write gap.
        try { write(full, { ...snapshot, lostAt }); } catch { warn('RETAIN_FAILED'); }
        records.push({ snapshot, lostAt });
      } catch {
        // Leave unknown/corrupt files untouched for diagnosis; never follow links or echo their content.
        warn('INVALID_SNAPSHOT');
      }
    }
    records.sort((a, b) => b.lostAt - a.lostAt || a.snapshot.id.localeCompare(b.snapshot.id));
    for (const record of records.slice(MAX_LOST_JOBS)) remove(record.snapshot.id);
    return records.slice(0, MAX_LOST_JOBS).map(record => record.snapshot);
  }
  return { save, remove, drain };
}

export = { createJobSnapshotStore, toSnapshot, safeId };
