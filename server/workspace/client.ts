import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { acquireWorkspaceOwner } from './owner';
import { WorkspaceError, isWorkspaceMutation, type WorkspaceCommand, type WorkspaceContext, type WorkspaceResults } from './types';

export interface WorkspaceRequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface WorkspaceService {
  readonly workspaceId: string;
  readonly runtimeEpoch: string;
  request<C extends WorkspaceCommand>(command: C, context: WorkspaceContext, options?: WorkspaceRequestOptions): Promise<WorkspaceResults[C['kind']]>;
  close(): Promise<void>;
}
interface WorkerFailure { code: string; message: string; status: number }
type WorkerReply = { type: 'ready' | 'closed' }
  | { type: 'startup-error'; error: WorkerFailure }
  | { type: 'result'; id: number; value?: unknown; error?: WorkerFailure };
interface Pending {
  command: WorkspaceCommand;
  cancel: Int32Array;
  settled: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** The main thread never opens SQLite. One bounded RPC queue owns one storage worker. */
export async function openWorkspace(options: {
  root: string; workspaceId: string; create?: boolean; timeoutMs?: number;
}): Promise<WorkspaceService> {
  const root = path.resolve(options.root);
  if (!path.isAbsolute(options.root)) throw new WorkspaceError('WORKSPACE_IDENTITY', 'Workspace root must be absolute');
  const forbiddenRoots = [path.resolve(__dirname, '../..'), process.env.AICS_ASSETS_ROOT,
    process.env.AICS_RUNTIME_ROOT, process.env.AI_WORKSPACE_ROOT].filter((value): value is string => Boolean(value));
  for (const forbidden of forbiddenRoots) {
    const relative = path.relative(path.resolve(forbidden), root);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new WorkspaceError('WORKSPACE_LOCATION', 'Private workspace must be outside application, public asset, cache and model directories', 400);
    }
  }
  const lease = acquireWorkspaceOwner(root, options.workspaceId, options.create === true);
  let worker: Worker;
  try {
    worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: {
      root, workspaceId: options.workspaceId, writerEpoch: lease.owner.nonce, create: options.create === true,
    } });
  } catch (error) { lease.release(); throw error; }

  const pending = new Map<number, Pending>();
  let sequence = 0, closing = false, failed = false, closedAck = false, ready = false;
  let closePromise: Promise<void> | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const startup = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const unknown = (command: WorkspaceCommand, reason: string) => isWorkspaceMutation(command)
    ? new WorkspaceError('COMMIT_UNKNOWN', `${reason}; query the original operation receipt before retrying`, 503)
    : new WorkspaceError('WORKSPACE_UNAVAILABLE', reason, 503);
  const fail = (error: Error) => {
    failed = true;
    if (!ready) rejectReady(error);
    for (const entry of pending.values()) {
      Atomics.store(entry.cancel, 0, 1);
      if (!entry.settled) entry.reject(unknown(entry.command, 'Workspace worker stopped'));
      entry.cleanup();
    }
    pending.clear();
  };
  worker.on('error', error => fail(error instanceof Error ? error : new Error('Workspace worker failed')));
  worker.on('exit', code => {
    if (!closedAck) fail(new WorkspaceError('WORKSPACE_UNAVAILABLE', `Storage worker exited (${code})`, 503));
    resolveExit();
  });
  worker.on('message', (message: WorkerReply) => {
    if (message.type === 'ready') { ready = true; resolveReady(); return; }
    if (message.type === 'startup-error') {
      rejectReady(new WorkspaceError(message.error.code, message.error.message, message.error.status));
      return;
    }
    if (message.type === 'closed') { closedAck = true; return; }
    if (message.type !== 'result') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    entry.cleanup();
    if (entry.settled) return;
    if (message.error) entry.reject(new WorkspaceError(message.error.code, message.error.message, message.error.status));
    else entry.resolve(message.value);
  });
  const startupTimer = setTimeout(() => rejectReady(new WorkspaceError('WORKSPACE_TIMEOUT', 'Workspace startup timed out', 503)), options.timeoutMs ?? 15_000);
  try { await startup; }
  catch (error) {
    await worker.terminate();
    await exited;
    // This owner has not admitted an operation, and its exact worker is now stopped.
    lease.release();
    throw error;
  } finally { clearTimeout(startupTimer); }

  return {
    workspaceId: options.workspaceId,
    runtimeEpoch: lease.owner.nonce,
    request<C extends WorkspaceCommand>(command: C, context: WorkspaceContext, requestOptions: WorkspaceRequestOptions = {}) {
      if (closing || failed) return Promise.reject(new WorkspaceError('WORKSPACE_UNAVAILABLE', 'Workspace is not accepting work', 503));
      if (requestOptions.signal?.aborted) return Promise.reject(new WorkspaceError('ABORTED', 'Workspace request was cancelled', 499));
      if (pending.size >= 32) return Promise.reject(new WorkspaceError('WORKSPACE_BUSY', 'Workspace request queue is full', 429));
      const timeoutMs = requestOptions.timeoutMs ?? 30_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
        return Promise.reject(new WorkspaceError('INVALID_COMMAND', 'Invalid workspace request timeout', 400));
      }
      const id = ++sequence;
      const cancel = new Int32Array(new SharedArrayBuffer(4));
      return new Promise<WorkspaceResults[C['kind']]>((resolve, reject) => {
        const settleCancelled = (reason: string, timedOut = false) => {
          const entry = pending.get(id);
          if (!entry || entry.settled) return;
          entry.settled = true;
          Atomics.store(cancel, 0, 1);
          entry.cleanup();
          reject(isWorkspaceMutation(command) ? unknown(command, reason)
            : new WorkspaceError(timedOut ? 'WORKSPACE_TIMEOUT' : 'ABORTED', reason, timedOut ? 504 : 499));
          // Keep its queue slot until worker acknowledgment, including unknown writes.
        };
        const abort = () => settleCancelled('Workspace request was cancelled');
        const timer = setTimeout(() => settleCancelled('Workspace request timed out', true), timeoutMs);
        const entry: Pending = { command, cancel, settled: false, resolve: value => resolve(value as WorkspaceResults[C['kind']]), reject,
          cleanup: () => { clearTimeout(timer); requestOptions.signal?.removeEventListener('abort', abort); } };
        pending.set(id, entry);
        requestOptions.signal?.addEventListener('abort', abort, { once: true });
        try { worker.postMessage({ type: 'request', id, command, context, cancellation: cancel.buffer }); }
        catch (error) { pending.delete(id); entry.cleanup(); reject(error); }
      });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      // A backup can copy outside the write lane; cancel unfinished copies before
      // closing, while letting already admitted short mutations drain normally.
      for (const entry of pending.values()) {
        if (entry.command.kind === 'backup' || entry.command.kind === 'restoreBackup') Atomics.store(entry.cancel, 0, 1);
      }
      closePromise = (async () => {
        if (failed) { await worker.terminate(); await exited; throw new WorkspaceError('WORKSPACE_RECOVERY_REQUIRED', 'Failed workspace owner retained for host recovery', 503); }
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          for (const entry of pending.values()) Atomics.store(entry.cancel, 0, 1);
          void worker.terminate();
        }, 5_000);
        worker.postMessage({ type: 'close' });
        try { await exited; } finally { clearTimeout(timer); }
        if (timedOut || !closedAck || failed) {
          throw new WorkspaceError('WORKSPACE_RECOVERY_REQUIRED', 'Workspace did not close cleanly; owner lock retained', 503);
        }
        lease.release();
      })();
      return closePromise;
    },
  };
}
