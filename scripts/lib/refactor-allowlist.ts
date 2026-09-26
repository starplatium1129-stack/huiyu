import { execFileSync } from 'node:child_process';
import type { RefactorAllowance } from './refactor-boundaries';

export interface RefactorSeed { baseCommit: string; entries: RefactorAllowance[] }
export const REFACTOR_ALLOWLIST_PATH = 'scripts/tests/refactor-boundary-allowlist.json';

/** Missing Git history is an error. Only pre-R0 ancestors may use the sealed initial seed. */
export function readRefactorAllowancesAtRef(root: string, ref: string, seed: RefactorSeed): RefactorAllowance[] {
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const sha = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  const exists = git(['ls-tree', '--name-only', sha, '--', REFACTOR_ALLOWLIST_PATH]);
  if (exists) {
    const parsed: unknown = JSON.parse(git(['show', `${sha}:${REFACTOR_ALLOWLIST_PATH}`]));
    if (!Array.isArray(parsed)) throw new Error(`${ref}: refactor allowlist must be an array`);
    return parsed as RefactorAllowance[];
  }
  try { git(['merge-base', '--is-ancestor', sha, seed.baseCommit]); } catch {
    throw new Error(`${ref}: missing refactor allowlist after R0; cannot reset retired allowances`);
  }
  return seed.entries;
}

export function refactorAllowanceRefs(requestedBase: string | undefined): string[] {
  // Reuse the existing Quality PR/push base; no new CI configuration is required.
  const base = requestedBase?.trim();
  return [...new Set(['HEAD', base && !/^0+$/.test(base) ? base : 'HEAD^'])];
}
