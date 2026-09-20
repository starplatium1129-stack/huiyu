import { buildValidatedTagDictionary, validateTagManifest, type TagDictionaryPolicy } from './tag-validation';
import { checkTagPath, writeTagFiles } from './tag-files';

export interface TagEntry {
  id: string;
  cat: string;
  en: string;
  cn: string;
  weight?: number;
  aliases?: string[];
  desc?: string;
  related?: string[];
  [key: string]: unknown;
}

export interface TagManifestEntry {
  file: string;
  category: string;
  label?: string;
  count?: number;
}

export interface TagManifest {
  version?: number;
  description?: string;
  files: TagManifestEntry[];
  dictionary?: TagDictionaryPolicy;
}

export interface TagShardFile {
  version: number;
  category: string;
  label?: string;
  tags: TagEntry[];
}

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const zlib: typeof import('node:zlib') = require('node:zlib');

const root = path.resolve(
  process.env.AICS_DATA_ROOT
    || process.env.AICS_APP_ROOT
    || path.resolve(__dirname, '..', '..'),
);
const dataDir = path.join(root, 'data');
const shardsDir = path.join(dataDir, 'tags');
const manifestPath = path.join(shardsDir, 'manifest.json');
const aggregatePath = path.join(dataDir, 'tags.json');
const dictionaryPath = path.join(dataDir, 'tags-dictionary.json');

export interface TagDictionaryOutput {
  version: number;
  meanings: Record<string, string>;
  aliases: Record<string, string>;
}

export function buildTagDictionary(tags: TagEntry[], policy: TagDictionaryPolicy = {}): TagDictionaryOutput {
  return buildValidatedTagDictionary(tags, policy);
}

const CATEGORY_LABELS: Record<string, string> = {
  Character: '角色',
  Clothing: '服装',
  Action: '动作',
  Emotion: '情绪',
  Appearance: '外观',
  Body: '身体',
  Scene: '场景',
  Lighting: '光照',
  Camera: '镜头',
  Style: '画风',
  Mature: '成人',
};

function categorySlug(category: string): string {
  const cat = String(category || 'other').trim();
  const slug = cat.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'other';
}

function readJson<T = any>(source: string): T {
  return JSON.parse(fs.readFileSync(source, 'utf8'));
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function readManifest(): TagManifest {
  checkTagPath(root, manifestPath);
  const manifest = readJson<TagManifest>(manifestPath);
  validateTagManifest(manifest);
  return manifest;
}

export function loadTagShards(): { manifest: TagManifest; sources: Array<{ entry: TagManifestEntry; source: string; tags: TagEntry[] }>; tags: TagEntry[] } {
  const manifest = readManifest();
  const sources = manifest.files.map((entry) => {
    const source = path.join(shardsDir, entry.file);
    checkTagPath(root, source);
    const data = readJson<TagShardFile>(source);
    if (!data || data.version !== 1 || data.category !== entry.category || !Array.isArray(data.tags)
      || data.tags.length !== entry.count || data.tags.some(tag => !tag || tag.cat !== entry.category)) {
      throw new Error(`${entry.file} version/category/count does not match the manifest`);
    }
    return { entry, source, tags: data.tags };
  });
  const tags = sources.flatMap((item) => item.tags);
  buildTagDictionary(tags, manifest.dictionary);
  return { manifest, sources, tags };
}

/** 聚合各分类分片 -> data/tags.json 与 data/tags-dictionary.json */
export function writeTagAggregate(): number {
  const { tags, manifest } = loadTagShards();
  const dict = buildTagDictionary(tags, manifest.dictionary);
  const products = [{ path: aggregatePath, content: jsonText(tags) }, { path: dictionaryPath, content: jsonText(dict) }];
  // A direct tags:build must never leave old compressed bytes eligible for serving.
  writeTagFiles(root, [...products, ...products.flatMap(file => ['.gz', '.br'].map(suffix => ({ path: file.path + suffix, content: null })))]);
  return tags.length;
}

/** 检查 data/tags.json 与 dictionary 聚合结果是否与分片一致 */
export function aggregateIsCurrent(): boolean {
  if (!fs.existsSync(aggregatePath) || !fs.existsSync(manifestPath) || !fs.existsSync(dictionaryPath)) return false;
  try {
    const { tags, manifest } = loadTagShards();
    checkTagPath(root, aggregatePath);
    checkTagPath(root, dictionaryPath);
    // Existing precompressed responses must describe the same product as JSON.
    for (const product of [aggregatePath, dictionaryPath]) {
      const raw = fs.readFileSync(product);
      for (const suffix of ['.gz', '.br']) {
        const compressed = product + suffix;
        if (!fs.existsSync(compressed)) continue;
        checkTagPath(root, compressed);
        const bytes = fs.readFileSync(compressed);
        const decoded = suffix === '.gz' ? zlib.gunzipSync(bytes) : zlib.brotliDecompressSync(bytes);
        if (!decoded.equals(raw)) return false;
      }
    }
    const current = readJson<TagEntry[]>(aggregatePath);
    if (!Array.isArray(current) || current.length !== tags.length) return false;
    const currentDict = readJson<TagDictionaryOutput>(dictionaryPath);
    const expectedDict = buildTagDictionary(tags, manifest.dictionary);
    if (!currentDict || currentDict.version !== expectedDict.version) return false;
    return jsonText(current) === jsonText(tags) && jsonText(currentDict) === jsonText(expectedDict);
  } catch {
    return false;
  }
}

/** 从已有的 data/tags.json 拆分为各分类分片文件（按 Category 分组） */
export function writeTagShards(): number {
  checkTagPath(root, aggregatePath);
  const tags = readJson<TagEntry[]>(aggregatePath);
  const previous = fs.existsSync(manifestPath) ? readManifest() : null;
  buildTagDictionary(tags, previous?.dictionary);
  const groups = new Map<string, TagEntry[]>();
  for (const tag of tags) {
    const items = groups.get(tag.cat) ?? [];
    items.push(tag);
    groups.set(tag.cat, items);
  }
  const manifest: TagManifest = previous
    ? { ...previous, files: previous.files.filter(entry => groups.has(entry.category)).map(entry => ({ ...entry })) }
    : { version: 1, description: '词条分片清单。按分类顺序合并为 data/tags.json。', files: [] };
  for (const [category, items] of groups) {
    let entry = manifest.files.find(item => item.category === category);
    if (!entry) {
      entry = { file: `${categorySlug(category)}.json`, category, label: CATEGORY_LABELS[category] || category };
      manifest.files.push(entry);
    }
    entry.count = items.length;
  }
  validateTagManifest(manifest);
  const files: Array<{ path: string; content: string | null }> = manifest.files.map(entry => ({
    path: path.join(shardsDir, entry.file),
    content: jsonText({ version: 1, category: entry.category, label: entry.label || entry.category, tags: groups.get(entry.category) }),
  }));
  for (const entry of previous?.files ?? []) {
    if (!groups.has(entry.category)) files.push({ path: path.join(shardsDir, entry.file), content: null });
  }
  files.push({ path: manifestPath, content: jsonText(manifest) });
  for (const file of files) checkTagPath(root, file.path, true);
  fs.mkdirSync(shardsDir, { recursive: true });
  writeTagFiles(root, files);
  return tags.length;
}

export {
  aggregatePath,
  dictionaryPath,
  manifestPath,
  shardsDir,
  categorySlug,
  CATEGORY_LABELS,
  jsonText,
  readJson,
};
