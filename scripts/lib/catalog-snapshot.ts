import fs = require('node:fs');
import path = require('node:path');
type RecordRow = { kind: string; id: string; revision: number; sortOrder: number; createdAt: string | null; updatedAt: string | null; data: any };
/** Build/review reads committed snapshots. Runtime editing uses the native record service. */
function read(root: string): RecordRow[] | null {
  return readDirectory(path.join(root, 'data/catalog'));
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
  const documents = Object.fromEntries(records.filter(r => r.kind === 'document').map(r => [r.id, r.data]));
  const characters = records.filter(r => r.kind === 'character').map(r => r.data);
  const outfits = records.filter(r => r.kind === 'outfit');
  const popular = characters.filter(c => c.popular).map(c => ({ ...c.popular, outfits: outfits.filter(r => r.data.characterId === c.id).map(r => r.data.outfit) }));
  const scenes = records.filter(r => r.kind === 'scene').map(r => ({ ...r.data, sortOrder: r.sortOrder, createdAt: r.createdAt, updatedAt: r.updatedAt }));
  const blueprints = records.filter(r => r.kind === 'blueprint').map(r => r.data);
  return { characters: characters.filter(c => c.profile).map(c => c.profile), popular, scenes, blueprints, documents };
}
function assertLegacyWrite(root: string) {
  if ([path.join(root, 'data/catalog/manifest.json'), path.join(root, 'catalog.identity.json'), path.join(root, 'runtime/content/catalog.identity.json')].some(file => fs.existsSync(file))) throw Error('内容已迁入记录库；请使用场景管理或 content:catalog patch/import，保存后显式 export 项目快照。旧聚合/分片不能回写为主库。');
}
export = { read, readDirectory, views, assertLegacyWrite };
