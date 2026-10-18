import { writeTextAtomic } from './atomic-files';
const { object }: typeof import('./content-history-reader') = require('./content-history-reader');

type PopularOutfit = Record<string, unknown> & { id: string; name: string; prose?: string; tokens?: string[];
  default?: boolean; isDefault?: boolean; isNsfw?: boolean };
type PopularCharacter = Record<string, unknown> & { id: string; displayName: string; franchise?: string; originalName?: string;
  identityProse?: string; identityTokens?: string[]; outfits?: PopularOutfit[] };
type PopularManifestEntry = Record<string, unknown> & { file: string; franchise?: string; count?: number };
type PopularManifest = Record<string, unknown> & { version?: number; files: PopularManifestEntry[] };

/** Preserve author fields and legacy isDefault; the UI parser intentionally normalizes them. */
function readCharacters(value: unknown): PopularCharacter[] {
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every(item => typeof item === 'string');
  if (!Array.isArray(value)) throw new Error('Popular characters must be an array');
  return value.map((character: unknown) => {
    if (!object(character) || typeof character.id !== 'string' || typeof character.displayName !== 'string'
      || !['franchise', 'originalName', 'identityProse'].every(key => character[key] === undefined || typeof character[key] === 'string')
      || (character.identityTokens !== undefined && !strings(character.identityTokens))
      || (character.outfits !== undefined && (!Array.isArray(character.outfits)
        || !character.outfits.every((outfit: unknown) => object(outfit) && typeof outfit.id === 'string' && typeof outfit.name === 'string'
          && (outfit.prose === undefined || typeof outfit.prose === 'string')
          && (outfit.tokens === undefined || strings(outfit.tokens))
          && ['default', 'isDefault', 'isNsfw'].every(key => outfit[key] === undefined || typeof outfit[key] === 'boolean'))))) {
      throw new Error('Invalid popular character metadata');
    }
    return character as PopularCharacter;
  });
}

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

function readJson(source: string): unknown {
  return JSON.parse(fs.readFileSync(source, 'utf8'));
}

function jsonText(value: unknown) {
  return JSON.stringify(value, null, 2) + '\n';
}



/** franchise -> 文件名 slug：小写、撇号去掉、其余非字母数字转连字符
 *  （如 "Frieren: Beyond Journey's End" -> frieren-beyond-journeys-end）。 */
function franchiseSlug(franchise: string | undefined) {
  const slug = String(franchise || 'unknown')
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unknown';
}

function readManifest() {
  const manifest = readJson(manifestPath);
  if (!object(manifest) || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('data/popular/manifest.json must define a non-empty files array');
  }
  if ((manifest.version !== undefined && typeof manifest.version !== 'number')
    || !manifest.files.every((entry: unknown) => object(entry) && typeof entry.file === 'string'
      && (entry.franchise === undefined || typeof entry.franchise === 'string')
      && (entry.count === undefined || typeof entry.count === 'number'))) throw new Error('Invalid popular manifest entry');
  return manifest as PopularManifest;
}

function loadPopularShards() {
  const catalog = require('./catalog-snapshot') as typeof import('./catalog-snapshot');
  const records = catalog.read(root);
  if (records) {
    const characters = readCharacters(catalog.views(records).popular);
    const groups = new Map<string, PopularCharacter[]>();
    for (const character of characters) { const key = character.franchise || 'unknown'; if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(character); }
    const sources = [...groups].map(([franchise, characters]) => ({ entry: { file: franchiseSlug(franchise) + '.json', franchise, count: characters.length }, source: path.join(shardsDir, franchiseSlug(franchise) + '.json'), characters }));
    return { manifest: { version: 1, files: sources.map(s => s.entry) }, sources, characters };
  }
  const manifest = readManifest();
  const sources = manifest.files.map((entry) => {
    const source = path.join(shardsDir, entry.file);
    const data = readJson(source);
    if (!object(data) || !Array.isArray(data.characters)) {
      throw new Error(entry.file + ' root must be { characters: [...] }');
    }
    return { entry, source, characters: readCharacters(data.characters) };
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
  (require('./catalog-snapshot') as typeof import('./catalog-snapshot')).assertLegacyWrite(root);
  const aggregate = readJson(aggregatePath);
  if (!object(aggregate) || !Array.isArray(aggregate.characters)) throw new Error('Popular aggregate must contain characters');
  const characters = readCharacters(aggregate.characters);
  const manifest = fs.existsSync(manifestPath)
    ? readManifest()
    : { version: 1, description: '热门角色分片清单。每个 franchise 一个文件，按首次出现顺序合并为 data/popular-characters.json。', files: [] as PopularManifestEntry[] };
  const known = new Map<string | undefined, PopularManifestEntry>(manifest.files.map(entry => [entry.franchise, entry]));

  const groups = new Map<string, PopularCharacter[]>();
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

  for (const [franchise, items] of groups) {
    // Every group was registered above, before any shard is written.
    const entry = known.get(franchise)!;
    const expectedFile = franchiseSlug(franchise) + '.json';
    if (entry.file !== expectedFile) {
      // slug 规则变化导致的改名：清理旧命名文件，manifest 换新名
      const oldFile = path.join(shardsDir, entry.file);
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      entry.file = expectedFile;
    }
    entry.count = items.length;
    writeTextAtomic(path.join(shardsDir, entry.file), jsonText({ version: 1, franchise, characters: items }));
  }

  // 清理 manifest 声明但聚合中已不存在的系列文件
  for (const entry of [...manifest.files]) {
    if (entry.franchise === undefined || !groups.has(entry.franchise)) {
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
  readCharacters,
  readJson,
  writePopularAggregate,
  writePopularShards
};
