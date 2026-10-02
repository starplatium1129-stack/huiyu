'use strict';

// Actual HTTP save + child validators; all content and placeholder assets live in tmp.
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test, after }: typeof import('node:test') = require('node:test');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const zlib: typeof import('node:zlib') = require('node:zlib');
const { createHash }: typeof import('node:crypto') = require('node:crypto');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const express: typeof import('express') = require('express');
const REPO = path.resolve(__dirname, '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-blueprint-save-'));
process.env.AICS_DATA_ROOT = root;
process.env.AICS_APP_ROOT = root;
process.env.AICS_REFERENCE_AUDIT_MODE = 'structure';
for (const key of ['AICS_ASSETS_ROOT', 'AICS_CHARACTER_REF_ROOT', 'AI_WORKSPACE_ROOT']) delete process.env[key];
const { createMaintenanceRouter }: typeof import('../../routes/maintenance') = require('../../routes/maintenance');
const products: typeof import('../../routes/maintenance-content-products') = require('../../routes/maintenance-content-products');
const sceneStore: typeof import('../lib/scene-store') = require('../lib/scene-store');
const blueprintStore: typeof import('../lib/blueprint-store') = require('../lib/blueprint-store');
const popularStore: typeof import('../lib/popular-store') = require('../lib/popular-store');
const { isSceneId }: typeof import('../lib/scene-id') = require('../lib/scene-id');
const read = (name: any) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const write = (name: any, value: any) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n');
const describe = (body: any) => JSON.stringify({ ok: body.ok, error: body.error, conflict: body.conflict, count: body.count }).slice(0, 1600);

function fixtureData(): Record<string, unknown> {
  const canonical = (name: string) => JSON.parse(fs.readFileSync(path.join(REPO, 'data', name), 'utf8'));
  // The real ratings CLI adds these eight historical IDs when absent. Keep their
  // canonical records so saving a neutral edit does not create unrelated scenes.
  const selected = new Set(['sc001', 'sc002', 'sc003', 'sc207', 'sc208', 'sc209', 'sc210', 'sc301', 'sc302', 'sc303', 'sc304']);
  const manifest = canonical('scenes/manifest.json');
  const scenes = manifest.files.flatMap((entry: { file: string }) => {
    const stem = entry.file.replace(/\.json$/, '');
    if (!fs.existsSync(path.join(REPO, 'data/scenes', stem + '.1.json'))) return canonical('scenes/' + entry.file);
    const rows = [];
    for (let batch = 1; fs.existsSync(path.join(REPO, 'data/scenes', `${stem}.${batch}.json`)); batch++) {
      rows.push(...canonical(`scenes/${stem}.${batch}.json`));
    }
    return rows;
  }).filter((scene: { id: string }) => selected.has(scene.id));
  assert.equal(scenes.length, selected.size, 'fixture must include each selected canonical scene');
  const data: Record<string, unknown> = {
    'scenes/manifest.json': manifest,
    'curation.json': { curatedSceneIds: ['sc001'], signatureSceneIds: ['sc001'], reviewSceneIds: [],
      recommendationReasons: { sc001: 'Fixture scene' }, searchAliases: {},
      moodRails: [{ id: 'fixture', title: 'Fixture', query: 'sc001' }] },
    'retired-scenes.json': { version: 1, records: Array.from({ length: 306 }, (_, i) => 'sc' + String(i + 1).padStart(3, '0'))
      .filter(id => !selected.has(id)).map(id => ({ id, reason: 'Outside the isolated transaction fixture' })) },
    'character-reference-view.json': {},
    'tags.json': canonical('tags.json'), 'presets.json': canonical('presets.json'),
  };
  for (const entry of manifest.files) data['scenes/' + entry.file] = scenes.filter((scene: any) => sceneStore.targetFile(scene) === entry.file);
  const pins = canonical('prompt-pinned-scenes.json');
  data['prompt-pinned-scenes.json'] = { ...pins, scenes: Object.fromEntries(Object.entries(pins.scenes).filter(([id]) => selected.has(id))) };
  data['characters.json'] = canonical('characters.json').filter((character: any) => ['nene', 'natsume'].includes(character.id))
    .map((character: any) => ({ ...character, lora: { ...character.lora,
      recommended_scene: scenes.filter((scene: any) => scene.char === character.id).map((scene: any) => scene.id) } }));
  data['loras.json'] = canonical('loras.json').map((lora: any) => ({ ...lora, test_scene: (lora.test_scene || []).filter((id: string) => selected.has(id)) }));

  // Two independent source shards exercise untouched bytes and shard migration.
  // Their twenty authored blueprints also satisfy the unmodified content gate.
  const entries = canonical('popular/manifest.json').files.slice(0, 2);
  const blueprintEntries = [];
  for (const entry of entries) {
    const character = canonical('popular/' + entry.file).characters[0];
    const blueprints = canonical('blueprints/' + entry.file).blueprints.filter((blueprint: any) => blueprint.characterId === character.id);
    data['popular/' + entry.file] = { version: 1, franchise: entry.franchise, characters: [character] };
    data['blueprints/' + entry.file] = { version: 2, franchise: entry.franchise, blueprints };
    blueprintEntries.push({ ...entry, count: blueprints.length });
  }
  data['popular/manifest.json'] = { version: 1, files: entries.map((entry: any) => ({ ...entry, count: 1 })) };
  data['blueprints/manifest.json'] = { version: 1, files: blueprintEntries };
  return data;
}
const seedData = fixtureData();

function seed() {
  for (const name of ['data', 'src', 'runtime']) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  for (const [name, value] of Object.entries(seedData)) {
    fs.mkdirSync(path.dirname(path.join(root, 'data', name)), { recursive: true });
    write('data/' + name, value);
  }
  fs.mkdirSync(path.join(root, 'src/stores'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'scripts/lib/manual-scene-ratings.js'), path.join(root, 'scripts/lib/manual-scene-ratings.js'));
  for (const character of read('data/characters.json')) {
    const relative = String(character.portrait?.image || '').split('?')[0];
    const file = path.resolve(root, 'data', relative);
    assert.ok(file.startsWith(root + path.sep), 'fixture portraits must stay inside tmp');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture placeholder; no image quality assertion');
  }
  sceneStore.writeAggregate(sceneStore.loadSceneShards().scenes);
  popularStore.writePopularAggregate();
  blueprintStore.writeBlueprintAggregate();
  fs.writeFileSync(path.join(root, 'src/stores/sceneStore.ts'), "import { DATA_VERSION } from 'virtual:data-version'; export { DATA_VERSION };\n");
  for (const name of ['scene-blueprints.json', 'scenes.json', 'curation.json']) {
    const raw = fs.readFileSync(path.join(root, 'data', name));
    fs.writeFileSync(path.join(root, 'data', name + '.gz'), zlib.gzipSync(raw));
    fs.writeFileSync(path.join(root, 'data', name + '.br'), zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }));
  }
}

function bytes(dir: any = root, result: any = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'runtime' || entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes(file, result);
    else result[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return result;
}

async function app(run: any, packaged: any = false) {
  const server = express().use(createMaintenanceRouter({
    ROOT_DIR: root, RUNTIME_ROOT: path.join(root, 'runtime'), SCENE_SHOWCASE_DIR: null, DESKTOP_PACKAGED: packaged,
  }).router).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address!() as import('node:net').AddressInfo).port;
  const request = async (url: any, body: any) => {
    const response = await fetch(base + url, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run(request); }
  finally {
    // Responses have settled; close only this fixture's keep-alive connections.
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const stateUrl = '/api/maintenance/scenes-state';
const changesUrl = '/api/maintenance/scenes/changes';
const delta: any = (baseVersion?: any, scenes: any = [], blueprints?: any) => ({ baseVersion, changeSet: {
  version: 1, scenes: { upsert: scenes, remove: [] },
  ...(blueprints ? { blueprints: { upsert: blueprints, remove: [] } } : {}),
} });

test('preview validates changes without creating backups or modifying source/products', async () => {
  seed();
  await app(async (request: any) => {
    const state = (await request(stateUrl)).body;
    const scene = structuredClone(state.snapshot.scenes[0]);
    scene.story += '（隔离编辑）';
    const bp = structuredClone(state.snapshot.blueprints[0]);
    bp.description += '（隔离预览）';
    const before = bytes();
    const result = await request('/api/maintenance/scenes/preview', delta(state.version, [scene], [bp]));
    assert.equal(result.status, 200, describe(result.body));
    assert.deepEqual(result.body.updated, [scene.id]);
    assert.deepEqual(result.body.blueprints.updated, [bp.id]);
    assert.ok(result.body.related.some((item: any) => item.id === scene.id));
    assert.ok(result.body.unknown.length);
    assert.deepEqual(bytes(), before);
    assert.equal(fs.existsSync(path.join(root, 'runtime')), false);
  });
});

test('HTTP blueprint save persists canonical shards, companions and survives fresh-process rebuild', async () => {
  seed();
  await app(async (request: any) => {
    const state = (await request(stateUrl)).body;
    const bp = structuredClone(state.snapshot.blueprints[0]);
    bp.description += ' [office persisted description]';
    const unrelated = blueprintStore.loadBlueprintShards().sources.find(source => !source.blueprints.some(item => item.id === bp.id));
    const untouched = fs.readFileSync(unrelated!.source);
    const result = await request(changesUrl, delta(state.version, [], [bp]));
    assert.equal(result.status, 200, describe(result.body));
    assert.deepEqual(blueprintStore.loadBlueprintShards().blueprints.find(item => item.id === bp.id), bp);
    assert.deepEqual(fs.readFileSync(unrelated!.source), untouched);
    const raw = fs.readFileSync(path.join(root, 'data/scene-blueprints.json'));
    for (const ext of ['gz', 'br']) {
      const packed = fs.readFileSync(path.join(root, 'data/scene-blueprints.json.' + ext));
      assert.deepEqual(ext === 'gz' ? zlib.gunzipSync(packed) : zlib.brotliDecompressSync(packed), raw);
    }
    const rebuilt = spawnSync(process.execPath, ['-e', "require('./scripts/lib/blueprint-store').writeBlueprintAggregate()"], {
      cwd: REPO, env: { ...process.env, AICS_DATA_ROOT: root }, encoding: 'utf8',
    });
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.deepEqual(fs.readFileSync(path.join(root, 'data/scene-blueprints.json')), raw);
    assert.equal((await request(stateUrl)).body.version, result.body.version);
    const backups = fs.readdirSync(path.join(root, 'runtime/maintenance-backups'));
    assert.equal(backups.length, 1, 'one unified backup per save');
  });
});

test('late failure rolls back new/deleted blueprint shards, scenes, metadata and compressed bytes', async () => {
  seed();
  const pop = popularStore.loadPopularShards();
  const character = structuredClone(pop.characters[0]);
  character.id = 'office_fixture'; character.franchise = 'Office Fixture';
  const manifest = read('data/popular/manifest.json');
  manifest.files.push({ file: 'office-fixture.json', franchise: character.franchise, count: 1 });
  write('data/popular/manifest.json', manifest);
  write('data/popular/office-fixture.json', { version: 1, franchise: character.franchise, characters: [character] });
  await app(async (request: any) => {
    const state = (await request(stateUrl)).body;
    const source = blueprintStore.loadBlueprintShards().sources[0];
    // The new fixture character must also own the selected outfit. This test reaches
    // the late injected IO failure rather than stopping at binding validation.
    const moved = source.blueprints.map(bp => ({ ...bp, characterId: character.id, outfitId: character.outfits[0].id }));
    const scene = structuredClone(state.snapshot.scenes[0]); scene.story += ' rollback fixture';
    const before = bytes();
    const refresh = products.refreshCompressedProducts;
    products.refreshCompressedProducts = (...args) => { refresh(...args); throw new Error('injected after companion update'); };
    try {
      const failed = await request(changesUrl, delta(state.version, [scene], moved));
      assert.equal(failed.status, 400);
      assert.match(failed.body.error, /injected/);
      assert.equal(failed.body.dataIntegrity, 'restored');
      assert.deepEqual(bytes(), before);
      assert.equal((await request(stateUrl)).body.version, state.version);
    } finally { products.refreshCompressedProducts = refresh; }
  });
});

test('real content validation failure rolls back a structurally valid but invalid blueprint', async () => {
  seed();
  await app(async (request: any) => {
    const state = (await request(stateUrl)).body;
    const bp = structuredClone(state.snapshot.blueprints[0]);
    bp.description += ' official_cg';
    const before = bytes();
    const failed = await request(changesUrl, delta(state.version, [], [bp]));
    assert.equal(failed.status, 400, describe(failed.body));
    assert.match(failed.body.error, /retrieval metadata/);
    assert.equal(failed.body.dataIntegrity, 'restored');
    assert.deepEqual(bytes(), before);
  });
});

test('concurrent changes share the same lock and reject stale blueprint/source baselines', async () => {
  seed();
  await app(async (request: any) => {
    const state = (await request(stateUrl)).body;
    const bp = state.snapshot.blueprints[0];
    const replies = await Promise.all(['first', 'second'].map(label => request(changesUrl,
      delta(state.version, [], [{ ...bp, description: bp.description + ' ' + label }]))));
    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
    const saved = replies.find(reply => reply.status === 200).body;
    assert.equal((await request(stateUrl)).body.version, saved.version);
    const source = blueprintStore.loadBlueprintShards().sources[0];
    const raw = JSON.parse(fs.readFileSync(source!.source, 'utf8')); raw.blueprints[0].description += ' source-only';
    fs.writeFileSync(source.source, JSON.stringify(raw));
    const readBack = (await request(stateUrl)).body;
    assert.match(readBack.snapshot.blueprints[0].description, /source-only/);
    const stale = await request(changesUrl, delta(saved.version, [], [bp]));
    assert.equal(stale.status, 409);
    assert.notEqual(stale.body.conflict.currentVersion, saved.version);
  });
});

test('sc1000 can be saved, read, retired and never reused; malformed IDs are rejected', async () => {
  seed();
  const retired = read('data/retired-scenes.json');
  for (let number = 307; number <= 999; number++) retired.records.push({ id: 'sc' + number, reason: 'fixture history' });
  write('data/retired-scenes.json', retired);
  await app(async (request: any) => {
    let state = (await request(stateUrl)).body;
    assert.equal(state.nextSceneId, 'sc1000');
    const added = { ...state.snapshot.scenes[0], id: 'sc1000', title: '隔离编号边界' };
    let result = await request(changesUrl, delta(state.version, [added]));
    assert.equal(result.status, 200, describe(result.body));
    assert.ok(result.body.snapshot.scenes.some((scene: any) => scene.id === 'sc1000'));
    state = (await request(stateUrl)).body;
    const removal = delta(state.version); removal.changeSet.scenes.remove = ['sc1000'];
    result = await request(changesUrl, removal);
    assert.equal(result.status, 200, describe(result.body));
    state = (await request(stateUrl)).body;
    assert.equal(state.nextSceneId, 'sc1001');
    assert.equal((await request(changesUrl, delta(state.version, [added]))).status, 400);
    for (const id of ['sc000', 'sc0001', 'sc01', 'sc9007199254740992']) {
      assert.equal(isSceneId(id), false);
      assert.equal((await request(changesUrl, delta(state.version, [{ ...added, id }]))).status, 400);
    }
  });
});

test('pinned fields, invalid removals, mixed payloads and packaged writes stay refused', async () => {
  seed();
  await app(async (request: any) => {
    const state = (await request(stateUrl)).body;
    const pinId = Object.keys(read('data/prompt-pinned-scenes.json').scenes)[0];
    const pinned = structuredClone(state.snapshot.scenes.find((scene: any) => scene.id === pinId));
    pinned.prompt += ' forbidden fixture change';
    const before = bytes();
    assert.equal((await request(changesUrl, delta(state.version, [pinned]))).status, 400);
    const bad = delta(state.version); bad.changeSet.scenes.remove = ['sc999'];
    assert.equal((await request(changesUrl, bad)).status, 400);
    assert.equal((await request(changesUrl, { ...delta(state.version), scenes: state.snapshot.scenes })).status, 400);
    assert.deepEqual(bytes(), before);
  });
  await app(async (request: any) => {
    for (const url of [changesUrl, '/api/maintenance/scenes/preview', '/api/maintenance/scenes/import']) {
      assert.equal((await request(url, delta(1))).status, 501);
    }
  }, true);
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('preview rejects a new outfit binding that does not belong to the character', async () => {
  seed();
  await app(async (request: any) => {
    const state = (await request(stateUrl)).body;
    const bp = { ...state.snapshot.blueprints[0], outfitId: 'missing_fixture_outfit' };
    const before = bytes();
    const result = await request('/api/maintenance/scenes/preview', delta(state.version, [], [bp]));
    assert.equal(result.status, 400, describe(result.body));
    assert.match(result.body.error, /服装不属于/);
    assert.deepEqual(bytes(), before);
    assert.equal(fs.existsSync(path.join(root, 'runtime')), false);
  });
});

test('rollback leaves an unrelated newly created source file untouched', async () => {
  seed();
  await app(async (request: any) => {
    const state = (await request(stateUrl)).body;
    const scene = { ...state.snapshot.scenes[0], story: state.snapshot.scenes[0].story + ' fixture edit' };
    const before = bytes();
    const newFile = path.join(root, 'data/scenes/unrelated-fixture.json');
    const refresh = products.refreshCompressedProducts;
    products.refreshCompressedProducts = (...args) => {
      refresh(...args);
      fs.writeFileSync(newFile, 'unrelated session bytes');
      throw new Error('injected independent new file');
    };
    try {
      const result = await request(changesUrl, delta(state.version, [scene]));
      assert.equal(result.status, 400, describe(result.body));
      assert.equal(result.body.dataIntegrity, 'restored');
      assert.equal(fs.readFileSync(newFile, 'utf8'), 'unrelated session bytes');
      const actual: any = bytes(); delete actual[path.relative(root, newFile)];
      assert.deepEqual(actual, before);
    } finally { products.refreshCompressedProducts = refresh; }
  });
});
