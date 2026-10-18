#!/usr/bin/env node
import { writeJsonAtomic } from '../lib/atomic-files';
import { errorStack } from '../lib/runtime-errors';
'use strict';

const { switchTarget, cleanMeta, loadLoraVersions, readSourceManifest, resolveDirArg, validateTarget, sourcePathFor }:
  typeof import('../lib/showcase-publication') = require('../lib/showcase-publication');
const { object }: typeof import('../lib/content-history-reader') = require('../lib/content-history-reader');
type PopularRecord = Record<string, unknown> & {
  key: string; recordId: string; characterId: string; blueprintId: string; attempt: number; loraId?: string | null;
};

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
const { convertImages }: typeof import('../lib/showcase-image-conversion') = require('../lib/showcase-image-conversion');

const ROOT = path.resolve(__dirname, '..', '..');
const AI_ROOT = path.resolve(ROOT, '..', 'AI');
const DEFAULT_FROM = path.join(AI_ROOT, 'Reviews', 'ShowcaseRefresh', '2026-08-14_v18-popular-all-rella', 'generation-manifest.json');
const DEFAULT_SHOWCASE_ROOT = path.join(AI_ROOT, 'SceneShowcase');
const DEFAULT_TARGET = '2026-08-15_v22';
const DEFAULT_SOURCE = '2026-08-15_v22';
const DEFAULT_PORTRAITS = path.join(ROOT, 'assets', 'characters');

function argument(name: string, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 只发布审核通过的候选（audit-results.json verdict pass 的最新 attempt）。 */
function loadPassedRecords(from: string, auditPath: string) {
  const records = readJson(from);
  const audit = fs.existsSync(auditPath) ? readJson(auditPath) : {};
  if (!Array.isArray(records) || !records.every(object) || !object(audit)) throw new Error('Invalid candidate manifest or audit results');
  const best = new Map<string, PopularRecord>();
  for (const r of records) {
    if (r.status !== 'succeeded') continue;
    if (typeof r.key !== 'string' || typeof r.recordId !== 'string' || typeof r.characterId !== 'string'
      || typeof r.blueprintId !== 'string' || typeof r.attempt !== 'number' || !Number.isSafeInteger(r.attempt) || r.attempt < 1
      || (r.loraId != null && typeof r.loraId !== 'string')) throw new Error('Invalid succeeded popular candidate');
    const prev = best.get(r.key);
    if (!prev || r.attempt > prev.attempt) best.set(r.key, r as PopularRecord);
  }
  const passed: PopularRecord[] = [];
  for (const rec of best.values()) {
    const entry = audit[rec.recordId];
    if (object(entry) && entry.ok && entry.verdict === 'pass') passed.push(rec);
  }
  passed.sort((a, b) => a.characterId.localeCompare(b.characterId) || a.blueprintId.localeCompare(b.blueprintId));
  return passed;
}

function popularEntry(record: PopularRecord, audit: Record<string, unknown>, loraVersions: Record<string, string>, displayNameByChar: Record<string, string>) {
  const subject = record.characterId;
  const blueprint = record.blueprintId;
  const id = `pc_${subject}_${blueprint}`;
  const displayName = displayNameByChar[subject] || subject;
  const seed = record.actualSeed ?? record.seed;
  const meta: Record<string, unknown> = { engine: record.engine || 'anima', model: record.modelId, checkpoint: record.checkpoint };
  if (record.loraId) { meta.loraId = record.loraId; meta.loraVersion = loraVersions[record.loraId] || ''; }
  if (seed !== undefined && seed !== null && Number.isFinite(Number(seed))) meta.seed = Math.trunc(Number(seed));
  const attempt = record.attempt;
  const reviewed = audit[record.recordId];
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
        notes: object(reviewed) && reviewed.summary ? String(reviewed.summary).slice(0, 120) : '',
        reviewedAt: object(reviewed) && reviewed.inspectedAt ? reviewed.inspectedAt : '',
      },
    },
  };
}

function buildManifest(sourceManifest: ReturnType<typeof readSourceManifest>, popularEntries: ReturnType<typeof popularEntry>[], context: { sourceName: string; publishedAt: string }) {
  const sourceEntries = sourceManifest.entries;
  const incoming = new Set(popularEntries.map(entry => entry.id));
  // 分批发布只替换本批同 ID 的样张，保留其余已发布条目及分级、审核记录。
  const kept = sourceEntries.filter(entry => !incoming.has(entry.id));
  const entries = [...kept, ...popularEntries];
  const typeCounts: Record<string, number> = { scene: 0, artist: 0, popular: 0, lora: 0 };
  for (const entry of entries) if (typeCounts[entry.type] !== undefined) typeCounts[entry.type] += 1;
  const counts = { All: 0, R15: 0, R18: 0 };
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

function verifyTarget(tempDir: string, manifest: ReturnType<typeof buildManifest>) {
  const { parseShowcaseManifest }: typeof import('../../src/utils/showcaseManifest.ts') = require('../../src/utils/showcaseManifest.ts');
  const { isShowcaseAssetPath }: typeof import('../lib/content/showcase-assets.js') = require('../lib/content/showcase-assets.js');
  const parsed = parseShowcaseManifest(manifest);
  if (parsed.entries.length !== manifest.entries.length) throw new Error(`manifest lost entries: ${parsed.entries.length} != ${manifest.entries.length}`);
  const ids = new Set(parsed.entries.map(entry => entry.id));
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


/** 每角色立绘：数据顺序第一张「通过审核 + 竖构图（高>宽）」的 SFW 候选；
 *  无竖图 SFW 时回退竖图任意，再回退数据顺序第一张。 */
function pickPortraits(passed: PopularRecord[], blueprints: unknown) {
  const order = new Map<string, number>();
  const bpList: unknown[] = Array.isArray(blueprints) ? blueprints : object(blueprints) && Array.isArray(blueprints.blueprints) ? blueprints.blueprints : [];
  bpList.forEach((bp, index) => {
    if (!object(bp) || typeof bp.id !== 'string') throw new Error('Invalid portrait blueprint identity');
    order.set(bp.id, index);
  });
  const byCharacter = new Map<string, PopularRecord[]>();
  for (const rec of passed) {
    if (!byCharacter.has(rec.characterId)) byCharacter.set(rec.characterId, []);
    byCharacter.get(rec.characterId)!.push(rec);
  }
  const portraits = new Map<string, PopularRecord>();
  for (const [characterId, list] of byCharacter) {
    const sorter = (a: PopularRecord, b: PopularRecord) => (order.get(a.blueprintId) ?? 999) - (order.get(b.blueprintId) ?? 999);
    const sorted = list.sort(sorter);
    const vertical = (r: PopularRecord) => Number(r.width) > 0 && Number(r.height) > Number(r.width);
    const sfwVertical = sorted.filter(r => !r.adult && vertical(r));
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
  const loraVersions = loadLoraVersions(ROOT);
  const popularData = readJson(path.join(ROOT, 'data', 'popular-characters.json'));
  if (!object(popularData) || !Array.isArray(popularData.characters)) throw new Error('Invalid popular character catalog');
  const displayNameByChar: Record<string, string> = {};
  const characters: unknown[] = popularData.characters;
  for (const character of characters) {
    if (!object(character) || typeof character.id !== 'string'
      || (character.displayName != null && typeof character.displayName !== 'string')) throw new Error('Invalid popular character name');
    displayNameByChar[character.id] = character.displayName || character.id;
  }
  const audit = readJson(auditPath);
  if (!object(audit)) throw new Error('Invalid audit results');
  const entries = passed.map(record => popularEntry(record, audit, loraVersions, displayNameByChar));

  const sourceManifest = readSourceManifest(readJson(path.join(sourceDir, 'manifest.json')));
  const manifest = buildManifest(sourceManifest, entries, {
    sourceName: path.basename(sourceDir),
    publishedAt: new Date().toISOString(),
  });

  const summary = {
    from, source: sourceDir, target: targetDir, portraitsOut,
    sceneCount: manifest.sceneCount, entryCount: manifest.entryCount,
    typeCounts: manifest.typeCounts, counts: manifest.counts,
    popularEntries: entries.length,
    portraits: [...portraits.entries()].map(([c, r]) => `${c} -> ${r.blueprintId}${r.adult ? ' (R18)' : ''}`),
  };
  if (!apply) {
    console.log('[dry-run] ' + JSON.stringify(summary, null, 2));
    return;
  }

  const tempDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.building-${process.pid}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  try {
    fs.cpSync(sourceDir, tempDir, { recursive: true });
    // 1) 源版本资产整体保留，转换器覆盖本批图片。
    for (const record of passed) {
      const entry = entries.find(e => e.provenance.recordId === record.recordId);
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


if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(errorStack(error));
    process.exitCode = 1;
  });
}
