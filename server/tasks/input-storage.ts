import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { detectedMime } from '../workspace/media';
import { WorkspaceError, type WorkspaceContext, type WorkspaceResults } from '../workspace/types';
import type { TaskCommand, TaskResults } from '../workspace/task-types';
import type { TaskWorkspace } from './runtime';

export function createTaskInputAccess(workspace: TaskWorkspace, context: WorkspaceContext, taskId: string) {
  const execute = <K extends TaskCommand['kind']>(command: Extract<TaskCommand, { kind: K }>) => workspace.request(command, context) as Promise<TaskResults[K]>;
  return {
    async protectInput(name: string, file: string) {
      const hash = createHash('sha256'); const bytes = fs.statSync(file).size;
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      const fd = await fs.promises.open(file, 'r');
      try {
        const header = Buffer.alloc(4096); const head = await fd.read(header, 0, header.length, 0);
        const mime = detectedMime(header.subarray(0, head.bytesRead));
        if (!mime?.startsWith('image/')) throw new WorkspaceError('TASK_INPUT_INVALID', 'Task input is not an image');
        const key = createHash('sha256').update(`input:${taskId}:${name}`).digest('hex');
        const media = { alias: `task-input-${key}`, sha256: hash.digest('hex'), bytes, mime };
        let { offset } = await execute({ kind: 'task.input.prepare', taskId, name, media });
        while (offset < bytes) {
          const data = Buffer.alloc(Math.min(1024 * 1024, bytes - offset)); await fd.read(data, 0, data.length, offset);
          ({ offset } = await execute({ kind: 'task.input.chunk', taskId, name, offset, data }));
        }
        await execute({ kind: 'task.input.commit', taskId, name });
      } finally { await fd.close(); }
    },
    async restoreInput(name: string, file: string) {
      const media = await execute({ kind: 'task.input.get', taskId, name });
      if (!media) return false;
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const temporary = file + '.' + randomUUID() + '.tmp'; const fd = await fs.promises.open(temporary, 'wx');
      try {
        let offset = 0;
        while (offset < media.bytes) {
          const block = await workspace.request({ kind: 'readMedia', alias: media.alias, offset }, context) as WorkspaceResults['readMedia'];
          await fd.write(block.data, 0, block.data.length, offset); offset += block.data.length;
        }
        await fd.sync(); await fd.close(); await fs.promises.rename(temporary, file); return true;
      } catch (error) { await fd.close().catch(() => {}); await fs.promises.unlink(temporary).catch(() => {}); throw error; }
    },
  };
}
