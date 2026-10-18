#!/usr/bin/env node
import { writeJsonAtomic } from '../lib/atomic-files';
import { errorMessage as runtimeErrorMessage, errorStack } from '../lib/runtime-errors';
'use strict';

const { switchTarget, cleanMeta, loadLoraVersions, readSourceManifest, resolveDirArg, validateTarget, sourcePathFor }:
  typeof import('../lib/showcase-publication') = require('../lib/showcase-publication');
const { object: isRecord }: typeof import('../lib/content-history-reader') = require('../lib/content-history-reader');
import type { Scene } from '../../src/types/scene';
type ReviewRecord = { verdict: 'pass' | 'fail'; recordId: string; notes: unknown; reviewedAt: string };
type SceneCandidate = Record<string, unknown> & {
  key?: string | null; recordId?: string | null; sceneId?: string; loraId?: string | null;
};

/**
 * Publish the anima-aesthetic-v1.1 + @rella scene generation into a NEW
 * showcase version dir, replacing EVERY scene sample preview.
 *
 * Source of truth:
 *   - generation-manifest.json from generate-scene-showcase-anima11.js
 *     (kept in AI/Reviews/SceneShowcaseRefresh/2026-08-14_v16-anima11-rella/)
 *   - manual-review.json next to it with the shape:
 *       { version: <number>, reviewedAt: <iso string>,
 *         records: { "scene:sc001": { verdict: 'pass'|'fail', recordId, notes? } } }
 *
 * Gates (missing/malformed gate fails even in dry-run — never publishes
 * mechanically-succeeded records without a human pass):
 *   - manual-review.json must exist and parse; EVERY succeeded scene key must
 *     appear in the review (no partial publishes).
 *   - pass records resolve to a `succeeded` manifest record of the same key.
 *   - every scene id in data/scenes.json must have a passing record; otherwise
 *     the whole run fails.
 *
 * Build:
 *   - copies the source showcase dir wholesale into a sibling temp dir,
 *   - replaces images/scNNN.jpg + thumbs/scNNN.jpg for every scene with the
 *     approved candidate PNG (compressed big JPEG + real thumbnail via
 *     convert-showcase-image.py — the production save_jpeg),
 *   - drops legacy scene files that are not part of data/scenes.json,
 *   - refreshes home/nene.jpg (sc002) and home/natsume.jpg (sc005),
 *   - writes a new manifest (scene entries rebuilt from data + record meta,
 *     artist/popular/lora entries carried over from the source manifest),
 *   - fully verifies, then atomically switches the target dir (old target is
 *     renamed aside to a sibling backup and only removed after success).
 *
 * Dry-run by default: pass --apply to actually build.
 *
 * Usage:
 *   node scripts/maintenance/publish-scene-showcase-anima11.js \
 *       [--from <generation-manifest>] [--review <manual-review.json>] \
 *       [--target <name|dir>] [--source <name|dir>] [--showcase <root>] \
 *       [--python <python>] [--force] [--apply]
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { convertImages }: typeof import('../lib/showcase-image-conversion.js') = require('../lib/showcase-image-conversion.js');

const ROOT = path.resolve(__dirname, '..', '..');
const AI_ROOT = path.resolve(ROOT, '..', 'AI');
const DEFAULT_FROM = path.join(
  AI_ROOT,
  'Reviews',
  'SceneShowcaseRefresh',
  '2026-08-14_v16-anima11-rella',
  'generation-manifest.json',
);
const DEFAULT_SHOWCASE_ROOT = path.join(AI_ROOT, 'SceneShowcase');
const DEFAULT_TARGET = '2026-08-15_v22';
const DEFAULT_SOURCE = '2026-08-15_v22';
const HOME_HERO_SCENES = Object.freeze({ nene: 'sc002', natsume: 'sc005' });

function argument(name: string, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 解析并校验 manual-review.json。缺文件 / 非 JSON / 字段错一律抛错。 */
function parseReviewData(value: unknown) {
  if (!isRecord(value)) throw new Error('manual-review.json must be an object with {version, reviewedAt, records}');
  if (!Number.isFinite(Number(value.version))) {
    throw new Error('manual-review.json must carry a numeric version');
  }
  if (typeof value.reviewedAt !== 'string' || !value.reviewedAt.trim()) {
    throw new Error('manual-review.json must carry reviewedAt');
  }
  if (!isRecord(value.records)) throw new Error('manual-review.json must carry a records map');
  const records: Record<string, ReviewRecord> = {};
  for (const [key, record] of Object.entries(value.records)) {
    if (!isRecord(record)) throw new Error(`review record "${key}" must be an object`);
    if (record.verdict !== 'pass' && record.verdict !== 'fail') {
      throw new Error(`review record "${key}" verdict must be 'pass' or 'fail', got ${JSON.stringify(record.verdict)}`);
    }
    if (record.verdict === 'pass' && (typeof record.recordId !== 'string' || !record.recordId)) {
      throw new Error(`review record "${key}" (pass) must carry recordId`);
    }
    if (record.recordId !== undefined && typeof record.recordId !== 'string') {
      throw new Error(`review record "${key}" recordId must be a string`);
    }
    records[key] = {
      verdict: record.verdict,
      recordId: record.recordId || '',
      notes: record.notes || '',
      reviewedAt: value.reviewedAt,
    };
  }
  return { version: Number(value.version), reviewedAt: value.reviewedAt, records };
}

function readReview(reviewPath: string) {
  let raw;
  try {
    raw = fs.readFileSync(reviewPath, 'utf8');
  } catch (error) {
    throw new Error(`manual review file missing: ${reviewPath} — 人工审核未完成，拒绝发布`);
  }
  try {
    return parseReviewData(JSON.parse(raw));
  } catch (error) {
    throw new Error(`manual review invalid: ${reviewPath} — ${runtimeErrorMessage(error)}`);
  }
}

/** 把审核结论映射到候选记录；只发布明确 pass 且 recordId 对应 succeeded 记录。 */
function planPublished(review: ReturnType<typeof parseReviewData>, records: unknown) {
  if (!Array.isArray(records)) throw new Error('candidate manifest must be an array');
  const candidates = records.map((record: unknown) => {
    if (!isRecord(record) || ['key', 'recordId', 'loraId'].some(key => record[key] != null && typeof record[key] !== 'string')
      || (record.sceneId !== undefined && typeof record.sceneId !== 'string')) throw new Error('Invalid scene candidate');
    return record as SceneCandidate;
  });
  const byRecordId = new Map<string, SceneCandidate>();
  const byKey = new Map<string, SceneCandidate[]>();
  for (const record of candidates) {
    const rid = record.recordId || `${record.key}@attempt-${record.attempt || 1}`;
    if (byRecordId.has(rid)) throw new Error(`duplicate recordId in candidate manifest: ${rid}`);
    byRecordId.set(rid, record);
    if (!record.key) continue;
    if (!byKey.has(record.key)) byKey.set(record.key, []);
    byKey.get(record.key)!.push(record);
  }
  for (const key of Object.keys(review.records)) {
    if (!byKey.has(key)) throw new Error(`review key not in candidate manifest: ${key}`);
  }
  const additions: { key: string; record: SceneCandidate; review: ReviewRecord }[] = [];
  const rejected: string[] = [];
  for (const [key, verdict] of Object.entries(review.records)) {
    if (verdict.verdict === 'fail') {
      rejected.push(key);
      continue;
    }
    const record = byRecordId.get(verdict.recordId);
    if (!record) throw new Error(`review pass recordId not in candidate manifest: ${key} -> ${verdict.recordId}`);
    if (record.status !== 'succeeded') {
      throw new Error(`review pass record is not succeeded: ${key} -> ${verdict.recordId} (${record.status})`);
    }
    if (record.key !== key) {
      throw new Error(`review pass recordId belongs to a different key: ${key} -> ${verdict.recordId} (${record.key})`);
    }
    additions.push({ key, record, review: verdict });
  }
  const reviewedKeys = new Set(Object.keys(review.records));
  const unreviewed: string[] = [];
  for (const [key, list] of byKey) {
    if (!list.some(item => item.status === 'succeeded')) continue;
    if (!reviewedKeys.has(key)) unreviewed.push(key);
  }
  additions.sort((a, b) => a.key.localeCompare(b.key));
  return { additions, rejected, unreviewed };
}

/** 完整审核门禁：succeeded key 必须全部出现在人工审核里，否则拒绝发布（防部分发布）。 */
function assertFullReviewCoverage(plan: ReturnType<typeof planPublished>) {
  if (plan.unreviewed.length) {
    throw new Error(
      `manual review must cover every succeeded key — 未审核 ${plan.unreviewed.length} 个: ${plan.unreviewed.join(', ')}`,
    );
  }
}

function buildSceneEntry(scene: Scene, record: SceneCandidate, review: ReviewRecord, loraVersions: Record<string, string>) {
  const seed = record.actualSeed ?? record.seed;
  const meta: Record<string, unknown> = { engine: record.engine || 'anima', model: record.modelId, checkpoint: record.checkpoint };
  if (record.loraId) {
    meta.loraId = record.loraId;
    meta.loraVersion = loraVersions[record.loraId] || '';
  }
  if (seed !== undefined && seed !== null && Number.isFinite(Number(seed))) meta.seed = Math.trunc(Number(seed));
  const attempt = Math.max(1, Number(record.attempt) || 1);
  return {
    id: scene.id,
    title: scene.title,
    story: scene.story || '',
    category: scene.category || '',
    char: scene.char,
    rating: scene.rating === 'R15' || scene.rating === 'R18' ? scene.rating : 'All',
    attempt,
    type: 'scene',
    image: `images/${scene.id}.jpg`,
    thumb: `thumbs/${scene.id}.jpg`,
    meta: cleanMeta(meta),
    prompt: record.prompt || '',
    negative: record.negative || '',
    provenance: {
      batch: 'scene',
      key: record.key,
      recordId: review.recordId,
      attempt,
      generatedAt: record.generatedAt || '',
      review: {
        verdict: 'pass',
        recordId: review.recordId,
        notes: review.notes || '',
        reviewedAt: review.reviewedAt,
      },
    },
  };
}

/** 合并新场景条目与 source 的非场景条目，重算计数。 */
function buildManifest(sourceManifest: ReturnType<typeof readSourceManifest>, additions: { entry: ReturnType<typeof buildSceneEntry> }[], context: { sourceName: string; publishedAt: string }) {
  const incoming = new Set(additions.map(item => item.entry.id));
  const nonScene = sourceManifest.entries.filter(entry => entry.type !== 'scene' && !incoming.has(entry.id));
  const entries = [
    ...additions.map(item => item.entry).sort((a, b) => a.id.localeCompare(b.id)),
    ...nonScene,
  ];
  const typeCounts: Record<string, number> = { scene: 0, artist: 0, popular: 0, lora: 0 };
  for (const entry of entries) {
    if (typeCounts[entry.type] !== undefined) typeCounts[entry.type] += 1;
  }
  const counts = { All: 0, R15: 0, R18: 0 };
  for (const entry of entries) {
    const rating = entry.rating === 'R15' || entry.rating === 'R18' ? entry.rating : 'All';
    counts[rating] += 1;
  }
  const sheets: unknown[] | undefined = Array.isArray(sourceManifest.sheets) ? sourceManifest.sheets : undefined;
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
    ...(sheets?.length ? { sheets } : {}),
  };
}

/** 完整验证：manifest 可被生产解析器接受、计数自洽、id 唯一、资产存在且符合白名单。 */
function verifyTarget(tempDir: string, manifest: ReturnType<typeof buildManifest>) {
  const { parseShowcaseManifest }: typeof import('../../src/utils/showcaseManifest.ts') = require('../../src/utils/showcaseManifest.ts');
  const { isShowcaseAssetPath }: typeof import('../lib/content/showcase-assets.js') = require('../lib/content/showcase-assets.js');
  const parsed = parseShowcaseManifest(manifest);
  if (parsed.entries.length !== manifest.entries.length) {
    throw new Error(`manifest lost entries during parse: ${parsed.entries.length} != ${manifest.entries.length}`);
  }
  const ids = new Set(parsed.entries.map(entry => entry.id));
  if (ids.size !== parsed.entries.length) throw new Error('manifest ids are not unique');
  if (parsed.sceneCount !== manifest.sceneCount) {
    throw new Error(`sceneCount mismatch: parsed ${parsed.sceneCount} != manifest ${manifest.sceneCount}`);
  }
  if (parsed.entryCount !== manifest.entryCount) {
    throw new Error(`entryCount mismatch: parsed ${parsed.entryCount} != manifest ${manifest.entryCount}`);
  }
  if (parsed.typeCounts.scene !== manifest.sceneCount) {
    throw new Error(`typeCounts.scene (${parsed.typeCounts.scene}) != sceneCount (${manifest.sceneCount})`);
  }
  const typeSum = Object.values(parsed.typeCounts).reduce((sum, count) => sum + count, 0);
  if (typeSum !== manifest.entryCount) throw new Error(`typeCounts sum (${typeSum}) != entryCount (${manifest.entryCount})`);
  const ratingSum = Object.values(parsed.counts).reduce((sum, count) => sum + count, 0);
  if (ratingSum !== manifest.entryCount) throw new Error(`counts sum (${ratingSum}) != entryCount (${manifest.entryCount})`);
  for (const entry of parsed.entries) {
    const image = entry.image || `images/${entry.id}.jpg`;
    const thumb = entry.thumb || `thumbs/${entry.id}.jpg`;
    for (const [kind, rel] of [['image', image], ['thumb', thumb]]) {
      if (!isShowcaseAssetPath(`/${rel}`)) {
        throw new Error(`asset path not allowlisted: ${entry.id} ${kind}=${rel}`);
      }
      const file = path.join(tempDir, rel.split('/').join(path.sep));
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        throw new Error(`missing approved asset: ${entry.id} ${kind}=${rel}`);
      }
    }
  }
  for (const character of Object.keys(HOME_HERO_SCENES)) {
    const file = path.join(tempDir, 'home', `${character}.jpg`);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      throw new Error(`missing home hero: ${character}.jpg`);
    }
  }
  const heroManifest = path.join(tempDir, 'home-hero.json');
  if (!fs.existsSync(heroManifest)) {
    throw new Error('missing home-hero.json in the target showcase dir');
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(heroManifest, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.entries)) throw new Error('home-hero.json shape invalid');
  } catch (error) {
    throw new Error(`home-hero.json unreadable: ${runtimeErrorMessage(error)}`);
  }
}


async function main() {
  const from = path.resolve(argument('--from', DEFAULT_FROM));
  const reviewPath = path.resolve(argument('--review', path.join(path.dirname(from), 'manual-review.json')));
  const showcaseRoot = path.resolve(argument('--showcase', DEFAULT_SHOWCASE_ROOT));
  const sourceDir = resolveDirArg(showcaseRoot, argument('--source', DEFAULT_SOURCE), '--source', true);
  const targetDir = resolveDirArg(showcaseRoot, argument('--target', DEFAULT_TARGET), '--target', false);
  const python = argument('--python', 'python');
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');

  validateTarget(showcaseRoot, sourceDir, targetDir);

  const { parsePromptScenes }: typeof import('../../src/utils/promptCatalog.ts') = require('../../src/utils/promptCatalog.ts');
  const scenes = parsePromptScenes(readJson(path.join(ROOT, 'data', 'scenes.json')));
  const sceneById = new Map(scenes.map(scene => [scene.id, scene]));
  const records = readJson(from);
  const review = readReview(reviewPath);
  const loraVersions = loadLoraVersions(ROOT);
  const plan = planPublished(review, records);
  assertFullReviewCoverage(plan);
  if (!plan.additions.length) {
    throw new Error('no passing reviewed records to publish — 审核中没有 pass 记录，拒绝发布');
  }

  const additions = plan.additions.map(item => {
    const scene = item.record.sceneId === undefined ? undefined : sceneById.get(item.record.sceneId);
    if (!scene) {
      throw new Error(`published record scene not in data/scenes.json: ${item.record.sceneId}`);
    }
    const entry = buildSceneEntry(scene, item.record, item.review, loraVersions);
    const source = sourcePathFor(item.record, from);
    if (!fs.existsSync(source)) throw new Error(`missing source image for ${item.key}: ${source}`);
    return Object.assign({}, item, { entry, source });
  });

  const coveredSceneIds = new Set(additions.map(item => item.record.sceneId));
  const uncovered = scenes.filter(scene => !coveredSceneIds.has(scene.id)).map(scene => scene.id);
  if (uncovered.length) {
    throw new Error(`every data scene needs a passing record — 未覆盖 ${uncovered.length} 个: ${uncovered.join(', ')}`);
  }

  const sourceManifest = readSourceManifest(readJson(path.join(sourceDir, 'manifest.json')));
  const manifest = buildManifest(sourceManifest, additions, {
    sourceName: path.basename(sourceDir),
    publishedAt: new Date().toISOString(),
  });

  const summary = {
    from,
    review: reviewPath,
    source: sourceDir,
    target: targetDir,
    manifestVersion: manifest.version,
    sceneCount: manifest.sceneCount,
    entryCount: manifest.entryCount,
    typeCounts: manifest.typeCounts,
    counts: manifest.counts,
    additions: additions.map(item => item.entry.id),
    rejected: plan.rejected,
    unreviewed: plan.unreviewed,
  };

  if (!apply) {
    console.log('[dry-run] ' + JSON.stringify(summary, null, 2));
    return;
  }

  const tempDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.building-${process.pid}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  try {
    fs.cpSync(sourceDir, tempDir, { recursive: true });
    // 1) replace every scene image + thumbnail
    for (const item of additions) {
      convertImages(
        python,
        item.source,
        path.join(tempDir, item.entry.image.split('/').join(path.sep)),
        path.join(tempDir, item.entry.thumb.split('/').join(path.sep)),
      );
    }
    // 2) drop legacy scene assets not in data/scenes.json
    for (const kind of ['images', 'thumbs']) {
      const dir = path.join(tempDir, kind);
      const entries = fs.readdirSync(dir);
      for (const name of entries) {
        const match = /^sc(\d{3}|[1-9]\d{3,})\.(?:jpg|png|webp)$/i.exec(name);
        if (match && !sceneById.has(`sc${match[1]}`)) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    }
    // 3) refresh home heroes from the approved scene images
    for (const [character, sceneId] of Object.entries(HOME_HERO_SCENES)) {
      const sourceHero = path.join(tempDir, 'images', `${sceneId}.jpg`);
      const targetHero = path.join(tempDir, 'home', `${character}.jpg`);
      if (!fs.existsSync(sourceHero)) throw new Error(`hero source missing: ${sourceHero}`);
      fs.copyFileSync(sourceHero, targetHero);
    }
    // 4) bump home-hero.json so the home page heroes revalidate (new ?v=)
    const heroManifestPath = path.join(tempDir, 'home-hero.json');
    const heroManifest: unknown = JSON.parse(fs.readFileSync(heroManifestPath, 'utf8'));
    if (!isRecord(heroManifest) || !isRecord(heroManifest.entries)) throw new Error('home-hero.json shape invalid');
    const publishedAt = new Date().toISOString();
    heroManifest.version = Math.max(1, Number(heroManifest.version) || 1) + 1;
    for (const character of Object.keys(HOME_HERO_SCENES)) {
      const entry = heroManifest.entries[character];
      if (entry) {
        if (!isRecord(entry)) throw new Error(`home-hero.json entry invalid: ${character}`);
        entry.updatedAt = publishedAt;
      }
    }
    writeJsonAtomic(heroManifestPath, heroManifest);
    writeJsonAtomic(path.join(tempDir, 'manifest.json'), manifest);
    verifyTarget(tempDir, manifest);
    switchTarget(tempDir, targetDir, force);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  console.log(JSON.stringify(Object.assign(summary, { written: true }), null, 2));
}


if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(errorStack(error));
    process.exitCode = 1;
  });
}
