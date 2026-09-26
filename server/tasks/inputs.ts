import fs from 'node:fs';
import path from 'node:path';
import type { TaskExecutionHooks } from './provider';
import type { GenerationConfig } from '../generation/types';
import { WorkspaceError } from '../workspace/types';
import media = require('../../routes/anima/media');

function names(value: Record<string, unknown>): string[] {
  const found = [value.initImage, value.maskImage, value.image, value.lastFrame, value.tailFrame,
    ...(Array.isArray(value.references) ? value.references : [])].filter((name): name is string => typeof name === 'string' && Boolean(name));
  if (Array.isArray(value.shots)) for (const raw of value.shots) {
    const shot = raw as Record<string, unknown>;
    found.push(...names(shot), ...names(shot.input && typeof shot.input === 'object' ? shot.input as Record<string, unknown> : {}));
  }
  return [...new Set(found)];
}
/** Upload/derived filenames remain provider-local; authoritative bytes live in workspace. */
export function providerInputs(config: GenerationConfig, hooks: Pick<TaskExecutionHooks, 'protectInput' | 'restoreInput'>) {
  const protectedNames = new Set<string>();
  const root = path.resolve(media.imageInputRoot(config));
  async function protect(value: Record<string, unknown>) {
    for (const name of names(value)) {
      if (protectedNames.has(name)) continue;
      if (!/^[\w.-]{1,220}$/.test(name)) throw new WorkspaceError('TASK_INPUT_INVALID', 'Invalid input filename');
      const file = path.join(root, name);
      if (!fs.existsSync(file) && !await hooks.restoreInput?.(name, file)) throw new WorkspaceError('TASK_INPUT_MISSING', 'Task input cannot be restored');
      if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new WorkspaceError('TASK_INPUT_INVALID', 'Input escaped the approved provider directory');
      await hooks.protectInput?.(name, file); protectedNames.add(name);
    }
  }
  return protect;
}
export function protectedInputHooks(config: GenerationConfig, hooks: TaskExecutionHooks) {
  const protect = providerInputs(config, hooks);
  return { protect, hooks: { ...hooks, async checkpoint(value: Record<string, unknown>) { await protect(value); await hooks.checkpoint(value); } } };
}
