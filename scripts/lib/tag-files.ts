import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Validate every existing component before opening any source or output. */
export function checkTagPath(root: string, file: string, allowMissing = false): void {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Tag path escapes root: ${file}`);
  const parts = relative.split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Tag path contains a symbolic link: ${current}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Tag path parent is not a directory: ${current}`);
    if (index === parts.length - 1 && !stat.isFile()) throw new Error(`Tag path is not a regular file: ${current}`);
  }
}

/** Stage all outputs before publication; roll back completed replacements on a
 * synchronous failure. Not a cross-process transaction or power-loss guarantee.
 */
export function writeTagFiles(root: string, files: Array<{ path: string; content: string | null }>): void {
  const paths = files.map(file => process.platform === 'win32' ? path.resolve(file.path).toLowerCase() : path.resolve(file.path));
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate tag output path');
  const states = files.map(file => {
    checkTagPath(root, file.path, true);
    return { ...file, before: fs.existsSync(file.path) ? fs.readFileSync(file.path) : null,
      temporary: `${file.path}.${randomUUID()}.tmp` };
  });
  const completed: typeof states = [];
  try {
    for (const file of states) if (file.content !== null) fs.writeFileSync(file.temporary, file.content, { encoding: 'utf8', flag: 'wx' });
    for (const file of states) {
      checkTagPath(root, file.path, true);
      if (file.content !== null) fs.renameSync(file.temporary, file.path);
      else if (file.before !== null) fs.unlinkSync(file.path);
      else continue;
      completed.push(file);
    }
  } catch (error) {
    const failures: unknown[] = [error];
    for (const file of completed.reverse()) {
      try {
        checkTagPath(root, file.path, true);
        if (file.before === null) fs.unlinkSync(file.path);
        else {
          fs.writeFileSync(file.temporary, file.before, { flag: 'wx' });
          fs.renameSync(file.temporary, file.path);
        }
      } catch (rollback) { failures.push(rollback); }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Tag publication failed; rollback is incomplete');
    throw error;
  } finally {
    for (const file of states) {
      try { fs.unlinkSync(file.temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Tag staging cleanup failed', file.temporary);
      }
    }
  }
}
