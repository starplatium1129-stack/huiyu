#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * Publish ALL audit-passed popular-character showcase candidates into a NEW
 * showcase version dir, replacing the legacy pc_* test samples entirely.
 *
 * - Every passed candidate becomes a popular entry (id pc_<subject>_<blueprint>);
 *   old pc_* entries + assets from the source dir are removed.
 * - Each character gets one portrait export (first passing SFW blueprint in
 *   data order) written to <portraits-out>/popular-<characterId>.png for the
 *   character archives (data/characters.json portrait.image).
 * - Scene/artist/lora entries are carried over untouched.
 *
 * Usage:
 *   node scripts/maintenance/publish-popular-showcase.js \
 *       [--from <generation-manifest>] [--source 2026-08-14_v17] \
 *       [--target 2026-08-14_v18] [--showcase <root>] [--python <python>] \
 *       [--portraits-out <assets/characters dir>] [--apply] [--force]
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { spawnSync }: typeof import('child_process') = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const AI_ROOT = path.resolve(ROOT, '..', 'AI');
const DEFAULT_FROM = path.join(AI_ROOT, 'Reviews', 'ShowcaseRefresh', '2026-08-14_v18-popular-all-rella', 'generation-manifest.json');
const DEFAULT_SHOWCASE_ROOT = path.join(AI_ROOT, 'SceneShowcase');
const DEFAULT_TARGET = '2026-08-15_v22';
const DEFAULT_SOURCE = '2026-08-15_v22';
const DEFAULT_PORTRAITS = path.join(ROOT, 'assets', 'characters');

const IMAGE_BOX = '1800x2400';
const IMAGE_QUALITY = 94;
const THUMB_BOX = '480x640';
const THUMB_QUALITY = 85;

function argument(name: any, fallback: any = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function readJson(file: any) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJsonAtomic(file: any, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}
function isRecord(value: any) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function cleanMeta(value: any) {
  return Object.fromEntries(Object.entries(value).filter(([, v]: any) => v !== undefined && v !== null && String(v) !== ''));
}

/** 只发布审核通过的候选（audit-results.json verdict pass 的最新 attempt）。 */
function loadPassedRecords(from: any, auditPath: any) {
  const records = readJson(from);
  const audit = fs.existsSync(auditPath) ? readJson(auditPath) : {};
  const best = new Map();
  for (const r of records) {
    if (r.status !== 'succeeded') continue;
    const prev = best.get(r.key);
    if (!prev || r.attempt > prev.attempt) best.set(r.key, r);
  }
  const passed: any[] = [];
  for (const rec of best.values()) {
    const entry = audit[rec.recordId];
    if (entry && entry.ok && entry.verdict === 'pass') passed.push(rec);
  }
  passed.sort((a: any, b: any) => a.characterId.localeCompare(b.characterId) || a.blueprintId.localeCompare(b.blueprintId));
  return passed;
}

function loadLoraVersions() {
  try {
    const loras = readJson(path.join(ROOT, 'data', 'loras.json'));
    const list = Array.isArray(loras) ? loras : (loras.data || []);
    const versions: Record<string, any> = {};
    for (const lora of list) if (lora && lora.id && lora.version !== undefined) versions[lora.id] = String(lora.version);
    return versions;
  } catch (error) { return {}; }
}

function popularEntry(record: any, audit: any, loraVersions: any, displayNameByChar: any) {
  const subject = record.characterId;
  const blueprint = record.blueprintId;
  const id = `pc_${subject}_${blueprint}`;
  const displayName = (displayNameByChar && displayNameByChar[subject]) || subject;
  const seed = record.actualSeed ?? record.seed;
  const meta: any = { engine: record.engine || 'anima', model: record.modelId, checkpoint: record.checkpoint };
  if (record.loraId) { meta.loraId = record.loraId; meta.loraVersion = (loraVersions && loraVersions[record.loraId]) || ''; }
  if (seed !== undefined && seed !== null && Number.isFinite(Number(seed))) meta.seed = Math.trunc(Number(seed));
  const attempt = Math.max(1, Number(record.attempt) || 1);
  const reviewed = audit && audit[record.recordId];
  return {
    id,
    title: `${displayName} / ${record.blueprintTitle}`,
    story: '',
    category: record.adult ? '成人' : '热门角色',
    char: subject,
    displayName,
    rating: record.adult ? 'R18' : 'All',
    attempt,
    type: 'popular',
    image: `images/${id}.jpg`,
    thumb: `thumbs/${id}.jpg`,
    meta: cleanMeta(meta),
    prompt: record.prompt || '',
    negative: record.negative || '',
    provenance: {
      batch: 'popular',
      key: record.key,
      recordId: record.recordId,
      attempt,
      generatedAt: record.generatedAt || '',
      review: {
        verdict: 'pass',
        recordId: record.recordId,
        notes: (reviewed && reviewed.summary ? String(reviewed.summary).slice(0, 120) : ''),
        reviewedAt: reviewed && reviewed.inspectedAt ? reviewed.inspectedAt : '',
      },
    },
  };
}

function buildManifest(sourceManifest: any, popularEntries: any, context: any) {
  const sourceEntries = (sourceManifest.entries || [])
    .filter((entry: any) => isRecord(entry))
    .map((entry: any) => (entry.type ? entry : Object.assign({}, entry, { type: 'scene' })));
  const incoming = new Set(popularEntries.map((entry: any) => entry.id));
  // 旧 pc_* 测试样张全部删除；artist/lora 保留；scene 保留。
  const kept = sourceEntries.filter((entry: any) => entry.type !== 'popular' && !incoming.has(entry.id));
  const entries = [...kept, ...popularEntries];
  const typeCounts: any = { scene: 0, artist: 0, popular: 0, lora: 0 };
  for (const entry of entries) if (typeCounts[entry.type] !== undefined) typeCounts[entry.type] += 1;
  const counts: any = { All: 0, R15: 0, R18: 0 };
  for (const entry of entries) {
    const rating = entry.rating === 'R15' || entry.rating === 'R18' ? entry.rating : 'All';
    counts[rating] += 1;
  }
  return {
    version: 4,
    source: context.sourceName,
    sourceAudit: sourceManifest.sourceAudit || '',
    publishedAt: context.publishedAt,
    sceneCount: typeCounts.scene,
    entryCount: entries.length,
    typeCounts,
    counts,
    entries,
  };
}

function resolveDirArg(showcaseRoot: any, value: any, label: any, mustExist: any) {
  const raw = value || '';
  const explicitPath = path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw);
  const candidate = explicitPath ? path.resolve(raw) : path.join(path.resolve(showcaseRoot), raw);
  if (mustExist) {
    if (!fs.existsSync(candidate)) throw new Error(`${label} does not exist: ${candidate}`);
    if (!fs.existsSync(path.join(candidate, 'manifest.json'))) throw new Error(`${label} has no manifest.json: ${candidate}`);
  }
  return path.resolve(candidate);
}
function isSameOrChild(child: any, parent: any) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function validateTarget(showcaseRoot: any, sourceDir: any, targetDir: any) {
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
function sourcePathFor(record: any, from: any) {
  const rel = record.image || '';
  if (!rel) throw new Error(`succeeded record has no image: ${record.recordId || record.key}`);
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
function convertImages(python: any, sourceFile: any, imageOut: any, thumbOut: any) {
  const result = spawnSync(python, [
    path.join(ROOT, 'scripts', 'maintenance', 'convert-showcase-image.py'),
    sourceFile, imageOut, thumbOut,
    '--image-box', IMAGE_BOX, '--image-quality', String(IMAGE_QUALITY),
    '--thumb-box', THUMB_BOX, '--thumb-quality', String(THUMB_QUALITY),
  ], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (result.error) throw new Error(`image conversion could not run (${python}): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`image conversion failed for ${sourceFile}:\n${result.stderr || result.stdout || 'unknown error'}`);
  for (const out of [imageOut, thumbOut]) {
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error(`image conversion produced no output: ${out}`);
  }
}

function verifyTarget(tempDir: any, manifest: any) {
  const { parseShowcaseManifest }: typeof import('../../src/utils/showcaseManifest.ts') = require('../../src/utils/showcaseManifest.ts');
  const { isShowcaseAssetPath }: typeof import('../../server/showcase-assets.js') = require('../../server/showcase-assets.js');
  const parsed = parseShowcaseManifest(manifest);
  if (parsed.entries.length !== manifest.entries.length) throw new Error(`manifest lost entries: ${parsed.entries.length} != ${manifest.entries.length}`);
  const ids = new Set(parsed.entries.map((entry: any) => entry.id));
  if (ids.size !== parsed.entries.length) throw new Error('manifest ids are not unique');
  if (parsed.sceneCount !== manifest.sceneCount) throw new Error('sceneCount mismatch');
  if (parsed.entryCount !== manifest.entryCount) throw new Error('entryCount mismatch');
  for (const entry of parsed.entries) {
    const image = entry.image || `images/${entry.id}.jpg`;
    const thumb = entry.thumb || `thumbs/${entry.id}.jpg`;
    for (const [kind, rel] of [['image', image], ['thumb', thumb]]) {
      if (!isShowcaseAssetPath(`/${rel}`)) throw new Error(`asset path not allowlisted: ${entry.id} ${kind}=${rel}`);
      const file = path.join(tempDir, rel.split('/').join(path.sep));
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`missing asset: ${entry.id} ${kind}=${rel}`);
    }
  }
}

function switchTarget(tempDir: any, targetDir: any, force: any, renameSync: any = fs.renameSync, rmSync: any = fs.rmSync) {
  const backupDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.backup-${process.pid}`);
  const targetExists = fs.existsSync(targetDir);
  if (targetExists) {
    if (!force) throw new Error(`target already exists: ${targetDir} (use --force to overwrite)`);
    if (!fs.existsSync(path.join(targetDir, 'manifest.json'))) throw new Error(`refusing to replace target without manifest.json: ${targetDir}`);
    rmSync(backupDir, { recursive: true, force: true });
    renameSync(targetDir, backupDir);
  }
  try {
    renameSync(tempDir, targetDir);
  } catch (error) {
    if (targetExists) {
      try { renameSync(backupDir, targetDir); } catch (restoreError) {
        runtimeErrorMessage(error) = `${runtimeErrorMessage(error)}\n  additionally failed to restore backup ${backupDir}: ${runtimeErrorMessage(restoreError)}`;
      }
    }
    throw error;
  }
  if (targetExists) rmSync(backupDir, { recursive: true, force: true });
}

/** 每角色立绘：数据顺序第一张「通过审核 + 竖构图（高>宽）」的 SFW 候选；
 *  无竖图 SFW 时回退竖图任意，再回退数据顺序第一张。 */
function pickPortraits(passed: any, blueprints: any) {
  const order = new Map();
  const bpList = Array.isArray(blueprints) ? blueprints : (blueprints.blueprints || []);
  bpList.forEach((bp: any, index: any) => order.set(bp.id, index));
  const byCharacter = new Map();
  for (const rec of passed) {
    if (!byCharacter.has(rec.characterId)) byCharacter.set(rec.characterId, []);
    byCharacter.get(rec.characterId).push(rec);
  }
  const portraits = new Map();
  for (const [characterId, list] of byCharacter) {
    const sorter = (a: any, b: any) => (order.get(a.blueprintId) ?? 999) - (order.get(b.blueprintId) ?? 999);
    const sorted = list.sort(sorter);
    const vertical = (r: any) => Number(r.width) > 0 && Number(r.height) > Number(r.width);
    const sfwVertical = sorted.filter((r: any) => !r.adult && vertical(r));
    const anyVertical = sorted.filter(vertical);
    const picked = (sfwVertical.length ? sfwVertical : anyVertical.length ? anyVertical : sorted)[0];
    portraits.set(characterId, picked);
  }
  return portraits;
}

async function main() {
  const from = path.resolve(argument('--from', DEFAULT_FROM));
  const auditPath = path.join(path.dirname(from), 'audit-results.json');
  const showcaseRoot = path.resolve(argument('--showcase', DEFAULT_SHOWCASE_ROOT));
  const sourceDir = resolveDirArg(showcaseRoot, argument('--source', DEFAULT_SOURCE), '--source', true);
  const targetDir = resolveDirArg(showcaseRoot, argument('--target', DEFAULT_TARGET), '--target', false);
  const portraitsOut = path.resolve(argument('--portraits-out', DEFAULT_PORTRAITS));
  const python = argument('--python', 'python');
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');

  validateTarget(showcaseRoot, sourceDir, targetDir);

  const passed = loadPassedRecords(from, auditPath);
  if (!passed.length) throw new Error('no passed popular records to publish');
  const blueprints = readJson(path.join(ROOT, 'data', 'scene-blueprints.json'));
  const portraits = pickPortraits(passed, blueprints);
  const loraVersions = loadLoraVersions();
  const popularData = readJson(path.join(ROOT, 'data', 'popular-characters.json'));
  const displayNameByChar: Record<string, any> = {};
  for (const character of (popularData.characters || [])) {
    displayNameByChar[character.id] = character.displayName || character.id;
  }
  const audit = readJson(auditPath);
  const entries = passed.map((record: any) => popularEntry(record, audit, loraVersions, displayNameByChar));

  const sourceManifest = readJson(path.join(sourceDir, 'manifest.json'));
  const manifest = buildManifest(sourceManifest, entries, {
    sourceName: path.basename(sourceDir),
    publishedAt: new Date().toISOString(),
  });

  const summary = {
    from, source: sourceDir, target: targetDir, portraitsOut,
    sceneCount: manifest.sceneCount, entryCount: manifest.entryCount,
    typeCounts: manifest.typeCounts, counts: manifest.counts,
    popularEntries: entries.length,
    portraits: [...portraits.entries()].map(([c, r]: any) => `${c} -> ${r.blueprintId}${r.adult ? ' (R18)' : ''}`),
  };
  if (!apply) {
    console.log('[dry-run] ' + JSON.stringify(summary, null, 2));
    return;
  }

  const tempDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.building-${process.pid}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  try {
    fs.cpSync(sourceDir, tempDir, { recursive: true });
    // 1) 删除旧 pc_* 资产，写入新 popular 图片
    for (const kind of ['images', 'thumbs']) {
      const dir = path.join(tempDir, kind);
      const files = fs.readdirSync(dir);
      for (const name of files) {
        if (/^pc_[a-z0-9_-]+\.(?:jpg|png|webp)$/i.test(name)) fs.rmSync(path.join(dir, name), { force: true });
      }
    }
    for (const record of passed) {
      const entry = entries.find((e: any) => e.provenance && e.provenance.recordId === record.recordId);
      if (!entry) throw new Error(`missing entry for ${record.recordId}`);
      convertImages(
        python,
        sourcePathFor(record, from),
        path.join(tempDir, entry.image.split('/').join(path.sep)),
        path.join(tempDir, entry.thumb.split('/').join(path.sep)),
      );
    }
    writeJsonAtomic(path.join(tempDir, 'manifest.json'), manifest);
    verifyTarget(tempDir, manifest);
    switchTarget(tempDir, targetDir, force);
    // 2) 角色档案立绘替换（assets/characters/popular-<id>.png）
    for (const [characterId, record] of portraits) {
      const source = sourcePathFor(record, from);
      const target = path.join(portraitsOut, `popular-${characterId}.png`);
      const buffer = fs.readFileSync(source);
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, buffer, { flag: 'wx' });
      fs.renameSync(temporary, target);
      console.log(`[portrait] ${characterId} <- ${record.blueprintId} (${buffer.length} bytes)`);
    }
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  console.log(JSON.stringify(Object.assign(summary, { written: true }), null, 2));
}

export = {
  loadPassedRecords, popularEntry, buildManifest, pickPortraits,
  resolveDirArg, validateTarget, sourcePathFor, convertImages, verifyTarget, switchTarget,
  argument,
  constants: { ROOT, AI_ROOT, DEFAULT_FROM, DEFAULT_SHOWCASE_ROOT, DEFAULT_TARGET, DEFAULT_SOURCE, DEFAULT_PORTRAITS },
};

if (require.main === module) {
  main().catch((error: any) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}
