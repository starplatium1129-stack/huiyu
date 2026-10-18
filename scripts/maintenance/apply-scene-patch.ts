import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * Apply explicit scene/blueprint patches to canonical shards, never just aggregates.
 * Default: dry-run. --apply writes with a backup and rolls back on validation failure.
 * A missing/invalid pinned baseline or a protected-field edit rejects the whole plan.
 */
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const zlib: typeof import('node:zlib') = require('node:zlib');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { expectedDataVersion }: typeof import('../lib/data-version') = require('../lib/data-version');

const ROOT = path.resolve(process.env.AICS_DATA_ROOT || process.env.AICS_APP_ROOT || path.join(__dirname, '../..'));
const PROTECTED_SCENE_FIELDS = Object.freeze(['prompt', 'negative', 'animaCaption', 'recommendedSize', 'rating', 'mature']);
const FORBIDDEN_KEYS = new Set(['id', '__proto__', 'prototype', 'constructor']);

type PatchEntry = { type: 'scene' | 'blueprint'; id: string; changes: Record<string, unknown> };
type SourceRecord = Record<string, unknown> & { id: string };
type SourceInput = { file: string; type: PatchEntry['type']; data: unknown };
type SourceDocument = { file: string; type: 'scene'; data: SourceRecord[] }
  | { file: string; type: 'blueprint'; data: Record<string, unknown> & { blueprints: SourceRecord[] } };
type PinnedScenes = Record<string, Record<string, unknown>>;
type PatchResult = Pick<PatchEntry, 'id' | 'type'> & { diff: Record<string, { from: unknown; to: unknown }> };
type PatchPlan = { results: PatchResult[]; writes: SourceDocument[] };
type Snapshot = { file: string; exists: true; content: Buffer } | { file: string; exists: false; content: null };
type PatchOutcome = { applied: boolean; outcome: 'planned' | 'dry-run' | 'unchanged' | 'validated' | 'rollback-failed' | 'rolled-back' | 'failed-before-write';
  version?: number; backup?: string; rollbackAttempted?: boolean; restored?: boolean };
type CommitOptions = { root: string; derivedFiles: string[]; rebuild: () => number; validate: () => void };
type ChangeSetInput = { sources: SourceInput[]; entries: PatchEntry[]; pinned: PinnedScenes; derivedFiles: string[]; apply: boolean; outcome: PatchOutcome };
class PatchCommitError extends Error {
  constructor(message: string, readonly patchOutcome: PatchOutcome) { super(message); }
}

function readJson(file: string): unknown { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function jsonText(value: unknown) { return JSON.stringify(value, null, 2) + '\n'; }

// Resolve existing parents as well as aliases of existing files before any report write.
function canonicalPath(file: string): string {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
}
function validateOutput(output: string, reserved: string[], root: string) {
  const key = (file: string) => { const value = canonicalPath(file); return process.platform === 'win32' ? value.toLowerCase() : value; };
  const target = key(output);
  const data = key(path.join(root, 'data'));
  if (target === data || target.startsWith(data + path.sep) || reserved.flatMap(file => [file, file + '.gz', file + '.br']).some(file => key(file) === target)) {
    throw new Error('--out 不得覆盖输入、数据源、产物、版本常量或定稿基线（含压缩文件和路径别名）');
  }
}
function changeSetReport(plan: PatchPlan, { sources, entries, pinned, derivedFiles, apply, outcome }: ChangeSetInput) {
  validatePatch(entries);
  if (!Array.isArray(sources) || sources.some(doc => !object(doc) || typeof doc.file !== 'string') || !Array.isArray(derivedFiles) || derivedFiles.some(file => typeof file !== 'string') || !object(pinned) || !Object.keys(pinned).length || typeof apply !== 'boolean' || !object(outcome) || typeof outcome.applied !== 'boolean') throw new Error('变更集证据缺少必要字段');
  const expected = planPatches(sources, entries, pinned);
  if (JSON.stringify(expected) !== JSON.stringify(plan)) throw new Error('变更集计划与输入不一致');
  return { schema: 'ai-cg-studio.scene-patch-report', schemaVersion: 1, patchSchema: { type: 'array', version: 1 },
    sourceFiles: sources.map(doc => doc.file), changedRecords: plan.results.filter(item => Object.keys(item.diff).length),
    protectedFieldDecision: { status: 'allowed', fields: PROTECTED_SCENE_FIELDS, pinnedIds: entries.filter(item => item.type === 'scene' && Object.hasOwn(pinned, item.id)).map(item => item.id) },
    derivedOutputs: derivedFiles, writeStatus: outcome.applied ? 'validated' : outcome.outcome,
    applyStatus: { requested: apply, applied: outcome.applied },
    rollbackCapability: { supported: true, scope: 'planned sources, declared derived outputs and .gz/.br siblings', backup: outcome.backup || null, exercised: Boolean(outcome.rollbackAttempted), restored: outcome.restored ?? null } };
}

function writeTextAtomic(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* No temporary file after successful rename. */ }
    throw error;
  }
}

function loadPinnedScenes(file = path.join(ROOT, 'data/prompt-pinned-scenes.json')): PinnedScenes {
  let data;
  try { data = readJson(file); } catch (error) {
    throw new Error(`定稿保护基线不可读取，拒绝应用补丁: ${runtimeErrorMessage(error)}`);
  }
  if (!object(data) || !object(data.scenes) || !Object.keys(data.scenes).length ||
      Object.values(data.scenes).some(value => !object(value))) {
    throw new Error('定稿保护基线结构无效，拒绝应用补丁');
  }
  return data.scenes as PinnedScenes;
}

function validatePatch(entries: unknown): PatchEntry[] {
  if (!Array.isArray(entries)) throw new Error('补丁文件根节点必须是数组');
  const seen = new Set<string>();
  const records: unknown[] = entries;
  for (const entry of records) {
    if (!object(entry) || (entry.type !== 'scene' && entry.type !== 'blueprint') ||
        typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(entry.id) || !object(entry.changes)) {
      throw new Error('每条补丁必须有合法 type、id 和 changes 对象');
    }
    const key = `${entry.type}:${entry.id}`;
    if (seen.has(key)) throw new Error(`重复补丁: ${key}`);
    seen.add(key);
    if (Object.keys(entry.changes).some(key => FORBIDDEN_KEYS.has(key))) {
      throw new Error(`${key}: 不允许修改记录 ID 或原型字段`);
    }
  }
  return records as PatchEntry[];
}

/** Build an immutable write plan from full canonical source documents. */
function planPatches(sources: SourceInput[], entries: PatchEntry[], pinned: PinnedScenes): PatchPlan {
  validatePatch(entries);
  if (!object(pinned) || !Object.keys(pinned).length) throw new Error('缺少有效定稿保护基线');
  const documents = sources.map((source): SourceDocument => {
    const data: unknown = JSON.parse(JSON.stringify(source.data));
    const records: unknown = source.type === 'scene' ? data : object(data) ? data.blueprints : undefined;
    if (!Array.isArray(records) || !records.every((record: unknown) => object(record) && typeof record.id === 'string')) {
      throw new Error(`分片结构无效: ${source.file}`);
    }
    return { ...source, data } as SourceDocument;
  });
  const byKey = new Map<string, { doc: SourceDocument; record: SourceRecord }>();
  for (const doc of documents) {
    const records = doc.type === 'scene' ? doc.data : doc.data.blueprints;
    for (const record of records) {
      const key = `${doc.type}:${record.id}`;
      if (byKey.has(key)) throw new Error(`源记录 ID 重复: ${key}`);
      byKey.set(key, { doc, record });
    }
  }
  // Preflight the entire plan before changing even its private copies.
  for (const entry of entries) {
    const key = `${entry.type}:${entry.id}`;
    if (!byKey.has(key)) throw new Error(`记录不存在: ${key}`);
    if (entry.type === 'scene' && Object.hasOwn(pinned, entry.id)) {
      const fields = Object.keys(entry.changes).filter(field => PROTECTED_SCENE_FIELDS.includes(field));
      if (fields.length) throw new Error(`定稿场景 ${entry.id} 的受保护字段禁止批量修改: ${fields.join(', ')}`);
    }
  }
  const changedFiles = new Set<string>();
  const results: PatchResult[] = [];
  for (const entry of entries) {
    // All keys were checked in the complete preflight above.
    const { doc, record } = byKey.get(`${entry.type}:${entry.id}`)!;
    const diff: PatchResult['diff'] = {};
    for (const [field, to] of Object.entries(entry.changes)) {
      const from = record[field];
      if (JSON.stringify(from) === JSON.stringify(to)) continue;
      diff[field] = { from, to };
      record[field] = to;
    }
    if (Object.keys(diff).length) changedFiles.add(doc.file);
    results.push({ id: entry.id, type: entry.type, diff });
  }
  return { results, writes: documents.filter(doc => changedFiles.has(doc.file)) };
}

function snapshotFiles(files: string[]): Snapshot[] {
  return [...new Set(files)].map(file => fs.existsSync(file)
    ? { file, exists: true, content: fs.readFileSync(file) }
    : { file, exists: false, content: null });
}

function restoreSnapshot(snapshot: Snapshot[]) {
  for (const item of snapshot) {
    if (item.exists) writeTextAtomic(item.file, item.content);
    else if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
  }
}

function saveBackup(snapshot: Snapshot[], root: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const target = path.join(root, 'runtime/maintenance-backups', stamp + '-scene-patch');
  fs.mkdirSync(path.join(target, 'files'), { recursive: true });
  const files = snapshot.map((item, index) => {
    const backup = item.exists ? `${String(index).padStart(3, '0')}-${path.basename(item.file)}` : '';
    if (item.exists) fs.writeFileSync(path.join(target, 'files', backup), item.content);
    return { source: path.relative(root, item.file), existed: item.exists, backup };
  });
  fs.writeFileSync(path.join(target, 'manifest.json'), jsonText({ createdAt: new Date().toISOString(), files }));
  return target;
}

/** Refresh only existing compressed siblings; missing compressed files remain optional. */
function refreshCompression(files: string[]) {
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file);
    if (fs.existsSync(file + '.gz')) writeTextAtomic(file + '.gz', zlib.gzipSync(raw));
    if (fs.existsSync(file + '.br')) writeTextAtomic(file + '.br', zlib.brotliCompressSync(raw));
  }
}

/** Rebuild derived data and validate it inside the same rollback boundary. */
function commitPlan(plan: PatchPlan, options: CommitOptions): PatchOutcome {
  if (!plan.writes.length) return { applied: false, outcome: 'unchanged' };
  const rawFiles = [...new Set([...plan.writes.map(doc => doc.file), ...options.derivedFiles])];
  const snapshot = snapshotFiles(rawFiles.flatMap(file => [file, file + '.gz', file + '.br']));
  const backup = saveBackup(snapshot, options.root);
  try {
    for (const doc of plan.writes) writeTextAtomic(doc.file, jsonText(doc.data));
    const version = options.rebuild();
    refreshCompression(rawFiles.filter(file => file.endsWith('.json')));
    options.validate();
    return { applied: true, outcome: 'validated', version, backup };
  } catch (error) {
    try { restoreSnapshot(snapshot); } catch (rollbackError) {
      throw new PatchCommitError(`补丁失败且自动回滚失败；备份 ${backup}: ${runtimeErrorMessage(error)}; ${runtimeErrorMessage(rollbackError)}`, { applied: false, outcome: 'rollback-failed', backup, rollbackAttempted: true, restored: false });
    }
    throw new PatchCommitError(`补丁写入/校验失败，已回滚；备份 ${backup}: ${runtimeErrorMessage(error)}`, { applied: false, outcome: 'rolled-back', backup, rollbackAttempted: true, restored: true });
  }
}

function parseArgs(argv: string[]) {
  const args: { patch: string | null; apply: boolean; out: string | null; help: boolean } = { patch: null, apply: false, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--dry-run') args.apply = false;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--patch' || argv[i] === '--out') {
      const key = argv[i] === '--patch' ? 'patch' : 'out';
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`缺少 ${argv[i]} 参数`);
      args[key] = argv[++i];
    } else throw new Error(`未知参数: ${argv[i]}`);
  }
  return args;
}

function runValidation(script: string) {
  const result = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} 校验失败:\n${(result.stderr + '\n' + result.stdout).trim().slice(-2000)}`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法: node scripts/maintenance/apply-scene-patch.js --patch <patch.json> [--apply] [--out <report.json>]');
    console.log('旧格式资料专用，默认 dry-run；已迁移项目请用 npm run wf -- content:catalog patch/import --runtime-root <实际运行目录>。');
    console.log('--apply 仅写未迁移旧分片并重建，定稿保护或校验失败拒绝/回滚；旧格式修复能力保留至对应升级来源退役。');
    return;
  }
  (require('../lib/catalog-snapshot') as typeof import('../lib/catalog-snapshot')).assertLegacyWrite(ROOT);
  if (!args.patch) throw new Error('缺少 --patch <patch.json>');
  const entries = validatePatch(readJson(args.patch));
  const pinned = loadPinnedScenes();
  const sceneStore: typeof import('../lib/scene-store') = require('../lib/scene-store');
  const blueprintStore: typeof import('../lib/blueprint-store') = require('../lib/blueprint-store');
  const sceneSources = sceneStore.loadSceneShards().sources;
  const blueprintSources = blueprintStore.loadBlueprintShards().sources;
  const sources: SourceInput[] = [
    ...sceneSources.map(source => ({ file: source.source, type: 'scene' as const, data: readJson(source.source) })),
    ...blueprintSources.map(source => ({ file: source.source, type: 'blueprint' as const, data: readJson(source.source) })),
  ];
  const plan = planPatches(sources, entries, pinned);
  const storeFile = path.join(ROOT, 'src/stores/sceneStore.ts');
  const derivedFiles = [
    sceneStore.aggregatePath, ...Object.values(sceneStore.browserShardPath), sceneStore.corePath,
    sceneStore.indexPath, blueprintStore.aggregatePath, storeFile,
  ];
  if (args.out) {
    const output = path.resolve(args.out);
    const reserved = [...sources.map(source => source.file), ...derivedFiles, path.resolve(args.patch), path.join(ROOT, 'data/prompt-pinned-scenes.json')];
    validateOutput(output, reserved, ROOT);
  }
  const changed = plan.results.filter(item => Object.keys(item.diff).length);
  console.log(`[apply-scene-patch] 补丁 ${entries.length} 条 | 实际变更 ${changed.length} | 源分片 ${plan.writes.length}`);
  for (const item of changed) console.log(JSON.stringify(item));
  let outcome: PatchOutcome = { applied: false, outcome: args.apply ? 'planned' : 'dry-run' };
  const report = () => ({ createdAt: new Date().toISOString(), dryRun: !args.apply, entries: entries.length, changed: changed.length, results: plan.results, ...outcome,
    ...changeSetReport(plan, { sources, entries, pinned, derivedFiles, apply: args.apply, outcome }) });
  if (args.out) writeTextAtomic(path.resolve(args.out), jsonText(report()));
  if (args.apply) {
    try {
    outcome = commitPlan(plan, {
      root: ROOT, derivedFiles,
      rebuild() {
        if (plan.writes.some(doc => doc.type === 'scene')) sceneStore.writeAggregate(sceneStore.loadSceneShards().scenes);
        if (plan.writes.some(doc => doc.type === 'blueprint')) blueprintStore.writeBlueprintAggregate();
        return expectedDataVersion(ROOT);
      },
      validate() {
        runValidation('scripts/maintenance/validate-scenes.js');
        runValidation('scripts/maintenance/validate-content-contracts.js');
        const pinnedRun = spawnSync(process.execPath, ['scripts/maintenance/pin-scene-prompts.js', '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
        if (pinnedRun.error || pinnedRun.status !== 0) throw new Error('定稿校验失败: ' + (pinnedRun.error?.message || pinnedRun.stdout || pinnedRun.stderr));
      },
    });
    } catch (error) {
      outcome = error instanceof PatchCommitError ? error.patchOutcome : { applied: false, outcome: 'failed-before-write' };
      if (args.out) writeTextAtomic(path.resolve(args.out), jsonText(report()));
      throw error;
    }
  }
  if (args.out) writeTextAtomic(path.resolve(args.out), jsonText(report()));
  console.log(`[apply-scene-patch] ${outcome.outcome}${outcome.backup ? '，备份 ' + path.basename(outcome.backup) : ''}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('[apply-scene-patch] ' + runtimeErrorMessage(error)); process.exitCode = 1; }
}
