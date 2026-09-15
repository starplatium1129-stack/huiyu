import type { PathLike } from 'node:fs';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const root = path.resolve(
  process.env.AICS_DATA_ROOT
    || process.env.AICS_APP_ROOT
    || path.resolve(__dirname, '..', '..'),
);
const dataDir = path.join(root, 'data');
const shardsDir = path.join(dataDir, 'scenes');
const manifestPath = path.join(shardsDir, 'manifest.json');
const aggregatePath = path.join(dataDir, 'scenes.json');
const browserShardPath = {
  nene: path.join(dataDir, 'scenes-nene.json'),
  natsume: path.join(dataDir, 'scenes-natsume.json'),
  shared: path.join(dataDir, 'scenes-shared.json')
};
type CharacterKey = keyof typeof browserShardPath;
const corePath = path.join(dataDir, 'scenes-core.json');
const indexPath = path.join(dataDir, 'scenes-index.json');

/** 单批默认场景数；可由 manifest 根级 batchSize 或条目级 batchSize 覆盖。 */
const DEFAULT_BATCH_SIZE = 50;

type Scene = { id: unknown; char?: string; category?: unknown; [key: string]: unknown };
type SceneManifestEntry = { file: string; batchSize?: unknown };
type SceneManifest = { files: SceneManifestEntry[]; batchSize?: unknown };
type BrowserGroups = { nene: Scene[]; natsume: Scene[]; shared: Scene[] };

function readJson(source: string) {
  return JSON.parse(fs.readFileSync(source, 'utf8'));
}

function jsonText(value: unknown) {
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

function sceneNumber(scene: { id: unknown; }) {
  const match = String(scene && scene.id || '').match(/^sc(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function sortScenes(scenes: Scene[]) {
  return [...scenes].sort((left, right) => sceneNumber(left) - sceneNumber(right));
}

function readManifest() {
  const manifest = readJson(manifestPath);
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('data/scenes/manifest.json must define a non-empty files array');
  }
  return manifest as SceneManifest;
}

/** 解析该分片组每批上限：条目级 > manifest 根级 > 默认 50。 */
function batchSizeFor(manifest: SceneManifest, entry?: SceneManifestEntry) {
  if (entry && Number.isFinite(Number(entry.batchSize)) && Number(entry.batchSize) > 0) return Number(entry.batchSize);
  if (manifest && Number.isFinite(Number(manifest.batchSize)) && Number(manifest.batchSize) > 0) return Number(manifest.batchSize);
  return DEFAULT_BATCH_SIZE;
}

/** 展开某分片组为实际源文件列表：存在 base.1.json 时按批次序号加载，
 *  否则回退到单文件 base.json。批次文件由 writeSceneShards 按 batchSize 自动维护。 */
function expandShardFiles(entry: SceneManifestEntry) {
  const base = entry.file.replace(/\.json$/, '');
  const first = path.join(shardsDir, base + '.1.json');
  if (fs.existsSync(first)) {
    const files = [];
    for (let i = 1; ; i++) {
      const candidate = path.join(shardsDir, base + '.' + i + '.json');
      if (!fs.existsSync(candidate)) break;
      files.push(base + '.' + i + '.json');
    }
    return files;
  }
  return [entry.file];
}

function loadSceneShards() {
  const manifest = readManifest();
  const sources = manifest.files.flatMap((entry) =>
    expandShardFiles(entry).map((file) => {
      const source = path.join(shardsDir, file);
      const scenes = readJson(source);
      if (!Array.isArray(scenes)) throw new Error(file + ' root must be an array');
      return { entry, source, file, scenes };
    })
  );
  return { manifest, sources, scenes: sortScenes(sources.flatMap((item) => item.scenes as Scene[])) };
}

function targetFile(scene: Scene) {
  if (scene.char === 'triad') return 'shared.json';
  const suffix = /After_Story/i.test(String(scene.category || '')) ? 'after-story' : 'core';
  if (scene.char === 'nene' || scene.char === 'natsume') return scene.char + '-' + suffix + '.json';
  throw new Error((scene.id || 'unknown scene') + ': cannot choose shard for char=' + scene.char);
}

/** 把单个分片组按 batchSize 写入，超批自动切成 base.N.json；不足一批回退为 base.json。
 *  同时清理过期形态（多余批次文件 / 与批次并存的单文件），保持目录与 manifest 声明一致。 */
function writeShardBatches(manifest: SceneManifest, baseFile: string, items: Scene[]) {
  const entry = manifest.files.find((item) => item.file === baseFile);
  const batchSize = batchSizeFor(manifest, entry);
  const base = baseFile.replace(/\.json$/, '');
  const sorted = sortScenes(items);
  const chunks = [];
  for (let i = 0; i < sorted.length; i += batchSize) {
    chunks.push(sorted.slice(i, i + batchSize));
  }
  const written = new Set();
  if (chunks.length <= 1) {
    writeTextAtomic(path.join(shardsDir, baseFile), jsonText(items));
    written.add(baseFile);
  } else {
    chunks.forEach((chunk, index) => {
      const file = base + '.' + (index + 1) + '.json';
      writeTextAtomic(path.join(shardsDir, file), jsonText(chunk));
      written.add(file);
    });
  }
  // 清理：过期的批次文件，以及切批后遗留的单文件形态
  const prefix = base + '.';
  for (const name of fs.readdirSync(shardsDir)) {
    if (name === 'manifest.json') continue;
    const isThisGroup = name === baseFile || (name.startsWith(prefix) && /\.\d+\.json$/.test(name));
    if (!isThisGroup) continue;
    if (!written.has(name)) {
      fs.unlinkSync(path.join(shardsDir, name));
    }
  }
}

function writeSceneShards(scenes: Scene[]) {
  const manifest = readManifest();
  const groups = new Map<string, Scene[]>();
  manifest.files.forEach((entry) => groups.set(entry.file, []));
  for (const scene of sortScenes(scenes)) {
    const file = targetFile(scene);
    if (!groups.has(file)) throw new Error('manifest does not declare shard ' + file);
    groups.get(file)?.push(scene);
  }
  for (const [file, items] of groups) {
    writeShardBatches(manifest, file, items);
  }
}

function readCuration() {
  try {
    const curation = readJson(path.join(dataDir, 'curation.json'));
    return curation && typeof curation === 'object' ? curation : {};
  } catch (error) {
    return {};
  }
}

function tierIds(curation: { [x: string]: unknown; }, key: string) {
  const ids = curation && Array.isArray(curation[key]) ? curation[key] : [];
  return ids.filter((id) => typeof id === 'string').slice(0, 2000);
}

function groupBrowserShards(scenes: Scene[]) {
  const groups: BrowserGroups = { nene: [], natsume: [], shared: [] };
  const seen = new Set();
  for (const scene of sortScenes(scenes)) {
    if (!scene || !scene.id) continue;
    const char = scene.char === 'natsume' ? 'natsume' : (scene.char === 'triad' ? 'shared' : 'nene');
    if (seen.has(scene.id)) continue;
    seen.add(scene.id);
    groups[char as CharacterKey].push(scene);
  }
  return groups;
}

function writeBrowserShards(scenes: Scene[]) {
  const groups = groupBrowserShards(scenes);
  for (const char of Object.keys(groups) as CharacterKey[]) {
    writeTextAtomic(browserShardPath[char], jsonText(groups[char]));
  }
  return groups;
}

function writeCoreAndIndex(scenes: Scene[], curation: unknown, groups: BrowserGroups) {
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const coreIds = tierIds((curation && typeof curation === 'object' ? curation : {}) as Record<string, unknown>, 'personaCoreSceneIds').filter((id) => byId.has(id));
  writeTextAtomic(corePath, jsonText(coreIds.map((id) => byId.get(id) as Scene)));

  const index = {
    version: 1,
    total: scenes.length,
    shards: {
      nene: { file: 'scenes-nene.json', count: groups.nene.length },
      natsume: { file: 'scenes-natsume.json', count: groups.natsume.length },
      shared: { file: 'scenes-shared.json', count: groups.shared.length }
    },
    tiers: {
      core: coreIds
    },
    orderedIds: sortScenes(scenes).map((scene) => scene.id)
  };
  writeTextAtomic(indexPath, jsonText(index));
}

function writeAggregate(scenes: Scene[]) {
  const sorted = sortScenes(scenes);
  writeTextAtomic(aggregatePath, jsonText(sorted));
  const groups = writeBrowserShards(sorted);
  writeCoreAndIndex(sorted, readCuration(), groups);
}

function writeSceneSet(scenes: Scene[]) {
  writeSceneShards(scenes);
  writeAggregate(scenes);
}

function aggregateIsCurrent(scenes: Scene[]) {
  const sorted = sortScenes(scenes);
  if (!fs.existsSync(aggregatePath)) return false;
  if (fs.readFileSync(aggregatePath, 'utf8') !== jsonText(sorted)) return false;
  const expected = groupBrowserShards(sorted);
  for (const char of Object.keys(expected) as CharacterKey[]) {
    // 产物自 2026-08-28 起不入库，部分缺失（fresh clone/半删除）一律视为"非最新"，
    // 交给自愈重建，而不是让调用方在读文件时崩掉
    if (!fs.existsSync(browserShardPath[char])) return false;
    if (fs.readFileSync(browserShardPath[char], 'utf8') !== jsonText(expected[char])) return false;
  }
  // 校验 core / index 时先写入内存版本再比较磁盘，避免 --check 污染文件
  const byId = new Map(sorted.map((scene) => [scene.id, scene]));
  const curation = readCuration();
  const coreIds = tierIds(curation, 'personaCoreSceneIds').filter((id) => byId.has(id));
  if (!fs.existsSync(corePath)) return false;
  if (fs.readFileSync(corePath, 'utf8') !== jsonText(coreIds.map((id) => byId.get(id)))) return false;
  const index = {
    version: 1,
    total: sorted.length,
    shards: {
      nene: { file: 'scenes-nene.json', count: expected.nene.length },
      natsume: { file: 'scenes-natsume.json', count: expected.natsume.length },
      shared: { file: 'scenes-shared.json', count: expected.shared.length }
    },
    tiers: { core: coreIds },
    orderedIds: sorted.map((scene) => scene.id)
  };
  if (!fs.existsSync(indexPath)) return false;
  return fs.readFileSync(indexPath, 'utf8') === jsonText(index);
}

export = {
  aggregatePath,
  browserShardPath,
  corePath,
  indexPath,
  shardsDir,
  batchSizeFor,
  expandShardFiles,
  jsonText,
  loadSceneShards,
  readJson,
  sortScenes,
  targetFile,
  writeAggregate,
  writeSceneSet,
  writeSceneShards,
  writeTextAtomic,
  aggregateIsCurrent
};
