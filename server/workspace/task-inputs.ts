import { checkAvailableSpace, digest, publishMedia, uploadedBytes, uploadMediaChunk } from './media';
import { nextRevision, type WorkspaceStorageContext } from './schema';
import { WorkspaceError, type MediaInput } from './types';
import type { TaskInputCommand } from './task-types';
import type { TaskRecord } from '../../types/tasks';
export function executeTaskInput(storage: WorkspaceStorageContext, principal: string, command: TaskInputCommand) {
  const row = storage.db.prepare('SELECT record_json FROM tasks WHERE task_id=? AND principal_id=?').get(command.taskId, principal);
  if (!row) throw new WorkspaceError('TASK_NOT_FOUND', 'Task does not exist', 404);
  if (!/^[\w.-]{1,220}$/.test(command.name)) throw new WorkspaceError('TASK_INPUT_INVALID', 'Invalid protected input name');
  const key = digest(`input:${command.taskId}:${command.name}`);
  const existing = storage.db.prepare('SELECT media_json,committed FROM task_inputs WHERE task_id=? AND name=?').get(command.taskId, command.name);
  const stored = existing ? JSON.parse(String(existing.media_json)) as MediaInput : null;
  if (command.kind === 'task.input.get') return existing?.committed === 1 ? stored : null;
  if (command.kind === 'task.input.prepare') return storage.transaction(() => {
    const media = command.media;
    if (media.alias !== `task-input-${key}` || !/^[a-f0-9]{64}$/.test(media.sha256) || !Number.isSafeInteger(media.bytes) || media.bytes < 1)
      throw new WorkspaceError('TASK_INPUT_INVALID', 'Invalid protected input media');
    if (stored && JSON.stringify(stored) !== JSON.stringify(media)) throw new WorkspaceError('TASK_INPUT_CHANGED', 'Frozen task input changed');
    if (existing?.committed === 1) return { offset: media.bytes };
    checkAvailableSpace(storage.root, media.bytes);
    storage.db.prepare('INSERT OR IGNORE INTO task_inputs VALUES(?,?,?,0)').run(command.taskId, command.name, JSON.stringify(media));
    storage.db.prepare('INSERT OR IGNORE INTO leases(id,kind,hash,created_at) VALUES(?,?,?,?)').run(key, 'task-input', media.sha256, Date.now());
    return { offset: uploadedBytes(storage.root, key, media.alias) };
  });
  if (!stored) throw new WorkspaceError('TASK_INPUT_MISSING', 'Protected task input is missing');
  if (command.kind === 'task.input.chunk') return { offset: uploadMediaChunk(storage.root, key, stored, command.offset, command.data) };
  publishMedia(storage.root, key, stored);
  return storage.transaction(() => {
    storage.db.prepare('INSERT OR IGNORE INTO media_objects VALUES(?,?,?)').run(stored.sha256, stored.bytes, stored.mime);
    storage.db.prepare('INSERT OR IGNORE INTO media_aliases VALUES(?,?)').run(stored.alias, stored.sha256);
    storage.db.prepare('INSERT OR IGNORE INTO media_refs VALUES(?,?,?)').run('task-input', command.taskId, stored.sha256);
    storage.db.prepare('UPDATE task_inputs SET committed=1 WHERE task_id=? AND name=?').run(command.taskId, command.name);
    storage.db.prepare('DELETE FROM leases WHERE id=?').run(key);
    const current = storage.db.prepare('SELECT record_json FROM tasks WHERE task_id=?').get(command.taskId)!;
    const task = JSON.parse(String(current.record_json)) as TaskRecord;
    if (!task.inputMediaRefs.includes(stored.alias)) task.inputMediaRefs.push(stored.alias);
    task.revision = nextRevision(storage); task.updatedAt = Date.now();
    storage.db.prepare('UPDATE tasks SET record_json=? WHERE task_id=?').run(JSON.stringify(task), task.taskId);
    return stored;
  });
}
