import fs = require('node:fs');
import path = require('node:path');
type RecordRow = { kind: string; id: string; revision: number; sortOrder: number; createdAt: string | null; updatedAt: string | null; data: any };
function canonical(value: any): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
const SLIM_DEFERRED_PORTRAIT = /^popular-[a-z0-9_-]+\.(?:png|jpe?g|webp)$/i;
function isSlimResourceGateway(root: string): boolean {
  const layersFile = path.join(root, 'resource-layers.json');
  if (!fs.existsSync(layersFile)) return false;
  try {
    const layers = JSON.parse(fs.readFileSync(layersFile, 'utf8'));
    return layers?.kind === 'desktop-resource-layers' && layers?.profile === 'slim';
  } catch {
    return false;
  }
}
/** Build/review reads committed snapshots. Runtime editing uses the native record service. */
function read(root: string): RecordRow[] | null {
  const records = readDirectory(path.join(root, 'data/catalog'));
  const policyFile = path.join(root, 'data/prompt-pinned-scenes.json');
  if (records && fs.existsSync(policyFile)) {
    const pinned = records.find(record => record.kind === 'document' && record.id === 'prompt-pinned-scenes');
    if (!pinned || canonical(pinned.data) !== canonical(JSON.parse(fs.readFileSync(policyFile, 'utf8')))) {
      throw Error('CATALOG_PIN_CONFLICT: 项目内容快照与定稿保护基线不一致；拒绝构建或同步，请先从正确工作库恢复并定向导出。');
    }
  }
  if (records) {
    const slimDeferred = isSlimResourceGateway(root);
    const assetRoot = path.resolve(root, 'assets/characters');
    const thumbRoot = path.resolve(assetRoot, 'thumbs');
    for (const record of records) {
      if (record.kind !== 'character') continue;
      const image = record.data?.profile?.portrait?.image;
      if (typeof image !== 'string' || !image.startsWith('../assets/characters/')) continue;
      const relative = image.split('?')[0].slice('../assets/characters/'.length);
      const asset = path.resolve(assetRoot, relative);
      const hasOriginal = asset.startsWith(assetRoot + path.sep) && fs.existsSync(asset) && fs.statSync(asset).isFile();
      if (hasOriginal) continue;
      if (slimDeferred && SLIM_DEFERRED_PORTRAIT.test(relative)) {
        const thumb = path.resolve(thumbRoot, relative.replace(/\.[^.]+$/, '.webp'));
        if (thumb.startsWith(thumbRoot + path.sep) && fs.existsSync(thumb) && fs.statSync(thumb).isFile()) {
          continue;
        }
      }
      throw Error(`CATALOG_PORTRAIT_MISSING: ${record.id} 指向不存在的立绘 ${image}；请补齐素材或使用 portrait-pending.svg。`);
    }
  }
  return records;
}
function readDirectory(directory: string): RecordRow[] | null {
  const manifestFile = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw Error('Catalog snapshot manifest is invalid');
  const seen = new Set<string>();
  return manifest.files.map((file: unknown) => {
    if (typeof file !== 'string' || !file.endsWith('.json') || file.includes('\\') || file.includes(':') || file.split('/').some(p => !p || p.startsWith('.'))) throw Error('Catalog snapshot path is invalid');
    const resolved = path.resolve(directory, file);
    if (!resolved.startsWith(path.resolve(directory) + path.sep)) throw Error('Catalog snapshot path escapes its directory');
    const record: RecordRow = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!['character', 'outfit', 'scene', 'blueprint', 'document'].includes(record.kind) || !record.id || !Number.isSafeInteger(record.revision) || !Number.isSafeInteger(record.sortOrder) || seen.has(record.kind + ':' + record.id)) throw Error('Catalog record key/revision is invalid');
    seen.add(record.kind + ':' + record.id);
    return record;
  }).sort((a: RecordRow, b: RecordRow) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}
function views(records: RecordRow[]) {
  const documents: Record<string, RecordRow['data']> = {};
  const characters: RecordRow['data'][] = [];
  const outfitsByCharacter = new Map<RecordRow['data'], RecordRow['data'][]>();
  const scenes: RecordRow['data'][] = [];
  const blueprints: RecordRow['data'][] = [];
  for (const record of records) {
    if (record.kind === 'document') documents[record.id] = record.data;
    else if (record.kind === 'character') characters.push(record.data);
    else if (record.kind === 'outfit') {
      const list = outfitsByCharacter.get(record.data.characterId);
      if (list) list.push(record.data.outfit);
      else outfitsByCharacter.set(record.data.characterId, [record.data.outfit]);
    } else if (record.kind === 'scene') {
      scenes.push({ ...record.data, sortOrder: record.sortOrder, createdAt: record.createdAt, updatedAt: record.updatedAt });
    } else if (record.kind === 'blueprint') {
      blueprints.push(record.data);
    }
  }
  const profiles: RecordRow['data'][] = [];
  const popular: RecordRow['data'][] = [];
  for (const c of characters) {
    if (c.profile) profiles.push(c.profile);
    if (c.popular) {
      popular.push({
        ...c.popular,
        portraitPending: c.profile?.portrait?.image === '../assets/characters/portrait-pending.svg',
        outfits: outfitsByCharacter.get(c.id) ?? [],
      });
    }
  }
  return { characters: profiles, popular, scenes, blueprints, documents };
}
function assertLegacyWrite(root: string) {
  if ([path.join(root, 'data/catalog/manifest.json'), path.join(root, 'catalog.identity.json'), path.join(root, 'runtime/content/catalog.identity.json')].some(file => fs.existsSync(file))) throw Error('内容已迁入记录库；请使用场景管理或 content:catalog patch/import，保存后显式 export 项目快照。旧聚合/分片不能回写为主库。');
}
export = { read, views, assertLegacyWrite };
