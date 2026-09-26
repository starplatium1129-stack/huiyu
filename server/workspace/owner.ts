import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { assertSafePath, syncDirectory } from './paths';
import { WorkspaceError } from './types';

export interface WorkspaceOwner {
  workspaceId: string;
  nonce: string;
  pid: number;
  startedAt: number;
}
const OWNER_FILE = '.workspace-owner.json';

export function readWorkspaceOwner(root: string): WorkspaceOwner {
  const file = assertSafePath(root, OWNER_FILE);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 4096) throw new WorkspaceError('WORKSPACE_LOCK_INVALID', 'Workspace owner record is invalid');
  const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WorkspaceOwner>;
  if (typeof owner.workspaceId !== 'string' || typeof owner.nonce !== 'string'
    || !Number.isSafeInteger(owner.pid) || !Number.isFinite(owner.startedAt)) {
    throw new WorkspaceError('WORKSPACE_LOCK_INVALID', 'Workspace owner record is invalid');
  }
  return owner as WorkspaceOwner;
}

function removeOwner(root: string, expected: WorkspaceOwner): void {
  const current = readWorkspaceOwner(root);
  if (current.workspaceId !== expected.workspaceId || current.nonce !== expected.nonce
    || current.pid !== expected.pid || current.startedAt !== expected.startedAt) {
    throw new WorkspaceError('WORKSPACE_LOCK_CHANGED', 'Workspace ownership changed; lock retained');
  }
  fs.unlinkSync(assertSafePath(root, OWNER_FILE));
  syncDirectory(root);
}

export function acquireWorkspaceOwner(root: string, workspaceId: string, create: boolean) {
  if (!path.isAbsolute(root) || root === path.parse(root).root || /^[/\\]{2}/.test(root)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(workspaceId)) {
    throw new WorkspaceError('WORKSPACE_IDENTITY', 'A named workspace on an explicit local directory is required');
  }
  assertSafePath(root);
  if (!fs.existsSync(root)) {
    if (!create) throw new WorkspaceError('WORKSPACE_IDENTITY', 'Workspace directory is unavailable');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  if (!fs.statSync(root).isDirectory()) throw new WorkspaceError('WORKSPACE_IDENTITY', 'Workspace root is not a directory');
  const owner: WorkspaceOwner = { workspaceId, nonce: randomUUID(), pid: process.pid, startedAt: performance.timeOrigin };
  let fd: number;
  try { fd = fs.openSync(assertSafePath(root, OWNER_FILE), 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkspaceError('WORKSPACE_LOCKED', 'Workspace already has an owner; unknown or exited owners require host recovery', 423);
    }
    throw error;
  }
  try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(root);
  return { owner: Object.freeze(owner), release: () => removeOwner(root, owner) };
}

/** Only a host retaining the actual exited child handle may reclaim its matching lease. */
export function releaseExitedWorkspaceOwner(root: string, expected: WorkspaceOwner, child: ChildProcess): void {
  if (!(child instanceof ChildProcess) || child.pid !== expected.pid
    || (child.exitCode === null && child.signalCode === null)) {
    throw new WorkspaceError('WORKSPACE_OWNER_UNCONFIRMED', 'The host has not confirmed this owner process exited');
  }
  removeOwner(root, expected);
}
