import type { Request } from 'express';
import type { MigrationEnvelope, MigrationRecord } from '../types/migration';
import type { WorkspaceCommand } from '../server/workspace/types';
import { WorkspaceError } from '../server/workspace/types';

/** Concrete profile/migration resources; command names supplied by the client are never executed. */
export function profileWorkspaceCommand(req: Request, input: Record<string, unknown>): WorkspaceCommand | null {
  const id = () => String(input.operationId || '');
  const migrationId = decodeURIComponent(req.path.split('/')[2] || '');
  const itemId = decodeURIComponent(req.path.split('/')[4] || '');
  const chunk = () => {
    if (typeof input.data !== 'string') throw new WorkspaceError('INVALID_REQUEST', 'Missing media chunk', 400);
    const data = Buffer.from(input.data, 'base64');
    if (!data.length || data.length > 1024 * 1024 || data.toString('base64') !== input.data) throw new WorkspaceError('INVALID_REQUEST', 'Invalid chunk', 400);
    return data;
  };
  const revision = () => {
    if (input.expectedRevision === null) return null;
    if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) throw new WorkspaceError('INVALID_REQUEST', 'Invalid revision', 400);
    return Number(input.expectedRevision);
  };
  if (req.method === 'GET') {
    if (req.path === '/profile/settings') return { kind: 'profile.readSettings' };
    if (req.path === '/profile/chat') return { kind: 'profile.readChat' };
    if (req.path === '/profile/drafts') return { kind: 'profile.readDrafts', windowId: String(req.query.windowId || '') };
    if (/^\/migrations\/[^/]+$/.test(req.path)) return { kind: 'migration.status', migrationId };
  }
  if (req.method === 'POST') {
    if (req.path === '/migrations') return { kind: 'migration.begin', operationId: id(), envelope: input.envelope as MigrationEnvelope };
    if (/^\/migrations\/[^/]+\/verify$/.test(req.path)) return { kind: 'migration.verify', operationId: id(), migrationId };
    if (/^\/migrations\/[^/]+\/records\/[^/]+$/.test(req.path)) return { kind: 'migration.record', operationId: id(), migrationId, itemId, record: input.record as MigrationRecord };
    if (req.path === '/profile/chat/reset') return { kind: 'profile.resetChat', operationId: id(), expectedReset: String(input.expectedReset || '') };
  }
  if (req.method === 'PUT') {
    if (/^\/migrations\/[^/]+\/records\/[^/]+\/chunks$/.test(req.path)) return { kind: 'migration.recordChunk', operationId: id(), migrationId, itemId, offset: Number(input.offset), data: chunk() };
    if (/^\/migrations\/[^/]+\/media\/[^/]+\/chunks$/.test(req.path)) return { kind: 'migration.media', operationId: id(), migrationId, alias: itemId, offset: Number(input.offset), data: chunk() };
    const common = { operationId: id(), key: String(input.key || ''), expectedRevision: revision() };
    if (req.path === '/profile/settings') return { kind: 'profile.saveSetting', ...common, value: input.value as string | null };
    if (req.path === '/profile/chat') return { kind: 'profile.saveChatRecord', ...common, value: input.value, expectedReset: String(input.expectedReset || '') };
    if (req.path === '/profile/drafts') return { kind: 'profile.saveDraft', ...common, value: input.value as string | null, expectedReset: String(input.expectedReset || ''), ...(input.windowId ? { windowId: String(input.windowId) } : {}) };
  }
  return null;
}
