import type { PathLike } from 'node:fs';

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
}

export interface TagShardFile {
  version: number;
  category: string;
  label?: string;
  tags: TagEntry[];
}

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

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

function cleanDictKey(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/[\s\-/]+/g, '_');
}

export function buildTagDictionary(tags: TagEntry[]): TagDictionaryOutput {
  const meanings: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  for (const tag of tags) {
    if (!tag.en || !tag.cn) continue;
    const norm = cleanDictKey(tag.en);
    meanings[norm] = tag.cn;
    if (Array.isArray(tag.aliases)) {
      for (const alias of tag.aliases) {
        const normAlias = cleanDictKey(alias);
        if (normAlias && normAlias !== norm) {
          aliases[normAlias] = tag.en;
        }
      }
    }
  }
  return { version: 1, meanings, aliases };
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

function writeTextAtomic(source: PathLike, content: string) {
  const target = String(source);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, target);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function readManifest(): TagManifest {
  const manifest = readJson<TagManifest>(manifestPath);
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('data/tags/manifest.json must define a non-empty files array');
  }
  return manifest;
}

export function loadTagShards(): { manifest: TagManifest; sources: Array<{ entry: TagManifestEntry; source: string; tags: TagEntry[] }>; tags: TagEntry[] } {
  const manifest = readManifest();
  const sources = manifest.files.map((entry) => {
    const source = path.join(shardsDir, entry.file);
    const data = readJson<TagShardFile>(source);
    if (!data || !Array.isArray(data.tags)) {
      throw new Error(`${entry.file} root must be { tags: [...] }`);
    }
    return { entry, source, tags: data.tags };
  });
  return { manifest, sources, tags: sources.flatMap((item) => item.tags) };
}

/** 聚合各分类分片 -> data/tags.json 与 data/tags-dictionary.json */
export function writeTagAggregate(): number {
  const { tags } = loadTagShards();
  writeTextAtomic(aggregatePath, jsonText(tags));
  const dict = buildTagDictionary(tags);
  writeTextAtomic(dictionaryPath, jsonText(dict));
  return tags.length;
}

/** 检查 data/tags.json 与 dictionary 聚合结果是否与分片一致 */
export function aggregateIsCurrent(): boolean {
  if (!fs.existsSync(aggregatePath) || !fs.existsSync(manifestPath) || !fs.existsSync(dictionaryPath)) return false;
  try {
    const { tags } = loadTagShards();
    const current = readJson<TagEntry[]>(aggregatePath);
    if (!Array.isArray(current) || current.length !== tags.length) return false;
    const currentDict = readJson<TagDictionaryOutput>(dictionaryPath);
    const expectedDict = buildTagDictionary(tags);
    if (!currentDict || currentDict.version !== expectedDict.version) return false;
    return jsonText(current) === jsonText(tags) && jsonText(currentDict) === jsonText(expectedDict);
  } catch {
    return false;
  }
}

/** 从已有的 data/tags.json 拆分为各分类分片文件（按 Category 分组） */
export function writeTagShards(): number {
  if (!fs.existsSync(aggregatePath)) {
    throw new Error(`Cannot split missing ${aggregatePath}`);
  }
  const tags = readJson<TagEntry[]>(aggregatePath);
  if (!Array.isArray(tags)) {
    throw new Error(`data/tags.json must contain an array of tag entries`);
  }

  if (!fs.existsSync(shardsDir)) {
    fs.mkdirSync(shardsDir, { recursive: true });
  }

  // 按分类分组，保留各自原顺序
  const groups = new Map<string, TagEntry[]>();
  for (const tag of tags) {
    const cat = String(tag.cat || 'Other').trim();
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(tag);
  }

  // 既有 manifest 或默认分类排序
  const manifest: TagManifest = fs.existsSync(manifestPath)
    ? readJson<TagManifest>(manifestPath)
    : {
        version: 1,
        description: '词条分片清单。每个类别一个分片文件，按分类顺序合并为 data/tags.json。',
        files: [],
      };

  const known = new Map<string, TagManifestEntry>(manifest.files.map((entry) => [entry.category, entry]));

  for (const cat of groups.keys()) {
    if (!known.has(cat)) {
      const entry: TagManifestEntry = {
        file: `${categorySlug(cat)}.json`,
        category: cat,
        label: CATEGORY_LABELS[cat] || cat,
      };
      manifest.files.push(entry);
      known.set(cat, entry);
    }
  }

  for (const [cat, items] of groups) {
    const entry = known.get(cat)!;
    const shardContent: TagShardFile = {
      version: 1,
      category: cat,
      label: entry.label || CATEGORY_LABELS[cat] || cat,
      tags: items,
    };
    entry.count = items.length;
    writeTextAtomic(path.join(shardsDir, entry.file), jsonText(shardContent));
  }

  // 清理在聚合中已不存在的分类文件
  for (const entry of [...manifest.files]) {
    if (!groups.has(entry.category)) {
      const file = path.join(shardsDir, entry.file);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      manifest.files.splice(manifest.files.indexOf(entry), 1);
    }
  }

  writeTextAtomic(manifestPath, jsonText(manifest));
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
