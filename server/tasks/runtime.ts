import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { TaskRecord, TaskSubmission } from '../../types/tasks';
import type { TaskCommand, TaskResults, TaskPatch } from '../workspace/task-types';
import type { WorkspaceContext } from '../workspace/types';
import { WorkspaceError } from '../workspace/types';
import type { TaskProvider, TaskRecoveryProvider, TaskOutput } from './provider';
import { createTaskInputAccess } from './input-storage';

export interface TaskWorkspace {
  workspaceId: string; runtimeEpoch: string;
  request(command: TaskCommand | { kind: 'readMedia'; alias: string; offset: number }, context: WorkspaceContext): Promise<unknown>;
}
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
}
export const taskFingerprint = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

export function createTaskRuntime(options: { workspace: TaskWorkspace; providers: Partial<Record<TaskRecord['kind'], TaskProvider>>; pollMs?: number }) {
  const { workspace, providers } = options;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const busy = new Set<string>();
  const dispatched = new Set<string>();
  const workInFlight = new Set<Promise<unknown>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const track = <T>(work: Promise<T>): Promise<T> => {
    workInFlight.add(work); void work.then(() => workInFlight.delete(work), () => workInFlight.delete(work)); return work;
  };
  const context = (principalId: string): WorkspaceContext => ({ principalId, workspaceId: workspace.workspaceId, protocolVersion: 1 });
  const execute = <K extends TaskCommand['kind']>(principal: string, command: Extract<TaskCommand, { kind: K }>) =>
    workspace.request(command, context(principal)) as Promise<TaskResults[K]>;
  const get = async (principal: string, taskId: string) => {
    const task = await execute(principal, { kind: 'task.get', taskId });
    if (!task) throw new WorkspaceError('TASK_NOT_FOUND', 'Task does not exist', 404);
    return task;
  };
  async function patch(principal: string, id: string, value: TaskPatch): Promise<TaskRecord> {
    for (let retry = 0; retry < 5; retry++) {
      const current = await get(principal, id);
      try { return await execute(principal, { kind: 'task.patch', taskId: id, expectedRevision: current.revision, patch: value }); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'REVISION_CONFLICT' || retry === 4) throw error; }
    }
    throw new Error('Task revision did not converge');
  }
  async function collectOutputs(principal: string, taskId: string, outputs: TaskOutput[]) {
    for (const [position, output] of outputs.entries()) {
      const index = output.index ?? position;
      const hash = createHash('sha256');
      const bytes = 'bytes' in output ? output.bytes.length : fs.statSync(output.file).size;
      if ('bytes' in output) hash.update(output.bytes);
      else for await (const chunk of fs.createReadStream(output.file)) hash.update(chunk);
      const media = { alias: `task-${taskId}-${index}`, sha256: hash.digest('hex'), bytes, mime: output.mime, index };
      let { offset } = await execute(principal, { kind: 'task.result.prepare', taskId, media });
      const fd = 'file' in output ? await fs.promises.open(output.file, 'r') : null;
      try { while (offset < bytes) {
        const data = 'bytes' in output ? output.bytes.subarray(offset, offset + 1024 * 1024) : Buffer.alloc(Math.min(1024 * 1024, bytes - offset));
        if (fd) await fd.read(data, 0, data.length, offset);
        ({ offset } = await execute(principal, { kind: 'task.result.chunk', taskId, index, offset, data }));
      } } finally { await fd?.close(); }
      await execute(principal, { kind: 'task.result.commit', taskId, index });
    }
  }
  const collect = (principal: string, taskId: string, outputs: TaskOutput[]) => track(collectOutputs(principal, taskId, outputs));
  const inputAccess = (task: TaskRecord) => {
    const access = createTaskInputAccess(workspace, context(task.principalId), task.taskId);
    return {
      protectInput: (name: string, file: string) => track(access.protectInput(name, file)),
      restoreInput: (name: string, file: string) => track(access.restoreInput(name, file)),
    };
  };
  function schedule(principal: string, id: string) {
    if (closed || pending.has(id)) return;
    const timer = setTimeout(() => { pending.delete(id); void reconcile(principal, id).catch(() => {}); }, options.pollMs ?? 1500);
    timer.unref(); pending.set(id, timer);
  }
  async function reconcileTask(principal: string, id: string): Promise<TaskRecord> {
    let task = await get(principal, id);
    if (closed || busy.has(id) || task.deliveryState === 'discarded' || (task.upstreamSettled && (task.status !== 'succeeded' || task.resultState === 'available'))) return task;
    const provider: TaskRecoveryProvider | undefined = providers[task.kind];
    if (!provider || provider.fingerprint() !== task.providerFingerprint) return patch(principal, id, { recoveryState: 'unknown', errorCode: 'PROVIDER_IDENTITY_CHANGED' });
    if (!task.submissionIntentAt) return dispatched.has(id) ? task : patch(principal, id, { recoveryState: 'interrupted', errorCode: 'TASK_AWAITING_RESUME' });
    busy.add(id);
    try {
      if (task.cancelRequestedAt && !task.upstreamSettled) await provider.cancel(task);
      const observation = await provider.query(task);
      task = await get(principal, id);
      if (observation.outputs?.length) await collect(principal, id, observation.outputs);
      task = await get(principal, id);
      const status = task.cancelRequestedAt && observation.settled ? 'cancelled' : observation.status;
      task = await patch(principal, id, { status, upstreamSettled: observation.settled,
        recoveryState: observation.unknown ? 'unknown' : 'normal', errorCode: observation.errorCode ?? null,
        ...(observation.metadata ? { metadata: observation.metadata } : {}),
        ...(observation.checkpoint ? { checkpoint: observation.checkpoint } : {}),
        ...(observation.status === 'succeeded' && !observation.outputs?.length && task.resultState !== 'available' ? { resultState: 'unavailable' } : {}),
      });
      if (!task.upstreamSettled && !observation.unknown) schedule(principal, id);
      if (task.upstreamSettled) dispatched.delete(id);
      return task;
    } catch (error) {
      task = await patch(principal, id, { recoveryState: 'unknown', errorCode: 'TASK_RECONCILE_REQUIRED' });
      return task;
    } finally { busy.delete(id); }
  }
  const reconcile = (principal: string, id: string) => track(reconcileTask(principal, id));
  async function dispatch(task: TaskRecord) {
    dispatched.add(task.taskId);
    const principal = task.principalId;
    const provider = providers[task.kind]!;
    try {
      if ((await get(principal, task.taskId)).cancelRequestedAt) return;
      await provider.submit(task, {
        ...inputAccess(task),
        async submitting(providerName, fingerprint) {
          const current = await get(principal, task.taskId);
          if (current.cancelRequestedAt || closed) throw new WorkspaceError('CANCELLED', 'Task was cancelled', 499);
          await patch(principal, task.taskId, { status: 'submitting', recoveryState: 'normal', errorCode: null, submissionIntentAt: Date.now(), provider: providerName, providerFingerprint: fingerprint || provider.fingerprint() });
          schedule(principal, task.taskId);
        },
        async observed(upstreamId, metadata) { await patch(principal, task.taskId, { upstreamId, submissionObservedAt: Date.now(), status: 'running', ...(metadata ? { metadata } : {}) }); schedule(principal, task.taskId); },
        async checkpoint(value) { await track(patch(principal, task.taskId, { checkpoint: value,
          ...(value.effectiveInput && typeof value.effectiveInput === 'object' ? { input: value.effectiveInput as Record<string, unknown> } : {}) })); },
        async collect(outputs) { if (!closed) await collect(principal, task.taskId, outputs); },
      });
      await reconcile(principal, task.taskId);
    } catch (error) {
      const current = await get(principal, task.taskId);
      if (current.status === 'cancelled') return;
      await patch(principal, task.taskId, current.submissionIntentAt
        ? { recoveryState: 'unknown', errorCode: 'SUBMISSION_UNCONFIRMED' }
        : { status: 'failed', upstreamSettled: true, errorCode: 'TASK_VALIDATION_FAILED' });
    }
  }
  return {
    runtimeEpoch: workspace.runtimeEpoch,
    list: (principal: string) => execute(principal, { kind: 'task.list' }), get,
    legacyHistory: (principal: string) => execute(principal, { kind: 'task.legacy-history' }),
    findByRequestKey: (principal: string, requestKey: string) => execute(principal, { kind: 'task.get', requestKey }),
    submit(principal: string, request: TaskSubmission) { return track((async () => {
      if (closed) throw new WorkspaceError('TASK_RUNTIME_CLOSED', 'Task runtime is closed', 503);
      const provider = providers[request.kind];
      if (!provider) throw new WorkspaceError('TASK_PROVIDER_UNAVAILABLE', 'Task provider is unavailable', 503);
      // Fingerprint the user's frozen submission before normalization generates defaults/seeds.
      const requestFingerprint = taskFingerprint({ kind: request.kind, input: request.input, context: request.context });
      const existing = await execute(principal, { kind: 'task.get', requestKey: request.requestKey });
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) throw new WorkspaceError('TASK_KEY_CONFLICT', 'Request key was already used with different input', 409);
        return existing;
      }
      const input = provider.validate(structuredClone(request.input)); const now = Date.now();
      const { task, created } = await execute(principal, { kind: 'task.accept', record: {
        taskId: randomUUID(), workspaceId: workspace.workspaceId, principalId: principal, requestKey: request.requestKey,
        requestFingerprint, kind: request.kind, provider: request.kind, providerFingerprint: provider.fingerprint(), upstreamId: null,
        status: 'queued', recoveryState: 'normal', revision: 0, runtimeEpoch: workspace.runtimeEpoch, createdAt: now, updatedAt: now,
        submissionIntentAt: null, submissionObservedAt: null, cancelRequestedAt: null, upstreamSettled: false,
        executionDeadline: now + 3 * 60 * 60 * 1000, input, inputMediaRefs: [], resultState: 'none', resultRefs: [],
        deliveryState: 'unseen', errorCode: null, metadata: { context: structuredClone(request.context ?? {}) }, checkpoint: null, parentBatchId: null, stepIndex: null,
      } });
      if (created && !task.cancelRequestedAt && provider.prepare) {
        try { await track(provider.prepare(task, inputAccess(task))); }
        catch (error) { await patch(principal, task.taskId, { status: 'failed', upstreamSettled: true, errorCode: 'TASK_INPUT_UNAVAILABLE' }); throw error; }
      }
      if (created && !task.cancelRequestedAt) void track(dispatch(task)).catch(() => {});
      return get(principal, task.taskId);
    })()); },
    cancel(principal: string, requestKey: string) { return track((async () => {
      if (closed) throw new WorkspaceError('TASK_RUNTIME_CLOSED', 'Task runtime is closed', 503);
      const task = await execute(principal, { kind: 'task.cancel', requestKey });
      if (task && !task.upstreamSettled) void reconcile(principal, task.taskId).catch(() => {});
      return task;
    })()); },
    reconcile,
    action(principal: string, id: string, name: string) { return track((async () => {
      if (closed) throw new WorkspaceError('TASK_RUNTIME_CLOSED', 'Task runtime is closed', 503);
      const task = await get(principal, id); const provider = providers[task.kind];
      if (!provider?.action || provider.fingerprint() !== task.providerFingerprint) throw new WorkspaceError('TASK_ACTION_INVALID', 'Task action unavailable');
      await track(provider.action(task, name, {
        ...inputAccess(task),
        async submitting() {
          if (name !== 'continue' || (await get(principal, id)).cancelRequestedAt) throw new WorkspaceError('TASK_ACTION_INVALID', 'This action cannot submit generation');
          await patch(principal, id, { status: 'running', recoveryState: 'normal' });
        },
        async observed() { throw new WorkspaceError('TASK_ACTION_INVALID', 'This action cannot submit generation'); },
        async checkpoint(value) { await track(patch(principal, id, { checkpoint: value })); },
        async collect(outputs) { if (!closed) await collect(principal, id, outputs); },
      }));
      if (name === 'continue') { await patch(principal, id, { recoveryState: 'normal', errorCode: null }); schedule(principal, id); }
      return get(principal, id);
    })()); },
    async resume(principal: string, id: string) {
      const task = await get(principal, id);
      if (task.submissionIntentAt || task.cancelRequestedAt || task.status !== 'queued') throw new WorkspaceError('TASK_RESUME_UNSAFE', 'Only never submitted queued work can resume');
      if (closed) throw new WorkspaceError('TASK_RUNTIME_CLOSED', 'Task runtime is closed', 503);
      void track(dispatch(task)).catch(() => {}); return task;
    },
    async recover(principal: string) {
      const { items } = await execute(principal, { kind: 'task.list' });
      for (const task of items) if (task.deliveryState !== 'discarded' && (!task.upstreamSettled || (task.status === 'succeeded' && task.resultState !== 'available'))) await reconcile(principal, task.taskId);
    },
    async delivery(principal: string, id: string, state: TaskRecord['deliveryState']) {
      if (closed) throw new WorkspaceError('TASK_RUNTIME_CLOSED', 'Task runtime is closed', 503);
      return track(patch(principal, id, { deliveryState: state }));
    },
    close() {
      if (closePromise) return closePromise;
      closed = true; for (const timer of pending.values()) clearTimeout(timer); pending.clear();
      closePromise = (async () => {
        await Promise.allSettled(Object.values(providers).map(provider => provider.close?.()));
        while (workInFlight.size) await Promise.allSettled([...workInFlight]);
      })();
      return closePromise;
    },
  };
}
export type TaskRuntime = ReturnType<typeof createTaskRuntime>;
