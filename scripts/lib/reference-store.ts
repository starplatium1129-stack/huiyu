/** Per-character reference sources; aggregate files remain compatible build products. */
import fs = require('node:fs');
import path = require('node:path');
import io = require('./maintenance-recovery-fs');
const { acquireMaintenanceLease }: typeof import('./maintenance-lease') = require('./maintenance-lease');
const { prepareMaintenanceTransaction, commitMaintenanceTransaction, rollbackMaintenanceTransaction }: typeof import('./maintenance-transaction') = require('./maintenance-transaction');

type RecordData = Record<string, any>;
type Library = { standards: RecordData; view: RecordData };
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const defaultRoot = () => path.resolve(process.env.AICS_DATA_ROOT || process.env.AICS_APP_ROOT || path.join(__dirname, '../..'));
const directory = (root: string) => path.join(root, 'data/references');
const products = (root: string) => ['character-reference-standards.json', 'character-reference-view.json'].map(name => path.join(root, 'data', name));
const read = (file: string) => JSON.parse(io.readBytes(file, false)!.toString('utf8'));
function validId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z0-9_]+$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) throw new Error(`Invalid reference character ID: ${String(id)}`);
}
function uniqueIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) throw new Error('Reference manifest IDs must be arrays');
  ids.forEach(validId);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate reference character ID');
  return ids;
}
function validateLibrary({ standards, view }: Library) {
  if (!Array.isArray(standards?.characters) || !Array.isArray(standards?.perspectives) || !view || Array.isArray(view)) throw new Error('Invalid reference library');
  const ids = uniqueIds(standards.characters.map((entry: RecordData) => entry.id));
  const viewIds = uniqueIds(Object.keys(view));
  if (ids.length !== viewIds.length || ids.some(id => !Object.hasOwn(view, id))) throw new Error('Reference standards/view character sets differ');
  for (const character of standards.characters) {
    const profile = view[character.id];
    if (profile?.characterId !== character.id || !Array.isArray(character.outfits) || !Array.isArray(profile.outfits)) throw new Error(`Invalid reference profile: ${character.id}`);
    // Keep existing content verbatim; stricter semantic/schema checks remain in the contract gate.
  }
}
export function loadReferenceShards(root = defaultRoot()): Library {
  const manifest = read(path.join(directory(root), 'manifest.json'));
  if (manifest.version !== 1 || !manifest.standards || Object.hasOwn(manifest.standards, 'characters')) throw new Error('Invalid reference manifest');
  const ids = uniqueIds(manifest.characterIds);
  const viewIds = uniqueIds(manifest.viewOrder);
  if (ids.length !== viewIds.length || viewIds.some(id => !ids.includes(id))) throw new Error('Reference manifest orders differ');
  const records = new Map(ids.map(id => {
    const record = read(path.join(directory(root), `${id}.json`));
    if (record.standard?.id !== id || record.view?.characterId !== id) throw new Error(`Reference shard ID mismatch: ${id}`);
    return [id, record];
  }));
  const expectedFiles = new Set(['manifest.json', ...ids.map(id => `${id}.json`)]);
  for (const name of fs.readdirSync(directory(root))) {
    if (name.endsWith('.json') && !expectedFiles.has(name)) throw new Error(`Unregistered reference shard: ${name}`);
  }
  const library = {
    standards: { ...manifest.standards, characters: ids.map(id => records.get(id).standard) },
    view: Object.fromEntries(viewIds.map(id => [id, records.get(id).view])),
  };
  validateLibrary(library);
  return library;
}
/** Legacy isolated fixtures may still supply the two aggregate inputs. */
export function readReferenceLibrary(root = defaultRoot()): Library {
  if (fs.existsSync(path.join(directory(root), 'manifest.json'))) return loadReferenceShards(root);
  const [standardsFile, viewFile] = products(root);
  const library = { standards: read(standardsFile), view: read(viewFile) };
  validateLibrary(library);
  return library;
}
export function aggregateIsCurrent(root = defaultRoot()) {
  const { standards, view } = loadReferenceShards(root);
  return products(root).every((file, index) => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === json(index ? view : standards));
}
function productEntries(root: string, library: Library): Array<[string, string]> {
  return products(root).map((file, index) => [file, json(index ? library.view : library.standards)]);
}
function writeEntries(entries: Array<[string, string]>) {
  for (const [file, content] of entries) {
    if (fs.existsSync(file) && io.readBytes(file)!.toString('utf8') === content) continue;
    io.atomicWrite(file, content, true);
    // Old compressed companions must never hide a newly written JSON.
    for (const ext of ['.br', '.gz']) if (io.safePath(file + ext)) fs.unlinkSync(file + ext);
  }
}
export function writeReferenceAggregate(root = defaultRoot()) {
  const library = loadReferenceShards(root);
  writeEntries(productEntries(root, library));
  return library.standards.characters.length as number;
}
/** Used by all legacy writers as well as registration: one source, rollback on failure. */
export function writeReferenceLibrary(root: string, standards: RecordData, view: RecordData) {
  validateLibrary({ standards, view });
  const { characters, ...metadata } = standards;
  const entries: Array<[string, string]> = characters.map((standard: RecordData) => [path.join(directory(root), `${standard.id}.json`), json({ standard, view: view[standard.id] })]);
  entries.push([path.join(directory(root), 'manifest.json'), json({ version: 1, standards: metadata, characterIds: characters.map((c: RecordData) => c.id), viewOrder: Object.keys(view) })]);
  entries.push(...productEntries(root, { standards, view }));
  const obsolete = fs.existsSync(directory(root)) ? fs.readdirSync(directory(root)).filter(name => name.endsWith('.json') && !entries.some(([file]) => file === path.join(directory(root), name))).map(name => path.join(directory(root), name)) : [];
  const changed = entries.filter(([file, content]) => !fs.existsSync(file) || io.readBytes(file)!.toString('utf8') !== content);
  if (!changed.length && !obsolete.length) return { changed: 0 };
  const options = { rootDir: root };
  const lease = acquireMaintenanceLease(options);
  try {
    const files = [...changed.map(([file]) => file), ...obsolete];
    for (const file of [...files]) for (const ext of ['.br', '.gz']) if (io.safePath(file + ext)) files.push(file + ext);
    prepareMaintenanceTransaction(lease, options, io.snapshotFiles(files), 'reference-sources');
    writeEntries(changed);
    for (const file of obsolete) { io.safePath(file, 'file', false); fs.unlinkSync(file); }
    commitMaintenanceTransaction(lease);
    return { changed: changed.length + obsolete.length };
  } catch (error) {
    const rollback = rollbackMaintenanceTransaction(lease, options);
    if (!rollback.ok) throw new Error(`Reference write failed; recovery required: ${rollback.error}`, { cause: error });
    throw error;
  }
}
