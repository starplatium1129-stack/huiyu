import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafePath, syncDirectory } from './paths';
import { WorkspaceError } from './types';

export type WorkspaceDomain = 'artwork' | 'settings' | 'chat' | 'draft';
export interface WorkspacePointer {
  formatVersion: 1;
  workspaceId: string;
  generation: number;
  domains: WorkspaceDomain[];
  activatedRevision: number;
  migrationId: string | null;
  backupId: string | null;
  restoreCandidateId: string | null;
  bundledUi: boolean;
}
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function workspaceRoot(configRoot: string, workspaceId: string): string {
  if (!path.isAbsolute(configRoot) || !idPattern.test(workspaceId)) throw new WorkspaceError('WORKSPACE_IDENTITY', 'Invalid host workspace identity');
  return assertSafePath(configRoot, `workspaces/${workspaceId}`);
}
export function readWorkspacePointer(configRoot: string, candidate = false): WorkspacePointer | null {
  const file = assertSafePath(configRoot, candidate ? 'workspace-candidate.json' : 'workspace-active.json');
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WorkspacePointer>;
  if (value.formatVersion !== 1 || typeof value.workspaceId !== 'string' || !idPattern.test(value.workspaceId)
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
    || !Number.isSafeInteger(value.activatedRevision) || Number(value.activatedRevision) < 0
    || !Array.isArray(value.domains) || value.domains.some(domain => !['artwork', 'settings', 'chat', 'draft'].includes(domain))
    || typeof value.bundledUi !== 'boolean'
    || (value.bundledUi && !['artwork', 'settings', 'chat', 'draft'].every(domain => value.domains?.includes(domain as WorkspaceDomain)))) {
    throw new WorkspaceError('WORKSPACE_IDENTITY', 'Invalid active workspace pointer; repair is required');
  }
  return value as WorkspacePointer;
}
export function writeWorkspacePointer(configRoot: string, pointer: WorkspacePointer, candidate = false): void {
  const name = candidate ? 'workspace-candidate.json' : 'workspace-active.json';
  const temporary = assertSafePath(configRoot, `${name}.${randomUUID()}.pending`);
  fs.mkdirSync(configRoot, { recursive: true });
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(pointer)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, assertSafePath(configRoot, name));
  syncDirectory(configRoot);
}

/** Code rollback never redirects a library with new writes to its legacy source. */
export function classifyWorkspaceRollback(pointer: WorkspacePointer | null, currentRevision: number) {
  if (!pointer) return 'before-activation' as const;
  return currentRevision === pointer.activatedRevision ? 'activated-without-writes' as const : 'restore-required' as const;
}
