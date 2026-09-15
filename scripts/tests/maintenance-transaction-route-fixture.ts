import { errorCode as runtimeErrorCode } from '../lib/runtime-errors';
'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const zlib: typeof import('node:zlib') = require('node:zlib');
const { fork }: typeof import('node:child_process') = require('node:child_process');
const { once }: typeof import('node:events') = require('node:events');
const { VERSIONED_FILES }: typeof import('../lib/data-version') = require('../lib/data-version');

function seed() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-recovery-http-'));
  function write(name, value) {
    const file = path.join(rootDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  }
  const scenes = [{ id: 'sc001', title: 'Neutral fixture', story: 'A neutral room', char: 'nene', category: '日常', series: 'core', rating: 'All', mature: false, prompt: 'plain studio portrait', negative: '' }];
  for (const name of VERSIONED_FILES) write('data/' + name, []);
  write('data/scenes/manifest.json', { version: 1, batchSize: 1, files: [{ file: 'nene-core.json', character: 'nene', series: 'core' }] });
  write('data/scenes/nene-core.json', scenes);
  write('data/scenes.json', scenes);
  write('data/curation.json', { curatedSceneIds: ['sc001'], signatureSceneIds: [], reviewSceneIds: [], recommendationReasons: {} });
  write('data/retired-scenes.json', { records: [] });
  write('data/prompt-pinned-scenes.json', { scenes: {} });
  const blueprints = ['a', 'b'].map((key, index) => ({ id: 'fixture_' + key, title: 'Neutral ' + key, characterId: ['alpha', 'beta'][index],
    category: 'neutral', description: 'fixture', promptTokens: [], negativeTokens: [], promptProse: 'a plain neutral room' }));
  write('data/blueprints/manifest.json', { version: 1, files: ['a', 'b'].map(key => ({ file: 'fixture-' + key + '.json', franchise: 'Fixture ' + key.toUpperCase(), count: 1 })) });
  for (const [index, key] of ['a', 'b'].entries()) write('data/blueprints/fixture-' + key + '.json', { version: 2, franchise: 'Fixture ' + key.toUpperCase(), blueprints: [blueprints[index]] });
  write('data/scene-blueprints.json', { version: 2, blueprints });
  const characters = ['alpha', 'beta', 'gamma'].map((id, index) => ({ id, displayName: id, franchise: 'Fixture ' + ['A', 'B', 'C'][index], outfits: [] }));
  write('data/popular/manifest.json', { version: 1, files: characters.map((character, index) => ({ file: 'fixture-' + ['a', 'b', 'c'][index] + '.json', franchise: character.franchise, count: 1 })) });
  for (const [index, character] of characters.entries()) write('data/popular/fixture-' + ['a', 'b', 'c'][index] + '.json', { version: 1, franchise: character.franchise, characters: [character] });
  write('data/popular-characters.json', { characters });
  fs.mkdirSync(path.join(rootDir, 'src/stores'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'src/stores/sceneStore.ts'), 'export const DATA_VERSION = 0;\n');
  fs.writeFileSync(path.join(rootDir, 'data/untouched.txt'), 'do not modify these unrelated bytes\r\n');
  for (const name of ['scenes.json', 'scene-blueprints.json', 'blueprints/fixture-b.json']) {
    const bytes = fs.readFileSync(path.join(rootDir, 'data', name));
    fs.writeFileSync(path.join(rootDir, 'data', name + '.gz'), zlib.gzipSync(bytes));
    fs.writeFileSync(path.join(rootDir, 'data', name + '.br'), zlib.brotliCompressSync(bytes));
  }
  return { options: { rootDir, runtimeRoot: path.join(rootDir, 'runtime') }, scenes, blueprints, write, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

async function start(fixture, mode = 'success') {
  const child = fork(__filename, [fixture.options.rootDir, mode], { silent: true, windowsHide: true });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const closed = once(child, 'exit');
  const [message] = await Promise.race([once(child, 'message'), closed.then(([code]) => { throw new Error('HTTP fixture exited ' + code + ': ' + errors); })]);
  const base = 'http://127.0.0.1:' + message.port;
  return {
    child, message, closed,
    async request(url, body, headers = {}) {
      const response = await fetch(base + url, body === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; },
  };
}

async function serve(rootDir, mode) {
  process.env.AICS_DATA_ROOT = rootDir;
  process.env.AICS_APP_ROOT = rootDir;
  const express: typeof import('express') = require('express');
  const io: typeof import('../lib/maintenance-recovery-fs') = require('../lib/maintenance-recovery-fs');
  const leaseOptions = { rootDir, runtimeRoot: path.join(rootDir, 'runtime') };
  const { maintenanceReadToken }: typeof import('../lib/maintenance-lease') = require('../lib/maintenance-lease');
  const { createMaintenanceRouter, _test: helpers }: typeof import('../../routes/maintenance') = require('../../routes/maintenance');
  const cfg = { ROOT_DIR: rootDir, RUNTIME_ROOT: leaseOptions.runtimeRoot, SCENE_SHOWCASE_DIR: null, DESKTOP_PACKAGED: mode === 'packaged' };
  if (mode === 'startup') {
    try { createMaintenanceRouter(cfg); process.send({ started: true }, () => process.exit(0)); }
    catch (error) { process.send({ started: false, code: runtimeErrorCode(error) }, () => process.exit(0)); }
    return;
  }
  if (!cfg.DESKTOP_PACKAGED) maintenanceReadToken(leaseOptions);
  const store: typeof import('../lib/scene-store') = require('../lib/scene-store');
  const { captureMaintenanceSnapshot }: typeof import('../lib/maintenance-transaction-snapshot') = require('../lib/maintenance-transaction-snapshot');
  const { registerSceneMaintenance }: typeof import('../../routes/maintenance-scene-save') = require('../../routes/maintenance-scene-save');
  const { maintenanceReadBarrier }: typeof import('../../routes/maintenance-read-barrier') = require('../../routes/maintenance-read-barrier');
  const app = express();
  app.use('/data', (req, res, next) => req.headers['x-fixture-deny'] ? res.status(403).json({ error: 'denied by downstream authorization' }) : next());
  app.use('/data', maintenanceReadBarrier(leaseOptions));
  app.use((require('../../server/precompressed') as typeof import('../../server/precompressed')).precompressed(rootDir));
  app.use((require('compression') as typeof import('compression'))({ threshold: 0 }));
  const router = express.Router();
  registerSceneMaintenance({ router, cfg, sceneStore: store, localOnly: helpers.maintenanceLocalOnly,
    packaged: value => value.DESKTOP_PACKAGED, unavailable: (_req, res) => res.status(501).json({ ok: false, code: 'DESKTOP_MAINTENANCE_UNAVAILABLE' }),
    maintenanceSnapshot: removed => captureMaintenanceSnapshot(leaseOptions, store, removed),
    async runMaintenanceChecks() {
      // Content validators are not under test: neutral fixtures exercise the real
      // planners, file writes, transaction journal, compression and rollback.
      if (mode === 'failure') {
        fs.writeFileSync(path.join(rootDir, 'data/unrelated-new.txt'), 'preserve this concurrent file');
        throw new Error('fixture late validator failure');
      }
      if (mode === 'pause') {
        io.atomicWrite(path.join(rootDir, 'data/scenes.json.gz'), 'fixture partial gzip sibling');
        process.send({ checkpoint: 'half-written' });
        await new Promise(resolve => process.once('message', resolve));
      }
    },
    runNodeScript: async () => ({ status: 0 }),
    syncVersion: root => {
      const version = (require('../lib/data-version') as typeof import('../lib/data-version')).expectedDataVersion(root);
      io.atomicWrite(path.join(root, 'src/stores/sceneStore.ts'), 'export const DATA_VERSION = ' + version + ';\n');
    }, timeoutMs: 1000,
  });
  app.use(router);
  app.use('/data', maintenanceReadBarrier(leaseOptions));
  app.get('/data/delayed.json', (_req, res) => {
    res.type('json');
    res.write('{"old":');
    process.send({ checkpoint: 'stream-started' });
    process.once('message', () => res.end('true}'));
  });
  app.use('/data', express.static(path.join(rootDir, 'data')));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.send({ port: server.address().port });
}
if (require.main === module) serve(process.argv[2], process.argv[3]).catch(error => { process.stderr.write(error.stack + '\n'); process.exit(1); });
export = { seed, start };
