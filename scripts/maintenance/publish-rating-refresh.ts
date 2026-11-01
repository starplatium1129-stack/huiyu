#!/usr/bin/env node
import { writeJsonAtomic } from '../lib/atomic-files';
'use strict';

const { switchTarget, resolveDirArg, validateTarget }: typeof import('../lib/showcase-publication') = require('../lib/showcase-publication');
const { object }: typeof import('../lib/content-history-reader') = require('../lib/content-history-reader');
type Entry = Record<string, unknown> & { id: string };

/**
 * Publish a RATING-ONLY refresh of the showcase manifest into a NEW version
 * dir. Images/thumbs are copied wholesale — nothing is re-generated.
 *
 * With --decisions, apply only image-bound visual ratings. Otherwise use the
 * built scene and blueprint aggregates; artist/lora entries stay unchanged.
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
const { createHash }: typeof import('crypto') = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SHOWCASE_ROOT = path.resolve(ROOT, '..', 'AI', 'SceneShowcase');

function argument(name: string, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 从 `pc_<char>_<blueprint>` 提取 blueprintId（蓝图 id 均以角色 id 开头）。 */
function blueprintIdOf(entry: Entry) {
  const prefix = `pc_${entry.char}_`;
  const id = entry.id.startsWith(prefix + prefix) ? entry.id.slice(prefix.length) : entry.id;
  if (!id.startsWith(prefix)) return '';
  return id.slice(prefix.length);
}

function ratingForEntry(entry: Entry, scenesById: Map<string, Entry>, blueprintsById: Map<string, Entry>, warnings: string[]) {
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
    if (sample === 'SFW') return 'All';
    if (sample === 'R15' || sample === 'R18' || sample === 'All') return sample;
    return blueprint.adult ? 'R18' : 'All';
  }
  return entry.rating;
}

function verifyTarget(tempDir: string, manifest: { entries: Entry[]; sceneCount: number }) {
  const { parseShowcaseManifest }: typeof import('../../src/utils/showcaseManifest.ts') = require('../../src/utils/showcaseManifest.ts');
  const { isShowcaseAssetPath }: typeof import('../lib/content/showcase-assets.js') = require('../lib/content/showcase-assets.js');
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


function readEntries(value: unknown): Entry[] {
  if (!Array.isArray(value)) throw new Error('Expected catalog entries');
  return value.map((entry: unknown) => {
    if (!object(entry) || typeof entry.id !== 'string') throw new Error('Invalid catalog entry identity');
    return { ...entry, id: entry.id };
  });
}

type ReviewedRating = { id: string; rating: 'All' | 'R15' | 'R18'; imageSha256: string; thumbSha256: string };

function sha256(file: string) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function reviewAssets(root: string, entries: Map<string, Entry>, decisions: ReviewedRating[]) {
  const { isShowcaseAssetPath }: typeof import('../lib/content/showcase-assets.js') = require('../lib/content/showcase-assets.js');
  for (const decision of decisions) {
    const entry = entries.get(decision.id)!;
    for (const [kind, expected] of [['image', decision.imageSha256], ['thumb', decision.thumbSha256]] as const) {
      const relative = entry[kind] || `${kind === 'image' ? 'images' : 'thumbs'}/${entry.id}.jpg`;
      if (typeof relative !== 'string' || !isShowcaseAssetPath(`/${relative}`) || sha256(path.join(root, relative)) !== expected)
        throw new Error(`Reviewed ${kind} changed or is invalid: ${entry.id}`);
    }
  }
}

function reviewedRatings(file: string, sourceDir: string, entries: Entry[]) {
  const input = readJson(file);
  if (!object(input) || typeof input.sourceManifestSha256 !== 'string' || !Array.isArray(input.decisions)
      || sha256(path.join(sourceDir, 'manifest.json')) !== input.sourceManifestSha256)
    throw new Error('Reviewed manifest changed or decisions are invalid');
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  if (byId.size !== entries.length) throw new Error('Duplicate source showcase IDs');
  const seen = new Set<string>();
  const decisions: ReviewedRating[] = input.decisions.map((item: unknown) => {
    if (!object(item) || typeof item.id !== 'string' || seen.has(item.id)
        || !['All', 'R15', 'R18'].includes(String(item.rating))
        || typeof item.imageSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.imageSha256)
        || typeof item.thumbSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.thumbSha256))
      throw new Error('Invalid or duplicate reviewed rating');
    const entry = byId.get(item.id);
    if (!entry || (entry.type !== 'scene' && entry.type !== 'popular'))
      throw new Error(`Reviewed showcase entry not found: ${item.id}`);
    seen.add(item.id);
    return { id: item.id, rating: item.rating as ReviewedRating['rating'], imageSha256: item.imageSha256, thumbSha256: item.thumbSha256 };
  });
  if (!decisions.length) throw new Error('No reviewed ratings');
  reviewAssets(sourceDir, byId, decisions);
  return { decisions, byId };
}

function catalogById(value: unknown, key: string) {
  const rows = Array.isArray(value) ? value : object(value) ? value[key] || [] : value;
  return new Map(readEntries(rows).map(entry => [entry.id, entry]));
}

function main() {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  const showcaseRoot = path.resolve(argument('--showcase', DEFAULT_SHOWCASE_ROOT));
  const sourceDir = resolveDirArg(showcaseRoot, argument('--source', ''), '--source', true);
  const targetDir = validateTarget(showcaseRoot, sourceDir, resolveDirArg(showcaseRoot, argument('--target', ''), '--target', false));

  const sourceManifest = readJson(path.join(sourceDir, 'manifest.json'));
  if (!object(sourceManifest) || (sourceManifest.version != null && typeof sourceManifest.version !== 'number')) throw new Error('Invalid source showcase manifest');
  const sourceEntries = readEntries(sourceManifest.entries || []);
  const warnings: string[] = [];
  const reviewFile = argument('--decisions');
  const review = reviewFile ? reviewedRatings(path.resolve(reviewFile), sourceDir, sourceEntries) : null;
  let entries: Entry[];
  if (review) {
    const ratings = new Map(review.decisions.map(decision => [decision.id, decision.rating]));
    entries = sourceEntries.map(entry => ({ ...entry, rating: ratings.get(entry.id) ?? entry.rating }));
  } else {
    const scenesById = catalogById(readJson(path.join(ROOT, 'data', 'scenes.json')), 'scenes');
    const blueprintsById = catalogById(readJson(path.join(ROOT, 'data', 'scene-blueprints.json')), 'blueprints');
    entries = sourceEntries.map(entry => ({ ...entry, rating: ratingForEntry(entry, scenesById, blueprintsById, warnings) }));
  }

  const typeCounts: Record<string, number> = { scene: 0, artist: 0, popular: 0, lora: 0 };
  for (const entry of entries) if (typeof entry.type === 'string' && typeCounts[entry.type] !== undefined) typeCounts[entry.type] += 1;
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

  const changed = entries.filter((entry, index) => entry.rating !== sourceEntries[index].rating);
  console.log(`rating refresh: source=${sourceDir} target=${targetDir}`);
  console.log(`  entries=${entries.length} changed=${changed.length}`);
  console.log(`  counts before=${JSON.stringify(sourceManifest.counts)} after=${JSON.stringify(counts)}`);
  for (const entry of changed) console.log(`  ${entry.id}: ${sourceEntries.find(e => e.id === entry.id)!.rating} -> ${entry.rating}`);
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
    if (review) {
      reviewedRatings(path.resolve(reviewFile), sourceDir, sourceEntries);
      reviewAssets(tempDir, review.byId, review.decisions);
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
