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
const { syncDataVersion }: typeof import('../lib/data-version') = require('../lib/data-version');

const ROOT = path.resolve(process.env.AICS_DATA_ROOT || process.env.AICS_APP_ROOT || path.join(__dirname, '../..'));
const PROTECTED_SCENE_FIELDS = Object.freeze(['prompt', 'negative', 'animaCaption', 'recommendedSize', 'rating', 'mature']);
const FORBIDDEN_KEYS = new Set(['id', '__proto__', 'prototype', 'constructor']);

function readJson(file: any) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function object(value: any) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function jsonText(value: any) { return JSON.stringify(value, null, 2) + '\n'; }

// Resolve existing parents as well as aliases of existing files before any report write.
function canonicalPath(file: any): any {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
}
function validateOutput(output: any, reserved: any, root: any) {
  const key = (file: any) => { const value = canonicalPath(file); return process.platform === 'win32' ? value.toLowerCase() : value; };
  const target = key(output);
  const data = key(path.join(root, 'data'));
  if (target === data || target.startsWith(data + path.sep) || reserved.flatMap((file: any) => [file, file + '.gz', file + '.br']).some((file: any) => key(file) === target)) {
    throw new Error('--out 不得覆盖输入、数据源、产物、版本常量或定稿基线（含压缩文件和路径别名）');
  }
}
function changeSetReport(plan: any, { sources, entries, pinned, derivedFiles, apply, outcome }: any) {
  validatePatch(entries);
  if (!Array.isArray(sources) || sources.some((doc: any) => !object(doc) || typeof doc.file !== 'string') || !Array.isArray(derivedFiles) || derivedFiles.some((file: any) => typeof file !== 'string') || !object(pinned) || !Object.keys(pinned).length || typeof apply !== 'boolean' || !object(outcome) || typeof outcome.applied !== 'boolean') throw new Error('变更集证据缺少必要字段');
  const expected = planPatches(sources, entries, pinned);
  if (JSON.stringify(expected) !== JSON.stringify(plan)) throw new Error('变更集计划与输入不一致');
  return { schema: 'ai-cg-studio.scene-patch-report', schemaVersion: 1, patchSchema: { type: 'array', version: 1 },
    sourceFiles: sources.map((doc: any) => doc.file), changedRecords: plan.results.filter((item: any) => Object.keys(item.diff).length),
    protectedFieldDecision: { status: 'allowed', fields: PROTECTED_SCENE_FIELDS, pinnedIds: entries.filter((item: any) => item.type === 'scene' && Object.hasOwn(pinned, item.id)).map((item: any) => item.id) },
    derivedOutputs: derivedFiles, writeStatus: outcome.applied ? 'validated' : outcome.outcome,
    applyStatus: { requested: apply, applied: outcome.applied },
    rollbackCapability: { supported: true, scope: 'planned sources, declared derived outputs and .gz/.br siblings', backup: outcome.backup || null, exercised: Boolean(outcome.rollbackAttempted), restored: outcome.restored ?? null } };
}

function writeTextAtomic(file: any, content: any) {
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

function loadPinnedScenes(file: any = path.join(ROOT, 'data/prompt-pinned-scenes.json')) {
  let data;
  try { data = readJson(file); } catch (error) {
    throw new Error(`定稿保护基线不可读取，拒绝应用补丁: ${runtimeErrorMessage(error)}`);
  }
  if (!object(data) || !object(data.scenes) || !Object.keys(data.scenes).length ||
      Object.values(data.scenes).some((value: any) => !object(value))) {
    throw new Error('定稿保护基线结构无效，拒绝应用补丁');
  }
  return data.scenes;
}

function validatePatch(entries: any) {
  if (!Array.isArray(entries)) throw new Error('补丁文件根节点必须是数组');
  const seen = new Set();
  for (const entry of entries) {
    if (!object(entry) || !['scene', 'blueprint'].includes(entry.type) ||
        typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(entry.id) || !object(entry.changes)) {
      throw new Error('每条补丁必须有合法 type、id 和 changes 对象');
    }
    const key = `${entry.type}:${entry.id}`;
    if (seen.has(key)) throw new Error(`重复补丁: ${key}`);
    seen.add(key);
    if (Object.keys(entry.changes).some((key: any) => FORBIDDEN_KEYS.has(key))) {
      throw new Error(`${key}: 不允许修改记录 ID 或原型字段`);
    }
  }
  return entries;
}

/** Build an immutable write plan from full canonical source documents. */
function planPatches(sources: any, entries: any, pinned: any) {
  validatePatch(entries);
  if (!object(pinned) || !Object.keys(pinned).length) throw new Error('缺少有效定稿保护基线');
  const documents = sources.map((source: any) => ({ ...source, data: JSON.parse(JSON.stringify(source.data)) }));
  const byKey = new Map();
  for (const doc of documents) {
    const records = doc.type === 'scene' ? doc.data : doc.data.blueprints;
    if (!Array.isArray(records)) throw new Error(`分片结构无效: ${doc.file}`);
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
      const fields = Object.keys(entry.changes).filter((field: any) => PROTECTED_SCENE_FIELDS.includes(field));
      if (fields.length) throw new Error(`定稿场景 ${entry.id} 的受保护字段禁止批量修改: ${fields.join(', ')}`);
    }
  }
  const changedFiles = new Set();
  const results: any[] = [];
  for (const entry of entries) {
    const { doc, record } = byKey.get(`${entry.type}:${entry.id}`);
    const diff: Record<string, any> = {};
    for (const [field, to] of Object.entries(entry.changes)) {
      const from = record[field];
      if (JSON.stringify(from) === JSON.stringify(to)) continue;
      diff[field] = { from, to };
      record[field] = to;
    }
    if (Object.keys(diff).length) changedFiles.add(doc.file);
    results.push({ id: entry.id, type: entry.type, diff });
  }
  return { results, writes: documents.filter((doc: any) => changedFiles.has(doc.file)) };
}

function snapshotFiles(files: any) {
  return [...new Set(files)].map((file: any) => ({ file, exists: fs.existsSync(file), content: fs.existsSync(file) ? fs.readFileSync(file) : null }));
}

function restoreSnapshot(snapshot: any) {
  for (const item of snapshot) {
    if (item.exists) writeTextAtomic(item.file, item.content);
    else if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
  }
}

function saveBackup(snapshot: any, root: any) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const target = path.join(root, 'runtime/maintenance-backups', stamp + '-scene-patch');
  fs.mkdirSync(path.join(target, 'files'), { recursive: true });
  const files = snapshot.map((item: any, index: any) => {
    const backup = item.exists ? `${String(index).padStart(3, '0')}-${path.basename(item.file)}` : '';
    if (item.exists) fs.writeFileSync(path.join(target, 'files', backup), item.content);
    return { source: path.relative(root, item.file), existed: item.exists, backup };
  });
  fs.writeFileSync(path.join(target, 'manifest.json'), jsonText({ createdAt: new Date().toISOString(), files }));
  return target;
}

/** Refresh only existing compressed siblings; missing compressed files remain optional. */
function refreshCompression(files: any) {
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file);
    if (fs.existsSync(file + '.gz')) writeTextAtomic(file + '.gz', zlib.gzipSync(raw));
    if (fs.existsSync(file + '.br')) writeTextAtomic(file + '.br', zlib.brotliCompressSync(raw));
  }
}

/** Injectable rebuild/validate callbacks keep rollback behavior testable without real data. */
function commitPlan(plan: any, options: any) {
  if (!plan.writes.length) return { applied: false, outcome: 'unchanged' };
  const rawFiles = [...new Set([...plan.writes.map((doc: any) => doc.file), ...options.derivedFiles])];
  const snapshot = snapshotFiles(rawFiles.flatMap((file: any) => [file, file + '.gz', file + '.br']));
  const backup = saveBackup(snapshot, options.root);
  try {
    for (const doc of plan.writes) writeTextAtomic(doc.file, jsonText(doc.data));
    const version = options.rebuild();
    refreshCompression(rawFiles.filter((file: any) => file.endsWith('.json')));
    options.validate();
    return { applied: true, outcome: 'validated', version, backup };
  } catch (error) {
    try { restoreSnapshot(snapshot); } catch (rollbackError) {
      throw Object.assign(new Error(`补丁失败且自动回滚失败；备份 ${backup}: ${runtimeErrorMessage(error)}; ${runtimeErrorMessage(rollbackError)}`), { patchOutcome: { applied: false, outcome: 'rollback-failed', backup, rollbackAttempted: true, restored: false } });
    }
    throw Object.assign(new Error(`补丁写入/校验失败，已回滚；备份 ${backup}: ${runtimeErrorMessage(error)}`), { patchOutcome: { applied: false, outcome: 'rolled-back', backup, rollbackAttempted: true, restored: true } });
  }
}

function parseArgs(argv: any) {
  const args: any = { patch: null, apply: false, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--dry-run') args.apply = false;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--patch' || argv[i] === '--out') {
      const key = argv[i].slice(2);
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`缺少 ${argv[i]} 参数`);
      args[key] = argv[++i];
    } else throw new Error(`未知参数: ${argv[i]}`);
  }
  return args;
}

function runValidation(script: any) {
  const result = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} 校验失败:\n${(result.stderr + '\n' + result.stdout).trim().slice(-2000)}`);
}

function main(argv: any = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法: node scripts/maintenance/apply-scene-patch.js --patch <patch.json> [--apply] [--out <report.json>]');
    console.log('默认 dry-run。定稿保护命中会拒绝整批；--apply 写 canonical 分片并重建，校验失败回滚。');
    return;
  }
  if (!args.patch) throw new Error('缺少 --patch <patch.json>');
  const entries = validatePatch(readJson(args.patch));
  const pinned = loadPinnedScenes();
  const sceneStore: typeof import('../lib/scene-store') = require('../lib/scene-store');
  const blueprintStore: typeof import('../lib/blueprint-store') = require('../lib/blueprint-store');
  const sceneSources = sceneStore.loadSceneShards().sources;
  const blueprintSources = blueprintStore.loadBlueprintShards().sources;
  const sources = [
    ...sceneSources.map((source: any) => ({ file: source.source, type: 'scene', data: readJson(source.source) })),
    ...blueprintSources.map((source: any) => ({ file: source.source, type: 'blueprint', data: readJson(source.source) })),
  ];
  const plan = planPatches(sources, entries, pinned);
  const storeFile = path.join(ROOT, 'src/stores/sceneStore.ts');
  const derivedFiles = [
    sceneStore.aggregatePath, ...Object.values(sceneStore.browserShardPath), sceneStore.corePath,
    sceneStore.indexPath, blueprintStore.aggregatePath, storeFile,
  ];
  if (args.out) {
    const output = path.resolve(args.out);
    const reserved = [...sources.map((source: any) => source.file), ...derivedFiles, path.resolve(args.patch), path.join(ROOT, 'data/prompt-pinned-scenes.json')];
    validateOutput(output, reserved, ROOT);
  }
  const changed = plan.results.filter((item: any) => Object.keys(item.diff).length);
  console.log(`[apply-scene-patch] 补丁 ${entries.length} 条 | 实际变更 ${changed.length} | 源分片 ${plan.writes.length}`);
  for (const item of changed) console.log(JSON.stringify(item));
  let outcome: any = { applied: false, outcome: args.apply ? 'planned' : 'dry-run' };
  const report = () => ({ createdAt: new Date().toISOString(), dryRun: !args.apply, entries: entries.length, changed: changed.length, results: plan.results, ...outcome,
    ...changeSetReport(plan, { sources, entries, pinned, derivedFiles, apply: args.apply, outcome }) });
  if (args.out) writeTextAtomic(path.resolve(args.out), jsonText(report()));
  if (args.apply) {
    try {
    outcome = commitPlan(plan, {
      root: ROOT, derivedFiles,
      rebuild() {
        if (plan.writes.some((doc: any) => doc.type === 'scene')) sceneStore.writeAggregate(sceneStore.loadSceneShards().scenes);
        if (plan.writes.some((doc: any) => doc.type === 'blueprint')) blueprintStore.writeBlueprintAggregate();
        return syncDataVersion(ROOT).version;
      },
      validate() {
        runValidation('scripts/maintenance/validate-scenes.js');
        runValidation('scripts/maintenance/validate-content-contracts.js');
        const pinnedRun = spawnSync(process.execPath, ['scripts/maintenance/pin-scene-prompts.js', '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
        if (pinnedRun.error || pinnedRun.status !== 0) throw new Error('定稿校验失败: ' + (pinnedRun.error?.message || pinnedRun.stdout || pinnedRun.stderr));
      },
    });
    } catch (error: any) {
      outcome = error.patchOutcome || { applied: false, outcome: 'failed-before-write' };
      if (args.out) writeTextAtomic(path.resolve(args.out), jsonText(report()));
      throw error;
    }
  }
  if (args.out) writeTextAtomic(path.resolve(args.out), jsonText(report()));
  console.log(`[apply-scene-patch] ${outcome.outcome}${outcome.backup ? '，备份 ' + path.basename(outcome.backup) : ''}`);
}

export = { PROTECTED_SCENE_FIELDS, loadPinnedScenes, validatePatch, planPatches, snapshotFiles, restoreSnapshot, refreshCompression, commitPlan, parseArgs, main, validateOutput, changeSetReport };
if (require.main === module) {
  try { main(); } catch (error) { console.error('[apply-scene-patch] ' + runtimeErrorMessage(error)); process.exitCode = 1; }
}
