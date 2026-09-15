import type { PathLike } from 'node:fs';

type Blueprint = { characterId?: unknown; [key: string]: unknown };
type BlueprintManifestEntry = { file: string; franchise?: unknown; count?: number };
type BlueprintManifest = { version?: number; files: BlueprintManifestEntry[] };

/**
 * scripts/lib/blueprint-store.js — 热门角色场景蓝图分片存储
 *
 * 数据流（与角色库 data/popular/ 及场景库 data/scenes/ 同构）：
 *   data/blueprints/*.json（按 franchise 系列分片，canonical 语义源）
 *     ── build-blueprints.js ──► data/scene-blueprints.json（浏览器/网关产物）
 *     ◄─ split-blueprints.js ──（从聚合回写分片）
 *
 * 合并顺序 = manifest.files 顺序（franchise 首次出现顺序），聚合产物按系列自然分组；
 * 新增系列/角色场景 = 往对应系列分片文件写入/追加；
 * 聚合产物在网关启动及 CI 中可由 ensure-data-build 自动自愈重建。
 */
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { franchiseSlug, loadPopularShards }: typeof import('./popular-store') = require('./popular-store');

const root = path.resolve(
  process.env.AICS_DATA_ROOT
    || process.env.AICS_APP_ROOT
    || path.resolve(__dirname, '..', '..'),
);
const dataDir = path.join(root, 'data');
const shardsDir = path.join(dataDir, 'blueprints');
const manifestPath = path.join(shardsDir, 'manifest.json');
const aggregatePath = path.join(dataDir, 'scene-blueprints.json');

function readJson(source: string) {
  return JSON.parse(fs.readFileSync(source, 'utf8'));
}

function jsonText(value: { version?: number; blueprints?: unknown; franchise?: unknown; files?: unknown }) {
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

function readManifest() {
  const manifest = readJson(manifestPath);
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('data/blueprints/manifest.json must define a non-empty files array');
  }
  return manifest as BlueprintManifest;
}

function loadBlueprintShards() {
  const manifest = readManifest();
  const sources = manifest.files.map((entry) => {
    const source = path.join(shardsDir, entry.file);
    const data = readJson(source);
    if (!data || !Array.isArray(data.blueprints)) {
      throw new Error(entry.file + ' root must be { blueprints: [...] }');
    }
    return { entry, source, blueprints: data.blueprints as Blueprint[] };
  });
  return { manifest, sources, blueprints: sources.flatMap((item) => item.blueprints) };
}

/** 聚合分片 -> data/scene-blueprints.json（版本保持 2）。 */
function writeBlueprintAggregate() {
  const { blueprints } = loadBlueprintShards();
  writeTextAtomic(aggregatePath, jsonText({ version: 2, blueprints }));
  return blueprints.length;
}

/** --check 用：聚合与分片合并结果逐字节一致才视为最新。 */
function aggregateIsCurrent() {
  if (!fs.existsSync(aggregatePath)) return false;
  const { blueprints } = loadBlueprintShards();
  return fs.readFileSync(aggregatePath, 'utf8') === jsonText({ version: 2, blueprints });
}

/** 聚合 -> 分片（拆解回写）：依据 popular 体系的角色 franchise 归属，
 *  按系列拆分写入 data/blueprints/<franchise-slug>.json。 */
function writeBlueprintShards() {
  const aggregate = readJson(aggregatePath);
  const blueprints = Array.isArray(aggregate.blueprints) ? aggregate.blueprints : [];
  
  // 建立 characterId -> franchise 映射
  const { characters } = loadPopularShards();
  const charToFranchise = new Map(characters.map((c) => [c.id, c.franchise]));

  if (!fs.existsSync(shardsDir)) {
    fs.mkdirSync(shardsDir, { recursive: true });
  }

  // 按 popular/manifest.json 的 franchise 顺序作为基准，保证与 popular-store 顺序完全一致
  const { manifest: popularManifest } = loadPopularShards();
  const franchiseOrder = popularManifest.files.map((f) => f.franchise);

  const manifest = fs.existsSync(manifestPath)
    ? readManifest()
    : {
        version: 1,
        description: '热门角色场景蓝图分片清单。每个 franchise 一个文件，合并为 data/scene-blueprints.json。',
        files: [] as BlueprintManifestEntry[],
      };

  const known = new Map<unknown, BlueprintManifestEntry>(manifest.files.map((entry) => [entry.franchise, entry]));

  const groups = new Map<unknown, Blueprint[]>();
  // 先按 popularManifest 顺序初始化 groups
  for (const f of franchiseOrder) {
    groups.set(f, []);
  }

  for (const bp of blueprints) {
    const franchise = charToFranchise.get(bp.characterId) || 'unknown';
    if (!groups.has(franchise)) groups.set(franchise, []);
    groups.get(franchise)?.push(bp);
  }

  for (const [franchise, items] of groups) {
    if (items.length === 0) continue; // 没有蓝图的 franchise 跳过创建
    if (!known.has(franchise)) {
      const entry = { file: franchiseSlug(franchise) + '.json', franchise };
      manifest.files.push(entry);
      known.set(franchise, entry);
    }
  }

  for (const [franchise, items] of groups) {
    if (items.length === 0) continue;
    let entry = known.get(franchise);
    const expectedFile = franchiseSlug(franchise) + '.json';
    if (!entry) {
      entry = { file: expectedFile, franchise };
      manifest.files.push(entry);
      known.set(franchise, entry);
    } else if (entry.file !== expectedFile) {
      const oldFile = path.join(shardsDir, entry.file);
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      entry.file = expectedFile;
    }
    entry.count = items.length;
    writeTextAtomic(
      path.join(shardsDir, entry.file),
      jsonText({ version: 2, franchise, blueprints: items }),
    );
  }

  // 清理 manifest 声明但聚合中已不存在的系列文件
  for (const entry of [...manifest.files]) {
    const items = groups.get(entry.franchise);
    if (!items || items.length === 0) {
      const file = path.join(shardsDir, entry.file);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      manifest.files.splice(manifest.files.indexOf(entry), 1);
    }
  }

  writeTextAtomic(manifestPath, jsonText(manifest));
  return blueprints.length;
}

export = {
  aggregatePath,
  manifestPath,
  shardsDir,
  aggregateIsCurrent,
  jsonText,
  loadBlueprintShards,
  readJson,
  writeBlueprintAggregate,
  writeBlueprintShards,
};
