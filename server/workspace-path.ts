'use strict';

type FsError = NodeJS.ErrnoException;
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');

function isPathInsideWorkspace(root: string, candidate: string) {
  let relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

/** Resolve links in existing ancestors, including parents of files about to be created. */
function physicalPath(candidate: string): string {
  let current = path.resolve(candidate);
  let suffix = [];
  while (true) {
    try { fs.lstatSync(current); break; }
    catch (error) {
      let fsError = error as FsError;
      if (fsError.code !== 'ENOENT') throw error;
      let parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
  // A dangling link is an error, not an absent directory that may be created.
  return path.join(fs.realpathSync(current), ...suffix);
}

function resolveWorkspacePath(workspaceRoot: string, relative: string): string {
  let root = path.resolve(workspaceRoot);
  let clean = String(relative || '').trim().replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) throw new Error('只接受工作区内的相对路径');
  if (clean.split('/').some(function (part) { return part === '..'; })) throw new Error('路径不能包含 ..');
  if (clean.includes('\0') || (process.platform === 'win32' && clean.includes(':'))) throw new Error('路径包含无效字符');
  let resolved = path.resolve(root, clean || '.');
  if (!isPathInsideWorkspace(root, resolved)) throw new Error('路径超出 AI 工作区范围');
  let physicalRoot = physicalPath(root);
  let physical = physicalPath(resolved);
  if (!isPathInsideWorkspace(physicalRoot, physical)) throw new Error('路径链接指向 AI 工作区外，已拒绝访问');
  return physical;
}

export = { isPathInsideWorkspace: isPathInsideWorkspace, resolveWorkspacePath: resolveWorkspacePath };
