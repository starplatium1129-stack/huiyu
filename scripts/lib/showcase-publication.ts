import fs = require('node:fs');
import path = require('node:path');
import { errorMessage } from './runtime-errors';
const { object }: typeof import('./content-history-reader') = require('./content-history-reader');

function cleanMeta(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && String(item) !== ''));
}

function loadLoraVersions(root: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(root, 'data', 'loras.json'), 'utf8'));
    const list: unknown[] = Array.isArray(value) ? value : object(value) && Array.isArray(value.data) ? value.data : [];
    const versions: Record<string, string> = {};
    for (const lora of list) if (object(lora) && typeof lora.id === 'string' && lora.id && lora.version !== undefined) versions[lora.id] = String(lora.version);
    return versions;
  } catch { return {}; }
}

function readSourceManifest(value: unknown): Record<string, unknown> & { entries: (Record<string, unknown> & { id: string; type: string })[] } {
  if (!object(value) || (value.entries != null && !Array.isArray(value.entries))) throw new Error('Invalid source showcase manifest');
  const raw: unknown[] = value.entries || [];
  const entries = raw.filter(object).map(entry => {
    if (typeof entry.id !== 'string' || (entry.type != null && typeof entry.type !== 'string')) throw new Error('Invalid source showcase entry');
    return { ...entry, id: entry.id, type: entry.type || 'scene' };
  });
  return { ...value, entries };
}

function resolveDirArg(showcaseRoot: string, value: string, label: string, mustExist: boolean) {
  const raw = value || '';
  const explicitPath = path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw);
  const candidate = explicitPath ? path.resolve(raw) : path.join(path.resolve(showcaseRoot), raw);
  if (mustExist) {
    if (!fs.existsSync(candidate)) throw new Error(`${label} does not exist: ${candidate}`);
    if (!fs.existsSync(path.join(candidate, 'manifest.json'))) throw new Error(`${label} has no manifest.json: ${candidate}`);
  }
  return path.resolve(candidate);
}

function isSameOrChild(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function validateTarget(showcaseRoot: string, sourceDir: string, targetDir: string) {
  const root = path.resolve(showcaseRoot);
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  if (target === source) throw new Error(`--target must not equal --source: ${source}`);
  if (target === root) throw new Error('--target must not be the showcase root');
  if (isSameOrChild(target, source) || isSameOrChild(source, target)) {
    throw new Error(`--target must not contain or be contained by --source: source=${source}, target=${target}`);
  }
  if (isSameOrChild(target, root)) {
    if (path.dirname(target) !== root) throw new Error(`--target must be a direct child of the showcase root: ${target}`);
    return target;
  }
  if (isSameOrChild(root, target)) throw new Error(`absolute --target must not contain --source or the showcase root: ${target}`);
  return target;
}

function sourcePathFor(record: { image?: unknown; recordId?: unknown; key?: unknown }, from: string) {
  const rel = record.image || '';
  if (typeof rel !== 'string' || !rel) throw new Error(`succeeded record has no image: ${record.recordId || record.key}`);
  const label = record.recordId || record.key;
  const unsafe = path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')
    || rel.includes('\\') || rel.includes('..') || /[?#]/.test(rel) || rel.includes('%');
  if (unsafe) throw new Error(`unsafe image path for ${label}: ${JSON.stringify(rel)}`);
  const fromDir = path.resolve(path.dirname(from));
  const resolved = path.resolve(fromDir, rel.split('/').join(path.sep));
  if (resolved !== fromDir && !resolved.startsWith(fromDir + path.sep)) {
    throw new Error(`image path escapes the candidate directory for ${label}: ${JSON.stringify(rel)}`);
  }
  return resolved;
}

/** Publish a prepared showcase directory, retaining the previous version until replacement succeeds. */
function switchTarget(tempDir: string, targetDir: string, force: boolean): void {
  const backupDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.backup-${process.pid}`);
  const targetExists = fs.existsSync(targetDir);
  if (targetExists) {
    if (!force) throw new Error(`target already exists: ${targetDir} (use --force to overwrite)`);
    if (!fs.existsSync(path.join(targetDir, 'manifest.json'))) throw new Error(`refusing to replace target without manifest.json: ${targetDir}`);
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.renameSync(targetDir, backupDir);
  }
  try {
    fs.renameSync(tempDir, targetDir);
  } catch (error) {
    if (targetExists) {
      try { fs.renameSync(backupDir, targetDir); } catch (restoreError) {
        (error as Error).message = `${errorMessage(error)}\n  additionally failed to restore backup ${backupDir}: ${errorMessage(restoreError)}`;
      }
    }
    throw error;
  }
  if (targetExists) fs.rmSync(backupDir, { recursive: true, force: true });
}

export = { switchTarget, cleanMeta, loadLoraVersions, readSourceManifest, resolveDirArg, validateTarget, sourcePathFor };
