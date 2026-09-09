#!/usr/bin/env node
'use strict';

/**
 * Publish visually-approved candidate records into a NEW showcase version dir.
 *
 * Source of truth:
 *   - candidate generation-manifest.json (generate-showcase-candidates.js output,
 *     kept in AI/Reviews/ShowcaseRefresh/<round>/generation-manifest.json)
 *   - manual-review.json next to it with the shape:
 *       { version: <number>, reviewedAt: <iso string>,
 *         records: { <candidate key>: { verdict: 'pass'|'fail', recordId, notes? } } }
 *
 * Gates (a missing or malformed gate fails even in dry-run — this tool never
 * publishes mechanically-succeeded records without a human pass):
 *   - manual-review.json must exist and parse.
 *   - review keys must exist in the candidate manifest; verdicts must be
 *     pass|fail; a pass record must carry a recordId that resolves to a
 *     `succeeded` manifest record of the SAME key.
 *   - candidate recordIds must be unique.
 *   - EVERY `succeeded` manifest key must appear in the review; a single
 *     unreviewed succeeded key fails the whole run (no partial publishes).
 *   - only pass records are published; fail verdicts are reported in the
 *     summary.
 *
 * Build:
 *   - assembles a sibling temp dir next to the target, copies the source
 *     showcase dir wholesale, adds a compressed big image + a real thumbnail per
 *     approved record (Pillow via convert-showcase-image.py → the production
 *     save_jpeg), writes the new manifest, fully verifies, then renames the temp
 *     dir onto the target name (atomic switch). Any failure removes the temp dir.
 *   - never writes into the source dir. An existing target is only replaced
 *     with --force and only when it carries a manifest.json: the old target is
 *     renamed aside to a sibling backup, the freshly built temp dir is renamed
 *     onto the target name, and only then is the backup removed — any failure
 *     restores the backup, so the previous version survives until the new one
 *     is fully built and verified.
 *
 * Contract:
 *   - sceneCount keeps its meaning of "number of scene entries";
 *     entryCount + typeCounts are added.
 *   - counts = rating counts across ALL entries.
 *   - manifest version 4.
 *
 * Dry-run by default: pass --apply to actually build.
 *
 * Usage:
 *   node scripts/maintenance/publish-showcase-refresh.js \
 *       [--from <generation-manifest>] [--review <manual-review.json>] \
 *       [--target <name|dir>] [--source <name|dir>] [--showcase <root>] \
 *       [--python <python>] [--force] [--apply]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const AI_ROOT = path.resolve(ROOT, '..', 'AI');
const DEFAULT_FROM = path.join(
  AI_ROOT,
  'Reviews',
  'ShowcaseRefresh',
  '2026-08-12_artist_popular_latest-lora',
  'generation-manifest.json',
);
const DEFAULT_SHOWCASE_ROOT = path.join(AI_ROOT, 'SceneShowcase');
const DEFAULT_TARGET = '2026-08-12_v15';
const DEFAULT_SOURCE = '2026-07-22_v14';

const IMAGE_BOX = '1800x2400';
const IMAGE_QUALITY = 94;
const THUMB_BOX = '480x640';
const THUMB_QUALITY = 85;

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
function cleanMeta(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== null && String(v) !== ''),
  );
}
function shortTitle(displayName, fallback) {
  if (!displayName) return fallback;
  const first = String(displayName).split(' (')[0];
  return first || String(displayName);
}
function safeSegment(value, fallback) {
  const cleaned = String(value === undefined || value === null ? fallback : value)
    .replace(/[^a-z0-9_]/gi, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

/**
 * 解析并校验 manual-review.json 的结构。缺文件 / 非 JSON / 字段错一
 * 律抛错 —— 校验不通过时 dry-run 也一样失败。
 */
function parseReviewData(value) {
  if (!isRecord(value)) throw new Error('manual-review.json must be an object with {version, reviewedAt, records}');
  if (!Number.isFinite(Number(value.version))) {
    throw new Error('manual-review.json must carry a numeric version');
  }
  if (typeof value.reviewedAt !== 'string' || !value.reviewedAt.trim()) {
    throw new Error('manual-review.json must carry reviewedAt');
  }
  if (!isRecord(value.records)) throw new Error('manual-review.json must carry a records map');
  const records = {};
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
    if (record.notes !== undefined && typeof record.notes !== 'string') {
      throw new Error(`review record "${key}" notes must be a string`);
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

function readReview(reviewPath) {
  let raw;
  try {
    raw = fs.readFileSync(reviewPath, 'utf8');
  } catch (error) {
    throw new Error(`manual review file missing: ${reviewPath} — 人工审核未完成，拒绝发布`);
  }
  try {
    return parseReviewData(JSON.parse(raw));
  } catch (error) {
    throw new Error(`manual review invalid: ${reviewPath} — ${error.message}`);
  }
}

/**
 * 把审核结论映射到候选记录。只发布明确 pass 且 recordId 对应 succeeded 记录；
 * 缺审 / fail / 结构错误一律不发布（结构错误直接抛错）。
 */
function planPublished(review, records) {
  if (!Array.isArray(records)) throw new Error('candidate manifest must be an array');
  const byRecordId = new Map();
  const byKey = new Map();
  for (const record of records) {
    const rid = record.recordId || `${record.key}@attempt-${record.attempt || 1}`;
    if (byRecordId.has(rid)) {
      throw new Error(`duplicate recordId in candidate manifest: ${rid}`);
    }
    byRecordId.set(rid, record);
    if (!record.key) continue;
    if (!byKey.has(record.key)) byKey.set(record.key, []);
    byKey.get(record.key).push(record);
  }
  for (const key of Object.keys(review.records)) {
    if (!byKey.has(key)) throw new Error(`review key not in candidate manifest: ${key}`);
  }
  const additions = [];
  const rejected = [];
  for (const [key, verdict] of Object.entries(review.records)) {
    if (verdict.verdict === 'fail') {
      rejected.push(key);
      continue;
    }
    const record = byRecordId.get(verdict.recordId);
    if (!record) {
      throw new Error(`review pass recordId not in candidate manifest: ${key} -> ${verdict.recordId}`);
    }
    if (record.status !== 'succeeded') {
      throw new Error(`review pass record is not succeeded: ${key} -> ${verdict.recordId} (${record.status})`);
    }
    if (record.key !== key) {
      throw new Error(`review pass recordId belongs to a different key: ${key} -> ${verdict.recordId} (${record.key})`);
    }
    additions.push({ key, record, review: verdict });
  }
  const reviewedKeys = new Set(Object.keys(review.records));
  const unreviewed = [];
  for (const [key, list] of byKey) {
    if (!list.some(item => item.status === 'succeeded')) continue;
    if (!reviewedKeys.has(key)) unreviewed.push(key);
  }
  additions.sort((a, b) => a.key.localeCompare(b.key));
  return { additions, rejected, unreviewed };
}

/** 完整审核门禁：succeeded key 必须全部出现在人工审核里，否则拒绝发布（防部分发布）。 */
function assertFullReviewCoverage(plan) {
  if (plan.unreviewed.length) {
    throw new Error(
      `manual review must cover every succeeded key — 未审核 ${plan.unreviewed.length} 个: ${plan.unreviewed.join(', ')}`,
    );
  }
}

/** 构造发布条目。ID 稳定安全：artist_<artistId|baseline> / pc_<subject> / lora_<char>_<engine>_<comp>。 */
function entryForRecord({ record, review, key }, loraVersions) {
  const batch = record.batch;
  let id;
  let char;
  let category;
  let type;
  if (batch === 'artist') {
    const artistId = safeSegment(record.artistId, 'baseline');
    id = `artist_${artistId}`;
    char = artistId;
    category = '画师风格';
    type = 'artist';
  } else if (batch === 'popular') {
    const subject = safeSegment(record.subject || record.characterId, key);
    const blueprint = record.blueprintId ? safeSegment(record.blueprintId, '') : '';
    id = blueprint ? `pc_${subject}_${blueprint}` : `pc_${subject}`;
    char = subject;
    category = record.adult ? '成人' : '热门角色';
    type = 'popular';
  } else if (batch === 'latest-lora') {
    const characterId = safeSegment(record.characterId, 'nene');
    const engine = safeSegment(record.engine, 'sd');
    const composition = safeSegment(record.sceneId, 'fullbody');
    id = `lora_${characterId}_${engine}_${composition}`;
    char = characterId;
    category = 'LoRA 样张';
    type = 'lora';
  } else {
    throw new Error(`unsupported batch ${JSON.stringify(batch)} for key ${key}`);
  }
  const seed = record.actualSeed ?? record.seed;
  const meta = { engine: record.engine, model: record.modelId, checkpoint: record.checkpoint };
  if (record.loraId) {
    meta.loraId = record.loraId;
    meta.loraVersion = (loraVersions && loraVersions[record.loraId]) || '';
  }
  if (seed !== undefined && seed !== null && Number.isFinite(Number(seed))) meta.seed = Math.trunc(Number(seed));
  const attempt = Math.max(1, Number(record.attempt) || 1);
  const entry = {
    id,
    title: shortTitle(record.displayName, id),
    story: '',
    category,
    char,
    rating: record.adult ? 'R18' : 'All',
    attempt,
    type,
    image: `images/${id}.jpg`,
    thumb: `thumbs/${id}.jpg`,
    meta: cleanMeta(meta),
    prompt: record.prompt || '',
    negative: record.negative || '',
    provenance: {
      batch,
      key,
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
  if (record.displayName) entry.displayName = String(record.displayName);
  return { entry, id };
}

/** 合并 source 场景条目与新发布条目，重算场景/条目/类型/分级计数。 */
function buildManifest(sourceManifest, additions, context) {
  const sourceEntries = (sourceManifest.entries || [])
    .filter(entry => isRecord(entry))
    .map(entry => (entry.type ? entry : Object.assign({}, entry, { type: 'scene' })));
  const incoming = new Set(additions.map(entry => entry.id));
  const entries = [...sourceEntries.filter(entry => !incoming.has(entry.id)), ...additions];
  const typeCounts = { scene: 0, artist: 0, popular: 0, lora: 0 };
  for (const entry of entries) {
    if (typeCounts[entry.type] !== undefined) typeCounts[entry.type] += 1;
  }
  const counts = { All: 0, R15: 0, R18: 0 };
  for (const entry of entries) {
    const rating = entry.rating === 'R15' || entry.rating === 'R18' ? entry.rating : 'All';
    counts[rating] += 1;
  }
  const manifest = {
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
  if (Array.isArray(sourceManifest.sheets) && sourceManifest.sheets.length) {
    manifest.sheets = sourceManifest.sheets;
  }
  return manifest;
}

function resolveDirArg(showcaseRoot, value, label, mustExist) {
  const raw = value || '';
  const explicitPath = path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw);
  const candidate = explicitPath
    ? path.resolve(raw)
    : path.join(path.resolve(showcaseRoot), raw);
  if (mustExist) {
    if (!fs.existsSync(candidate)) throw new Error(`${label} does not exist: ${candidate}`);
    if (!fs.existsSync(path.join(candidate, 'manifest.json'))) {
      throw new Error(`${label} has no manifest.json: ${candidate}`);
    }
  }
  return path.resolve(candidate);
}

function isSameOrChild(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * target 安全校验：
 *   - 不得等于 showcase root 或 source。
 *   - 不得与 source 相互包含（父/子关系一律拒绝）。
 *   - 位于 root 内时只允许 root 的直接子目录（命名/默认发布）。
 *   - root 外的绝对 target（测试逃生口）至少不得包含 source 或 root。
 */
function validateTarget(showcaseRoot, sourceDir, targetDir) {
  const root = path.resolve(showcaseRoot);
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  if (target === source) {
    throw new Error(`--target must not equal --source: ${source}`);
  }
  if (target === root) {
    throw new Error('--target must not be the showcase root');
  }
  if (isSameOrChild(target, source) || isSameOrChild(source, target)) {
    throw new Error(`--target must not contain or be contained by --source: source=${source}, target=${target}`);
  }
  if (isSameOrChild(target, root)) {
    if (path.dirname(target) !== root) {
      throw new Error(`--target must be a direct child of the showcase root: ${target}`);
    }
    return target;
  }
  if (isSameOrChild(root, target)) {
    throw new Error(`absolute --target must not contain --source or the showcase root: ${target}`);
  }
  return target;
}

function sourcePathFor(record, from) {
  const rel = record.image || '';
  if (!rel) throw new Error(`succeeded record has no image: ${record.recordId || record.key}`);
  const label = record.recordId || record.key;
  const unsafe =
    path.isAbsolute(rel) ||
    /^[a-zA-Z]:/.test(rel) ||
    rel.startsWith('/') ||
    rel.startsWith('\\') ||
    rel.includes('\\') ||
    rel.includes('..') ||
    /[?#]/.test(rel) ||
    rel.includes('%');
  if (unsafe) {
    throw new Error(`unsafe image path for ${label}: ${JSON.stringify(rel)}`);
  }
  const fromDir = path.resolve(path.dirname(from));
  const resolved = path.resolve(fromDir, rel.split('/').join(path.sep));
  if (resolved !== fromDir && !resolved.startsWith(fromDir + path.sep)) {
    throw new Error(`image path escapes the candidate directory for ${label}: ${JSON.stringify(rel)}`);
  }
  return resolved;
}

function loadLoraVersions() {
  try {
    const loras = readJson(path.join(ROOT, 'data', 'loras.json'));
    const list = Array.isArray(loras) ? loras : (loras.data || []);
    const versions = {};
    for (const lora of list) {
      if (lora && lora.id && lora.version !== undefined) versions[lora.id] = String(lora.version);
    }
    return versions;
  } catch (error) {
    return {};
  }
}

function convertImages(python, sourceFile, imageOut, thumbOut) {
  const result = spawnSync(python, [
    path.join(ROOT, 'scripts', 'maintenance', 'convert-showcase-image.py'),
    sourceFile,
    imageOut,
    thumbOut,
    '--image-box', IMAGE_BOX,
    '--image-quality', String(IMAGE_QUALITY),
    '--thumb-box', THUMB_BOX,
    '--thumb-quality', String(THUMB_QUALITY),
  ], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (result.error) throw new Error(`image conversion could not run (${python}): ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`image conversion failed for ${sourceFile}:\n${result.stderr || result.stdout || 'unknown error'}`);
  }
  for (const out of [imageOut, thumbOut]) {
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
      throw new Error(`image conversion produced no output: ${out}`);
    }
  }
}

/** 完整验证：manifest 可被生产解析器接受、计数自洽、id 唯一、资产存在且符合白名单。 */
function verifyTarget(tempDir, manifest, additions) {
  const { parseShowcaseManifest } = require('../../src/utils/showcaseManifest.ts');
  const { isShowcaseAssetPath } = require('../../server/showcase-assets.js');
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
  for (const addition of additions) {
    const entry = addition.entry;
    for (const [kind, rel] of [['image', entry.image], ['thumb', entry.thumb]]) {
      const file = path.join(tempDir, rel.split('/').join(path.sep));
      if (!fs.existsSync(file)) throw new Error(`missing published asset: ${entry.id} ${kind}=${rel}`);
    }
  }
}

/**
 * 原子替换：不先删旧 target。temp 必须已经完整构建并验证过（调用方保证）。
 * target 存在时要求 --force 且 target 自带 manifest.json，然后 rename target→sibling
 * backup、rename temp→target；任一步失败恢复 backup；全部成功后删除 backup。
 * renameSync/rmSync 可注入以便测试模拟失败。
 */
function switchTarget(tempDir, targetDir, force, renameSync = fs.renameSync, rmSync = fs.rmSync) {
  const backupDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.backup-${process.pid}`);
  const targetExists = fs.existsSync(targetDir);
  if (targetExists) {
    if (!force) throw new Error(`target already exists: ${targetDir} (use --force to overwrite)`);
    if (!fs.existsSync(path.join(targetDir, 'manifest.json'))) {
      throw new Error(`refusing to replace an existing target without manifest.json: ${targetDir}`);
    }
    rmSync(backupDir, { recursive: true, force: true });
    renameSync(targetDir, backupDir);
  }
  try {
    renameSync(tempDir, targetDir);
  } catch (error) {
    if (targetExists) {
      try {
        renameSync(backupDir, targetDir);
      } catch (restoreError) {
        error.message = `${error.message}\n  additionally failed to restore backup ${backupDir}: ${restoreError.message}`;
      }
    }
    throw error;
  }
  if (targetExists) {
    rmSync(backupDir, { recursive: true, force: true });
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

  const records = readJson(from);
  const review = readReview(reviewPath);
  const loraVersions = loadLoraVersions();
  const plan = planPublished(review, records);
  assertFullReviewCoverage(plan);
  if (!plan.additions.length) {
    throw new Error('no passing reviewed records to publish — 审核中没有 pass 记录，拒绝发布');
  }

  // 校验每个 pass 记录源图存在（dry-run 也执行，确保计划真实可发布）。
  const additions = plan.additions.map(item => {
    const built = entryForRecord(item, loraVersions);
    const source = sourcePathFor(item.record, from);
    if (!fs.existsSync(source)) throw new Error(`missing source image for ${item.key}: ${source}`);
    return Object.assign({}, built, { source });
  });

  const sourceManifest = readJson(path.join(sourceDir, 'manifest.json'));
  const manifest = buildManifest(sourceManifest, additions.map(item => item.entry), {
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
    additions: additions.map(item => item.id),
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
    for (const item of additions) {
      convertImages(
        python,
        item.source,
        path.join(tempDir, item.entry.image.split('/').join(path.sep)),
        path.join(tempDir, item.entry.thumb.split('/').join(path.sep)),
      );
    }
    writeJsonAtomic(path.join(tempDir, 'manifest.json'), manifest);
    verifyTarget(tempDir, manifest, additions);
    switchTarget(tempDir, targetDir, force);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  console.log(JSON.stringify(Object.assign(summary, { written: true }), null, 2));
}

module.exports = {
  parseReviewData,
  readReview,
  planPublished,
  assertFullReviewCoverage,
  entryForRecord,
  buildManifest,
  resolveDirArg,
  validateTarget,
  sourcePathFor,
  convertImages,
  verifyTarget,
  switchTarget,
  cleanMeta,
  shortTitle,
  argument,
  constants: {
    ROOT,
    AI_ROOT,
    DEFAULT_FROM,
    DEFAULT_SHOWCASE_ROOT,
    DEFAULT_TARGET,
    DEFAULT_SOURCE,
    IMAGE_BOX,
    IMAGE_QUALITY,
    THUMB_BOX,
    THUMB_QUALITY,
  },
};

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}
