import type { PathLike } from 'node:fs';

type PopularCharacter = { id?: any; franchise?: any; [key: string]: any };
type PopularManifestEntry = { file: string; franchise?: any; count?: number };
type PopularManifest = { version?: number; files: PopularManifestEntry[] };

/**
 * scripts/lib/popular-store.js — 热门角色分片存储
 *
 * 数据流（与场景库同构）：
 *   data/popular/*.json（按 franchise 一个系列一个文件，canonical 源）
 *     ── build-popular.js ──► data/popular-characters.json（浏览器产物）
 *     ◄─ split-popular.js ──（从聚合回写分片）
 *
 * 合并顺序 = manifest.files 顺序（首次出现顺序），因此聚合产物按系列分组；
 * 新增角色 = 往对应系列文件追加；新增系列 = 新建文件 + manifest 追加条目（split 会自动补）。
 */
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const root = path.resolve(
  process.env.AICS_DATA_ROOT
    || process.env.AICS_APP_ROOT
    || path.resolve(__dirname, '..', '..'),
);
const dataDir = path.join(root, 'data');
const shardsDir = path.join(dataDir, 'popular');
const manifestPath = path.join(shardsDir, 'manifest.json');
const aggregatePath = path.join(dataDir, 'popular-characters.json');

function readJson(source: string) {
  return JSON.parse(fs.readFileSync(source, 'utf8'));
}

function jsonText(value: any) {
  return JSON.stringify(value, null, 2) + '\n';
}

function writeTextAtomic(source: PathLike, content: string) {
  const target = String(source);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, target);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (cleanupError) {}
    throw error;
  }
}

/** franchise -> 文件名 slug：小写、撇号去掉、其余非字母数字转连字符
 *  （如 "Frieren: Beyond Journey's End" -> frieren-beyond-journeys-end）。 */
function franchiseSlug(franchise: any) {
  const slug = String(franchise || 'unknown')
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unknown';
}

function readManifest() {
  const manifest = readJson(manifestPath);
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('data/popular/manifest.json must define a non-empty files array');
  }
  return manifest as PopularManifest;
}

function loadPopularShards() {
  const manifest = readManifest();
  const sources = manifest.files.map((entry) => {
    const source = path.join(shardsDir, entry.file);
    const data = readJson(source);
    if (!data || !Array.isArray(data.characters)) {
      throw new Error(entry.file + ' root must be { characters: [...] }');
    }
    return { entry, source, characters: data.characters as PopularCharacter[] };
  });
  return { manifest, sources, characters: sources.flatMap((item) => item.characters) };
}

/** 聚合分片 -> data/popular-characters.json（版本字段保持 1）。 */
function writePopularAggregate() {
  const { characters } = loadPopularShards();
  writeTextAtomic(aggregatePath, jsonText({ version: 1, characters }));
  return characters.length;
}

/** --check 用：聚合与分片合并结果逐字节一致才视为最新。 */
function aggregateIsCurrent() {
  if (!fs.existsSync(aggregatePath)) return false;
  const { characters } = loadPopularShards();
  return fs.readFileSync(aggregatePath, 'utf8') === jsonText({ version: 1, characters });
}

/** 聚合 -> 分片（覆盖写入）：按 franchise 分组保持组内顺序，
 *  manifest 按首次出现顺序维护；聚合中已消失的系列文件会被清理。 */
function writePopularShards() {
  const aggregate = readJson(aggregatePath);
  const characters = Array.isArray(aggregate.characters) ? aggregate.characters : [];
  const manifest = fs.existsSync(manifestPath)
    ? readManifest()
    : { version: 1, description: '热门角色分片清单。每个 franchise 一个文件，按首次出现顺序合并为 data/popular-characters.json。', files: [] as PopularManifestEntry[] };
  const known = new Map<any, PopularManifestEntry>(manifest.files.map((entry) => [entry.franchise, entry]));

  const groups = new Map<any, PopularCharacter[]>();
  for (const character of characters) {
    const franchise = character.franchise || 'unknown';
    if (!groups.has(franchise)) groups.set(franchise, []);
    groups.get(franchise)?.push(character);
  }

  for (const franchise of groups.keys()) {
    if (!known.has(franchise)) {
      const entry = { file: franchiseSlug(franchise) + '.json', franchise };
      manifest.files.push(entry);
      known.set(franchise, entry);
    }
  }

  const written = new Set();
  for (const [franchise, items] of groups) {
    let entry = known.get(franchise);
    const expectedFile = franchiseSlug(franchise) + '.json';
    if (!entry) {
      entry = { file: expectedFile, franchise };
      manifest.files.push(entry);
      known.set(franchise, entry);
    } else if (entry.file !== expectedFile) {
      // slug 规则变化导致的改名：清理旧命名文件，manifest 换新名
      const oldFile = path.join(shardsDir, entry.file);
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      entry.file = expectedFile;
    }
    entry.count = items.length;
    writeTextAtomic(path.join(shardsDir, entry.file), jsonText({ version: 1, franchise, characters: items }));
    written.add(entry.file);
  }

  // 清理 manifest 声明但聚合中已不存在的系列文件
  for (const entry of [...manifest.files]) {
    if (!groups.has(entry.franchise)) {
      const file = path.join(shardsDir, entry.file);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      manifest.files.splice(manifest.files.indexOf(entry), 1);
    }
  }

  writeTextAtomic(manifestPath, jsonText(manifest));
  return characters.length;
}

export = {
  aggregatePath,
  manifestPath,
  shardsDir,
  aggregateIsCurrent,
  franchiseSlug,
  jsonText,
  loadPopularShards,
  readJson,
  writePopularAggregate,
  writePopularShards
};
