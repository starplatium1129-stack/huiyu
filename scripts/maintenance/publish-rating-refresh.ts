#!/usr/bin/env node
'use strict';

/**
 * Publish a RATING-ONLY refresh of the showcase manifest into a NEW version
 * dir. Images/thumbs are copied wholesale — nothing is re-generated.
 *
 * Rating source of truth (2026-08-15 用户决策：样张重新定级)：
 *   - scene entries  : data/scenes.json (aggregate; canonical shards in
 *                      data/scenes/*.json, built by build-scenes.js)
 *   - popular entries: data/scene-blueprints.json `sampleRating`
 *                      (fallback: adult → R18, else All)
 *   - artist/lora    : carried over unchanged
 *
 * Usage:
 *   node scripts/maintenance/publish-rating-refresh.js \
 *       [--source <name|dir>] [--target <name|dir>] [--showcase <root>] \
 *       [--force] [--apply]
 *
 * Dry-run by default (reports what would change); --apply actually builds.
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SHOWCASE_ROOT = path.resolve(ROOT, '..', 'AI', 'SceneShowcase');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function resolveDirArg(showcaseRoot, value, label, mustExist) {
  const raw = value || '';
  const explicitPath = path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw);
  const candidate = explicitPath ? path.resolve(raw) : path.join(path.resolve(showcaseRoot), raw);
  if (mustExist) {
    if (!fs.existsSync(candidate)) throw new Error(`${label} does not exist: ${candidate}`);
    if (!fs.existsSync(path.join(candidate, 'manifest.json'))) throw new Error(`${label} has no manifest.json: ${candidate}`);
  }
  return path.resolve(candidate);
}
function isSameOrChild(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function validateTarget(showcaseRoot, sourceDir, targetDir) {
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

/** 从 `pc_<char>_<blueprint>` 提取 blueprintId（蓝图 id 均以角色 id 开头）。 */
function blueprintIdOf(entry) {
  const prefix = `pc_${entry.char}_`;
  if (typeof entry.id !== 'string' || !entry.id.startsWith(prefix)) return '';
  return entry.id.slice(prefix.length);
}

function ratingForEntry(entry, scenesById, blueprintsById, warnings) {
  if (entry.type === 'scene') {
    const scene = scenesById.get(entry.id);
    if (!scene) {
      warnings.push(`scene ${entry.id}: not in scenes.json, keeping ${entry.rating}`);
      return entry.rating;
    }
    return scene.rating === 'R15' || scene.rating === 'R18' ? scene.rating : 'All';
  }
  if (entry.type === 'popular') {
    const id = blueprintIdOf(entry);
    const blueprint = id ? blueprintsById.get(id) : null;
    if (!blueprint) {
      warnings.push(`popular ${entry.id}: blueprint ${id || '?'} not found, keeping ${entry.rating}`);
      return entry.rating;
    }
    const sample = blueprint.sampleRating;
    if (sample === 'R15' || sample === 'R18' || sample === 'All') return sample;
    return blueprint.adult ? 'R18' : 'All';
  }
  return entry.rating;
}

function verifyTarget(tempDir, manifest) {
  const { parseShowcaseManifest }: typeof import('../../src/utils/showcaseManifest.ts') = require('../../src/utils/showcaseManifest.ts');
  const { isShowcaseAssetPath }: typeof import('../../server/showcase-assets.js') = require('../../server/showcase-assets.js');
  const parsed = parseShowcaseManifest(manifest);
  if (parsed.entries.length !== manifest.entries.length) throw new Error(`manifest lost entries: ${parsed.entries.length} != ${manifest.entries.length}`);
  const ids = new Set(parsed.entries.map(entry => entry.id));
  if (ids.size !== parsed.entries.length) throw new Error('manifest ids are not unique');
  if (parsed.sceneCount !== manifest.sceneCount) throw new Error('sceneCount mismatch');
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

function switchTarget(tempDir, targetDir, force) {
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
      try { fs.renameSync(backupDir, targetDir); } catch (restoreError) { /* keep original error */ }
    }
    throw error;
  }
  if (targetExists) fs.rmSync(backupDir, { recursive: true, force: true });
}

function main() {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  const showcaseRoot = path.resolve(argument('--showcase', DEFAULT_SHOWCASE_ROOT));
  const sourceDir = resolveDirArg(showcaseRoot, argument('--source', ''), '--source', true);
  const targetDir = validateTarget(showcaseRoot, sourceDir, resolveDirArg(showcaseRoot, argument('--target', ''), '--target', false));

  const sourceManifest = readJson(path.join(sourceDir, 'manifest.json'));
  const scenesAggregate = readJson(path.join(ROOT, 'data', 'scenes.json'));
  const sceneList = Array.isArray(scenesAggregate) ? scenesAggregate : (scenesAggregate.scenes || []);
  const scenesById = new Map(sceneList.map(scene => [scene.id, scene]));
  const blueprintsData = readJson(path.join(ROOT, 'data', 'scene-blueprints.json'));
  const blueprintList = Array.isArray(blueprintsData) ? blueprintsData : (blueprintsData.blueprints || []);
  const blueprintsById = new Map(blueprintList.map(blueprint => [blueprint.id, blueprint]));

  const warnings = [];
  const entries = (sourceManifest.entries || []).filter(isRecord).map(entry => {
    const next = { ...entry };
    const nextRating = ratingForEntry(next, scenesById, blueprintsById, warnings);
    next.rating = next.rating === nextRating ? next.rating : nextRating;
    return next;
  });

  const typeCounts = { scene: 0, artist: 0, popular: 0, lora: 0 };
  for (const entry of entries) if (typeCounts[entry.type] !== undefined) typeCounts[entry.type] += 1;
  const counts = { All: 0, R15: 0, R18: 0 };
  for (const entry of entries) {
    const rating = entry.rating === 'R15' || entry.rating === 'R18' ? entry.rating : 'All';
    counts[rating] += 1;
  }
  const manifest = {
    version: (sourceManifest.version || 1) + 1,
    source: sourceManifest.source || sourceDir,
    sourceAudit: sourceManifest.sourceAudit || '',
    publishedAt: new Date().toISOString(),
    sceneCount: typeCounts.scene,
    entryCount: entries.length,
    typeCounts,
    counts,
    entries,
  };

  const changed = entries.filter((entry, index) => entry.rating !== sourceManifest.entries[index].rating);
  console.log(`rating refresh: source=${sourceDir} target=${targetDir}`);
  console.log(`  entries=${entries.length} changed=${changed.length}`);
  console.log(`  counts before=${JSON.stringify(sourceManifest.counts)} after=${JSON.stringify(counts)}`);
  for (const entry of changed) console.log(`  ${entry.id}: ${sourceManifest.entries.find(e => e.id === entry.id).rating} -> ${entry.rating}`);
  if (warnings.length) for (const warning of warnings) console.log(`  warn: ${warning}`);
  if (!apply) {
    console.log('dry-run: pass --apply to build');
    return;
  }

  const tempDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.build-${process.pid}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    for (const dir of ['images', 'thumbs', 'home']) {
      const source = path.join(sourceDir, dir);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(tempDir, dir), { recursive: true });
    }
    // 顶层伴生文件（封面/主页英雄清单/SPA 壳/说明）原样保留，避免发布缺件。
    for (const file of ['00-cover.jpg', 'home-hero.json', 'index.html', 'README.txt']) {
      const source = path.join(sourceDir, file);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(tempDir, file));
    }
    writeJsonAtomic(path.join(tempDir, 'manifest.json'), manifest);
    verifyTarget(tempDir, manifest);
    switchTarget(tempDir, targetDir, force);
    console.log(`published: ${targetDir}`);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

main();
