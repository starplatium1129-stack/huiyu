import { checkAvailableSpace, digest, publishMedia, uploadedBytes, uploadMediaChunk } from './media';
import { nextRevision, type WorkspaceStorageContext } from './schema';
import { WorkspaceError, type WorkspaceContext, type ExecuteOptions } from './types';
import type { TaskCommand, TaskResult, TaskPatch } from './task-types';
import type { TaskRecord, TaskResultRef } from '../../types/tasks';
import { executeTaskInput } from './task-inputs';
import type { TaskInputCommand } from './task-types';

const terminal = (task: TaskRecord) => ['succeeded', 'failed', 'cancelled'].includes(task.status);
export function executeTaskCommand(storage: WorkspaceStorageContext, command: TaskCommand,
  context: WorkspaceContext, options: ExecuteOptions = {}): TaskResult {
  const principal = context.principalId;
  if (command.kind.startsWith('task.input.')) return executeTaskInput(storage, principal, command as TaskInputCommand);
  const read = (taskId?: string, requestKey?: string): TaskRecord | null => {
    const row = taskId ? storage.db.prepare('SELECT record_json FROM tasks WHERE principal_id=? AND task_id=?').get(principal, taskId)
      : storage.db.prepare('SELECT record_json FROM tasks WHERE principal_id=? AND request_key=?').get(principal, requestKey ?? '');
    return row ? { ...JSON.parse(String(row.record_json)), runtimeEpoch: storage.writerEpoch } : null;
  };
  const requireTask = (id: string) => {
    const task = read(id);
    if (!task) throw new WorkspaceError('TASK_NOT_FOUND', 'Task does not exist', 404);
    return task;
  };
  const write = (task: TaskRecord) => {
    task.revision = nextRevision(storage); task.updatedAt = Date.now(); task.runtimeEpoch = storage.writerEpoch;
    storage.db.prepare('UPDATE tasks SET provider=?,upstream_settled=?,record_json=? WHERE task_id=?')
      .run(task.provider, Number(task.upstreamSettled), JSON.stringify(task), task.taskId);
    return task;
  };
  const output = (id: string, index: number): TaskResultRef => {
    requireTask(id);
    const row = storage.db.prepare('SELECT media_json FROM task_outputs WHERE task_id=? AND output_index=?').get(id, index);
    if (!row) throw new WorkspaceError('TASK_RESULT_MISSING', 'Result was not prepared', 409);
    return JSON.parse(String(row.media_json));
  };
  const outputKey = (id: string, index: number) => digest(`task:${id}:${index}`);
  switch (command.kind) {
    case 'task.legacy-history': {
      const rows = storage.db.prepare(`SELECT i.migration_id,i.body FROM migration_items i JOIN migration_sessions s ON s.migration_id=i.migration_id
        WHERE s.principal_id=? AND s.state IN ('verified','activated') AND json_extract(i.body,'$.domain')='history'
        AND json_extract(i.body,'$.key')='aics_task_center_v1' ORDER BY s.revision,i.item_id`).all(principal);
      const snapshots: unknown[] = []; const indexed = new Map<string, Array<{ index: number; value: unknown }>>();
      for (const row of rows) {
        const body = JSON.parse(String(row.body)) as { index?: number; value: unknown };
        if (typeof body.value === 'string') { try { body.value = JSON.parse(body.value); } catch { continue; } }
        if (body.index === undefined) snapshots.push(body.value);
        else { const group = indexed.get(String(row.migration_id)) || []; group.push({ index: body.index, value: body.value }); indexed.set(String(row.migration_id), group); }
      }
      for (const group of indexed.values()) snapshots.push(group.sort((a, b) => a.index - b.index).map(item => item.value));
      return { snapshots };
    }
    case 'task.list': return { runtimeEpoch: storage.writerEpoch, items: storage.db.prepare('SELECT record_json FROM tasks WHERE principal_id=? ORDER BY rowid DESC').all(principal)
      .map(row => ({ ...JSON.parse(String(row.record_json)), runtimeEpoch: storage.writerEpoch })) };
    case 'task.get': return read(command.taskId, command.requestKey);
    case 'task.accept': return storage.transaction(() => {
      const incoming = command.record;
      if (!incoming.requestKey || incoming.requestKey.length > 200 || incoming.principalId !== principal || incoming.workspaceId !== storage.workspaceId)
        throw new WorkspaceError('TASK_INVALID', 'Invalid task identity', 400);
      const previous = read(undefined, incoming.requestKey);
      if (previous) {
        if (previous.requestFingerprint !== incoming.requestFingerprint) throw new WorkspaceError('TASK_KEY_CONFLICT', 'Request key was already used with different input', 409);
        return { task: previous, created: false };
      }
      checkAvailableSpace(storage.root, (incoming.kind === 'video' || incoming.kind === 'batch' ? 512 : 64) * 1024 * 1024);
      const blocked = storage.db.prepare('SELECT task_id FROM tasks WHERE upstream_settled=0 LIMIT 1').get();
      if (blocked) throw new WorkspaceError('TASK_PROVIDER_BUSY', 'Provider has unfinished work; reconcile it before submitting', 409);
      const cancel = storage.db.prepare('SELECT requested_at FROM task_cancel_intents WHERE principal_id=? AND request_key=?').get(principal, incoming.requestKey);
      const task = structuredClone(incoming);
      if (cancel) { task.cancelRequestedAt = Number(cancel.requested_at); task.status = 'cancelled'; task.upstreamSettled = true; }
      storage.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(task.taskId, principal, task.requestKey, task.provider, Number(task.upstreamSettled), JSON.stringify(task));
      for (const alias of task.inputMediaRefs) {
        const media = storage.db.prepare('SELECT hash FROM media_aliases WHERE alias=?').get(alias);
        if (!media) throw new WorkspaceError('TASK_INPUT_MISSING', 'Frozen task input media is missing');
        storage.db.prepare('INSERT OR IGNORE INTO media_refs VALUES(?,?,?)').run('task-input', task.taskId, String(media.hash));
      }
      return { task: write(task), created: true };
    });
    case 'task.patch': return storage.transaction(() => {
      const task = requireTask(command.taskId);
      if (task.revision !== command.expectedRevision) throw new WorkspaceError('REVISION_CONFLICT', 'Task revision changed');
      const patch: TaskPatch = { ...command.patch };
      const deliveryOrder = { unseen: 0, seen: 1, saved: 2, discarded: 3 };
      if (patch.deliveryState && deliveryOrder[patch.deliveryState] < deliveryOrder[task.deliveryState]) delete patch.deliveryState;
      if (patch.deliveryState === 'discarded' && task.deliveryState !== 'discarded') {
        if (!task.upstreamSettled || task.resultState !== 'available') throw new WorkspaceError('TASK_DISCARD_UNSAFE', 'Only settled available results can be discarded');
        storage.db.prepare("DELETE FROM media_refs WHERE owner_kind='task-result' AND owner_id=?").run(task.taskId);
        task.resultRefs = []; task.resultState = 'unavailable';
      }
      if (task.deliveryState === 'discarded') delete patch.deliveryState;
      if (terminal(task) && patch.status && patch.status !== task.status) delete patch.status;
      if (task.cancelRequestedAt && patch.status && !['cancelled', 'cancelling'].includes(patch.status) && !terminal(task)) patch.status = 'cancelling';
      if (task.upstreamId && patch.upstreamId && task.upstreamId !== patch.upstreamId) throw new WorkspaceError('TASK_UPSTREAM_CONFLICT', 'Upstream identity cannot be replaced');
      if (patch.metadata) patch.metadata = { ...task.metadata, ...patch.metadata };
      Object.assign(task, patch);
      return write(task);
    });
    case 'task.cancel': return storage.transaction(() => {
      storage.db.prepare('INSERT OR IGNORE INTO task_cancel_intents VALUES(?,?,?)').run(principal, command.requestKey, Date.now());
      const task = read(undefined, command.requestKey);
      if (!task || terminal(task)) return task;
      task.cancelRequestedAt ??= Date.now();
      task.status = task.submissionIntentAt ? 'cancelling' : 'cancelled';
      if (!task.submissionIntentAt) task.upstreamSettled = true;
      return write(task);
    });
    case 'task.result.prepare': return storage.transaction(() => {
      const task = requireTask(command.taskId); const media = command.media;
      if (task.deliveryState === 'discarded') throw new WorkspaceError('TASK_RESULT_DISCARDED', 'This task result was discarded');
      if (!Number.isSafeInteger(media.index) || media.index < 0 || media.alias !== `task-${task.taskId}-${media.index}` || !/^[a-f0-9]{64}$/.test(media.sha256)
        || !Number.isSafeInteger(media.bytes) || media.bytes <= 0) throw new WorkspaceError('MEDIA_INVALID', 'Invalid task result');
      const existing = storage.db.prepare('SELECT media_json,committed FROM task_outputs WHERE task_id=? AND output_index=?').get(task.taskId, media.index);
      if (existing && String(existing.media_json) !== JSON.stringify(media)) throw new WorkspaceError('TASK_RESULT_CONFLICT', 'Task output identity changed');
      if (existing?.committed === 1) return { offset: media.bytes };
      checkAvailableSpace(storage.root, media.bytes);
      storage.db.prepare('INSERT OR IGNORE INTO task_outputs VALUES(?,?,?,0)').run(task.taskId, media.index, JSON.stringify(media));
      storage.db.prepare('INSERT OR IGNORE INTO leases(id,kind,hash,created_at) VALUES(?,?,?,?)').run(outputKey(task.taskId, media.index), 'task-result', media.sha256, Date.now());
      task.resultState = 'collecting'; write(task);
      return { offset: uploadedBytes(storage.root, outputKey(task.taskId, media.index), media.alias) };
    });
    case 'task.result.chunk': {
      const media = output(command.taskId, command.index);
      return { offset: uploadMediaChunk(storage.root, outputKey(command.taskId, command.index), media, command.offset, command.data) };
    }
    case 'task.result.commit': {
      const media = output(command.taskId, command.index); const key = outputKey(command.taskId, command.index);
      publishMedia(storage.root, key, media, () => { if (options.isCancelled?.()) throw new WorkspaceError('CANCELLED', 'Task result collection interrupted', 499); });
      return storage.transaction(() => {
        const task = requireTask(command.taskId);
        if (task.deliveryState === 'discarded') return task;
        storage.db.prepare('INSERT OR IGNORE INTO media_objects VALUES(?,?,?)').run(media.sha256, media.bytes, media.mime);
        storage.db.prepare('INSERT OR IGNORE INTO media_aliases VALUES(?,?)').run(media.alias, media.sha256);
        storage.db.prepare('INSERT OR IGNORE INTO media_refs VALUES(?,?,?)').run('task-result', task.taskId, media.sha256);
        storage.db.prepare('UPDATE task_outputs SET committed=1 WHERE task_id=? AND output_index=?').run(task.taskId, media.index);
        storage.db.prepare('DELETE FROM leases WHERE id=?').run(key);
        if (!task.resultRefs.some(ref => ref.index === media.index)) task.resultRefs.push(media);
        task.resultState = 'available';
        return write(task);
      });
    }
  }
  throw new WorkspaceError('TASK_INVALID', 'Unknown task command', 400);
}
