import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './types';

/** All storage paths are host-owned. Refuse junctions/symlinks before opening any file. */
export function assertSafePath(root: string, relative = ''): string {
  const resolved = path.resolve(root);
  const target = path.resolve(resolved, relative);
  if (target !== resolved && !target.startsWith(resolved + path.sep)) {
    throw new WorkspaceError('MEDIA_INVALID', 'Workspace path escapes its root');
  }
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new WorkspaceError('MEDIA_INVALID', 'Workspace symlinks are not supported');
  }
  return target;
}

export function syncDirectory(directory: string): void {
  // Windows does not support fsync on directory handles through Node. File fsync and
  // same-volume immutable publication are retained; power-loss repair needs backups.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
