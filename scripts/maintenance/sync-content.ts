/** Validate canonical content first; explicitly apply metadata repairs and derived builds. */
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('content:sync [--apply] [--ids=a,b] [--root=directory]\nDefault: validate and preview without writing. --ids limits pending reference registration; all content is validated and rebuilt.');
    return;
  }
  for (const arg of args) if (!['--apply', '--dry-run'].includes(arg) && !arg.startsWith('--root=') && !arg.startsWith('--ids=')) throw new Error(`Unknown option: ${arg}`);
  if (args.includes('--apply') && args.includes('--dry-run')) throw new Error('--apply and --dry-run cannot be combined');
  const root = path.resolve(args.find(a => a.startsWith('--root='))?.slice(7) || process.env.AICS_DATA_ROOT || process.env.AICS_APP_ROOT || path.resolve(__dirname, '../..'));
  process.env.AICS_DATA_ROOT = root;
  const data = path.join(root, 'data');
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors: string[] = [];
  const repairs: { file: string; value: any; changes: string[] }[] = [];
  function manifest(kind: string) {
    const file = path.join(data, kind, 'manifest.json');
    const value = read(file);
    if (!Array.isArray(value.files) || !value.files.length) throw new Error(`${kind}: empty manifest`);
    const seen = new Set<string>();
    for (const entry of value.files) {
      if (typeof entry.file !== 'string' || !/^[a-zA-Z0-9_-]+\.json$/.test(entry.file) || entry.file === 'manifest.json') throw new Error(`${kind}: unsafe manifest path ${entry.file}`);
      if (seen.has(entry.file)) errors.push(`${kind}: duplicate manifest file ${entry.file}`);
      seen.add(entry.file);
      // Reject symlinks as well as lexical traversal before store readers access the file.
      const directory = fs.realpathSync(path.join(data, kind));
      const source = path.join(directory, entry.file);
      if (fs.existsSync(source) && path.dirname(fs.realpathSync(source)) !== directory) throw new Error(`${kind}: shard escapes directory ${entry.file}`);
    }
    if (kind !== 'scenes') {
      const owners = value.files.map((entry: any) => entry.franchise);
      if (new Set(owners).size !== owners.length) errors.push(`${kind}: duplicate franchise in manifest`);
      for (const name of fs.readdirSync(path.join(data, kind))) {
        if (name.endsWith('.json') && name !== 'manifest.json' && !seen.has(name)) errors.push(`${kind}: unregistered shard ${name}; add it to manifest.files`);
      }
    }
    return { file, value };
  }
  const pm = manifest('popular');
  const bm = manifest('blueprints');
  const sm = manifest('scenes');
  const sceneDirectory = fs.realpathSync(path.join(data, 'scenes'));
  // The scene reader expands numbered batches; validate those before following them.
  for (const entry of sm.value.files) {
    const stem = entry.file.slice(0, -5);
    const batches = fs.readdirSync(sceneDirectory).filter(name => name.startsWith(`${stem}.`) && /\.\d+\.json$/.test(name));
    for (const file of batches) if (path.dirname(fs.realpathSync(path.join(sceneDirectory, file))) !== sceneDirectory) throw new Error(`scenes: shard escapes directory ${file}`);
    if (batches.length) {
      for (let i = 1; i <= batches.length; i++) if (!batches.includes(`${stem}.${i}.json`)) errors.push(`scenes: missing batch ${stem}.${i}.json`);
      if (fs.existsSync(path.join(sceneDirectory, entry.file))) errors.push(`scenes: single file and batches coexist for ${entry.file}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const popular: typeof import('../lib/popular-store') = require('../lib/popular-store');
  const blueprints: typeof import('../lib/blueprint-store') = require('../lib/blueprint-store');
  const sceneStore: typeof import('../lib/scene-store') = require('../lib/scene-store');
  const p = popular.loadPopularShards();
  const b = blueprints.loadBlueprintShards();
  const s = sceneStore.loadSceneShards();
  function unique(items: any[], label: string) {
    const ids = new Set<string>();
    for (const item of items) {
      if (typeof item.id !== 'string' || !item.id.trim()) errors.push(`${label}: missing ID`);
      else if (ids.has(item.id)) errors.push(`${label}: duplicate ID ${item.id}`);
      ids.add(item.id);
    }
    return ids;
  }
  const profiles = read(path.join(data, 'characters.json'));
  if (!Array.isArray(profiles)) throw new Error('characters.json must be an array');
  const profileIds = unique(profiles, 'characters.json');
  const characterIds = unique(p.characters, 'popular');
  unique(b.blueprints, 'blueprints');
  unique(s.scenes, 'scenes');
  const byId = new Map(p.characters.map(c => [c.id, c]));
  for (const character of p.characters) {
    if (!profileIds.has(character.id)) errors.push(`${character.id}: missing characters.json profile`);
    if (!Array.isArray(character.outfits)) errors.push(`${character.id}: outfits must be an array`);
    else unique(character.outfits, `${character.id} outfits`);
  }
  for (const bp of b.blueprints) {
    const owner = byId.get(bp.characterId);
    if (!owner) errors.push(`${bp.id}: unknown characterId ${bp.characterId}`);
    else if (bp.outfitId && !owner.outfits?.some((o: any) => o.id === bp.outfitId)) errors.push(`${bp.id}: unknown outfitId ${bp.outfitId}`);
  }
  for (const [kind, set, meta, field] of [
    ['popular', p.sources, pm, 'characters'], ['blueprints', b.sources, bm, 'blueprints'],
  ] as const) {
    const changes: string[] = [];
    for (const source of set) {
      const shard = read(source.source);
      if (!source.entry.franchise || shard.franchise !== source.entry.franchise) errors.push(`${kind}/${source.entry.file}: franchise differs from manifest`);
      const items: any[] = shard[field];
      for (const item of items) {
        const franchise = kind === 'popular' ? item.franchise : byId.get(item.characterId)?.franchise;
        if (franchise !== source.entry.franchise) errors.push(`${kind}/${source.entry.file}: ${item.id} belongs to ${franchise}`);
      }
      const entry = meta.value.files.find((e: any) => e.file === source.entry.file);
      if (entry.count !== items.length) { changes.push(`${entry.file}: ${entry.count} -> ${items.length}`); entry.count = items.length; }
    }
    if (changes.length) repairs.push({ file: meta.file, value: meta.value, changes });
  }
  for (const source of s.sources) {
    if (path.dirname(fs.realpathSync(source.source)) !== fs.realpathSync(sceneStore.shardsDir)) errors.push(`scenes: shard escapes directory ${source.file}`);
    for (const scene of source.scenes) {
      if (sceneStore.targetFile(scene) !== source.entry.file) errors.push(`${scene.id}: incorrect scene shard ${source.file}`);
    }
  }
  const idsArg = args.find(a => a.startsWith('--ids='));
  if (idsArg) {
    const ids = idsArg.slice(6).split(',').map(id => id.trim()).filter(Boolean);
    if (!ids.length) errors.push('--ids must not be empty');
    for (const id of ids) if (!characterIds.has(id)) errors.push(`Unknown selected character: ${id}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  // Run the same registration preflight before *any* metadata or aggregate writes.
  function register(dryRun: boolean) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'register-pending-reference-outfits.js'), ...(dryRun ? ['--dry-run'] : []), ...(idsArg ? [idsArg] : [])], { env: { ...process.env, AICS_DATA_ROOT: root }, encoding: 'utf8' });
    if (result.status !== 0 || result.error) throw new Error(result.error?.message || result.stderr || result.stdout || 'Reference registration failed');
    if (result.stdout) process.stdout.write(result.stdout);
  }
  register(true);
  console.log(`[content:sync] Validated ${p.characters.length} characters, ${b.blueprints.length} blueprints, ${s.scenes.length} scenes`);
  for (const repair of repairs) console.log(`[content:sync] Count repair: ${repair.changes.join(', ')}`);
  if (!args.includes('--apply')) { console.log('[content:sync] Preview only: no files written. Use --apply to register pending references and rebuild derived data.'); return; }
  register(false);
  for (const repair of repairs) sceneStore.writeTextAtomic(repair.file, popular.jsonText(repair.value));
  popular.writePopularAggregate();
  blueprints.writeBlueprintAggregate();
  sceneStore.writeAggregate(s.scenes);
  const references: typeof import('../lib/reference-store') = require('../lib/reference-store');
  references.writeReferenceAggregate(root);
  const { refreshPrecompressed }: typeof import('../lib/ensure-data-build') = require('../lib/ensure-data-build');
  refreshPrecompressed([popular.aggregatePath, blueprints.aggregatePath, sceneStore.aggregatePath,
    ...Object.values(sceneStore.browserShardPath), sceneStore.corePath, sceneStore.indexPath]);
  console.log('[content:sync] Applied manifest counts, reference registration and all content aggregates. Pending records are not rendered assets.');
}

try { main(); } catch (error) { console.error(`[content:sync] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }

export {};
