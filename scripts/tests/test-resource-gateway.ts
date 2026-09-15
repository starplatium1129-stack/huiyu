'use strict';

const test: typeof import('node:test')['test'] = require('node:test').test;
const { fs, path, assert, write, snapshot }: typeof import('./resource-install-fixtures') = require('./resource-install-fixtures');
const { resourceFixture, request, startAndSettle, downloadSource }: typeof import('./resource-gateway-fixture') = require('./resource-gateway-fixture');
const { createResourceManager }: typeof import('../lib/resource-install-gateway') = require('../lib/resource-install-gateway');
const { loadGatewayConfig }: typeof import('../../server/config') = require('../../server/config');
const { fork }: typeof import('node:child_process') = require('node:child_process');

test('gateway startup/status are read-only when not configured or not installed', async t => {
  const f = resourceFixture(t);
  const unconfigured = await f.stack({ RESOURCE_CONFIG_PATH: '' });
  assert.equal((await request(unconfigured, '/api/resources/status')).data.configured, false);
  const configured = await f.stack();
  assert.equal((await request(configured, '/api/resources/status?refresh=1')).data.current, null);
  assert.deepEqual(fs.readdirSync(f.user), []);
});

test('environment alone selects resource policy and enables management', t => {
  const f = resourceFixture(t);
  const env = { AICS_APP_ROOT: f.program, AICS_RUNTIME_ROOT: path.join(f.base, 'runtime'), AICS_DISABLE_LEGACY_RUNTIME_MIGRATION: '1' };
  const config = loadGatewayConfig(f.program, env);
  write(config.RUNTIME.config, JSON.stringify({ RESOURCE_MANAGEMENT: true, resourceConfig: f.config(), AICS_RESOURCE_CONFIG: f.config() }));
  assert.equal(loadGatewayConfig(f.program, env).RESOURCE_MANAGEMENT, false);
  assert.equal(loadGatewayConfig(f.program, env).RESOURCE_CONFIG_PATH, '');
  const explicit = loadGatewayConfig(f.program, { ...env, AICS_RESOURCE_CONFIG: f.config(), AICS_RESOURCE_MANAGEMENT: 'trusted' });
  assert.equal(explicit.RESOURCE_MANAGEMENT, true);
  assert.equal(explicit.RESOURCE_CONFIG_PATH, f.config());
});

test('real gateway import, restart, second install and rollback use the approved original asset URL', async t => {
  const f = resourceFixture(t);
  const program = snapshot(f.program), artwork = snapshot(f.artwork);
  const stack = await f.stack();
  let status = await startAndSettle(stack, 'import', 'images-old');
  assert.equal(status.task.state, 'completed');
  assert.equal(status.mounted, true, JSON.stringify(status));
  assert.equal((await request(stack, '/assets/characters/portrait.png')).text, 'old approved image');
  const restarted = await f.stack();
  assert.equal((await request(restarted, '/assets/characters/portrait.png')).text, 'old approved image');
  status = await startAndSettle(stack, 'import', 'images-new');
  assert.equal(status.task.state, 'completed');
  assert.equal((await request(stack, '/assets/characters/portrait.png')).text, 'new approved image');
  status = await startAndSettle(stack, 'rollback');
  assert.equal(status.task.state, 'completed');
  assert.equal((await request(stack, '/assets/characters/portrait.png')).text, 'old approved image');
  assert.deepEqual(snapshot(f.program), program); assert.deepEqual(snapshot(f.artwork), artwork);
});

test('installed resource bytes/metadata never leak through remote or arbitrary-path requests', async t => {
  const f = resourceFixture(t);
  await f.installer().install({ releaseId: 'images-old' });
  const stack = await f.stack();
  const remote = { 'x-forwarded-for': '203.0.113.10', 'x-token': stack.config.TOKEN };
  assert.equal((await request(stack, '/api/resources/status', undefined, remote)).status, 403);
  assert.equal((await request(stack, '/api/resources/tasks', { action: 'import', releaseId: 'images-new' }, remote)).status, 403);
  assert.equal((await request(stack, '/assets/characters/portrait.png', undefined, remote)).text, 'bundled base image');
  assert.equal((await request(stack, '/api/resources/status', undefined, { Host: 'evil.invalid' })).status, 421);
  assert.equal((await request(stack, '/api/resources/tasks', { action: 'import', releaseId: 'images-old', path: f.artwork })).status, 400);
  assert.equal((await request(stack, '/api/resources/tasks', { action: 'download', releaseId: 'images-old', url: 'http://127.0.0.1/' })).status, 400);
  const state: any = await request(stack, '/api/resources/status');
  for (const privatePath of [f.user, f.source, f.program, f.artwork]) assert.equal(state.text.includes(privatePath.replaceAll('\\', '\\\\')), false);
  for (const url of ['/assets/manifest.json', '/assets/receipt.json', '/assets/../resource-library-v1/current.json', '/assets/%2e%2e/current.json']) {
    assert.notEqual((await request(stack, url)).status, 200, url);
  }
});

test('post-start corruption and pending transaction fail closed to bundled media', async t => {
  const f = resourceFixture(t);
  const installed = await f.installer().install({ releaseId: 'images-old' });
  const stack = await f.stack();
  write(path.join(installed.installedRoot, 'assets/characters/portrait.png'), 'corrupt image');
  assert.equal((await request(stack, '/assets/characters/portrait.png')).text, 'bundled base image');
  assert.equal((await request(stack, '/api/resources/status')).data.mounted, false);
  write(path.join(installed.installedRoot, 'assets/characters/portrait.png'), 'old approved image');
  write(path.join(f.installer().root, 'pending.json'), 'null');
  const restart = await f.stack();
  assert.equal((await request(restart, '/api/resources/status')).data.issue.code, 'PENDING_TRANSACTION');
  assert.equal((await request(restart, '/assets/characters/portrait.png')).text, 'bundled base image');
});

test('config replacement or malformed policy cannot reuse old approval to start operations', async t => {
  const f = resourceFixture(t);
  await f.installer().install({ releaseId: 'images-old' });
  const stack = await f.stack();
  write(f.gatewayConfig.RESOURCE_CONFIG_PATH, '{broken');
  assert.equal((await request(stack, '/api/resources/tasks', { action: 'import', releaseId: 'images-new' })).status, 403);
  assert.equal((await request(stack, '/assets/characters/portrait.png')).text, 'bundled base image');
  const disabled = await f.stack({ RESOURCE_CONFIG_PATH: f.config(), RESOURCE_MANAGEMENT: false });
  assert.equal((await request(disabled, '/api/resources/tasks', { action: 'import', releaseId: 'images-new' })).data.code, 'MANAGEMENT_DISABLED');
});

test('HTTP task cancel, resume and explicit install work across manager restart with no automatic download', async t => {
  const f = resourceFixture(t);
  const source = await downloadSource(t, f);
  const stack = await f.stack();
  assert.equal(source.requests.length, 0);
  const started: any = await request(stack, '/api/resources/tasks', { action: 'download', releaseId: 'network' });
  assert.equal(started.status, 202);
  assert.equal((await request(stack, '/api/resources/tasks', { action: 'import', releaseId: 'images-old' })).status, 409);
  for (let i = 0; i < 100 && !source.requests.some(req => req.url.endsWith('large.webp')); i++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal((await request(stack, `/api/resources/tasks/${started.data.task.id}/cancel`, {})).status, 200);
  await stack.gateway.services.resources.settled();
  assert.equal((await request(stack, '/api/resources/status')).data.task.state, 'cancelled');
  const restart = await f.stack();
  let status = await startAndSettle(restart, 'recover');
  assert.equal(status.task.state, 'completed', JSON.stringify(status));
  assert.equal(status.current, null);
  assert.ok(source.requests.some(req => req.range));
  status = await startAndSettle(restart, 'import', 'network');
  assert.equal(status.task.state, 'completed');
  assert.equal(status.mounted, true);
});

test('runtime configuration revocation cancels authorization during an active download', async t => {
  const f = resourceFixture(t);
  await downloadSource(t, f);
  const manager = createResourceManager(f.gatewayConfig);
  t.after(() => manager.close());
  manager.start('download', 'network', true);
  write(f.gatewayConfig.RESOURCE_CONFIG_PATH, '{}');
  await manager.settled();
  assert.equal(manager.status().mounted, false);
  assert.equal(manager.status().configured, false);
});

test('SIGKILL during a gateway-managed download retains task/partial state and resumes through the real API', async t => {
  const f = resourceFixture(t); const source = await downloadSource(t, f);
  const config = path.join(f.base, 'gateway-worker.json'); write(config, JSON.stringify(f.gatewayConfig));
  await new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'resource-gateway-worker.js'), [config], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let ready = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Worker timeout')); }, 15000);
    child.on('error', reject);
    child.on('message', message => {
      if (message.ready) { ready = true; child.kill('SIGKILL'); }
      else if (message.error) { child.kill('SIGKILL'); reject(new Error(JSON.stringify(message.error))); }
    });
    child.on('exit', () => { clearTimeout(timer); if (ready) resolve(); else reject(new Error('Worker exited too early')); });
  });
  const stack = await f.stack();
  const status = (await request(stack, '/api/resources/status')).data;
  assert.equal(status.task.state, 'interrupted'); assert.equal(status.recoveryRequired, true);
  const recovered = await startAndSettle(stack, 'recover');
  assert.equal(recovered.task.state, 'completed', JSON.stringify(recovered));
  assert.ok(source.requests.some(value => value.range));
  assert.equal(recovered.current, null);
});

test('complete Live2D models override both aliases; missing dependencies fall back as a group', async t => {
  const f = resourceFixture(t);
  const model = { Version: 3, FileReferences: { Moc: 'model.moc3', Textures: ['texture.png'], Physics: 'model.physics3.json' } };
  f.make('live', { 'assets/live2d/fixture/model.model3.json': JSON.stringify(model),
    'assets/live2d/fixture/model.moc3': 'new moc', 'assets/live2d/fixture/texture.png': 'new texture',
    'assets/live2d/fixture/model.physics3.json': '{}' });
  f.config();
  for (const [name, value] of Object.entries({ 'model.model3.json': '{"bundled":true}', 'texture.png': 'base texture', 'model.moc3': 'base moc' })) {
    write(path.join(f.program, 'assets/live2d/fixture', name), value);
  }
  const installed = await f.installer().install({ releaseId: 'live' });
  const stack = await f.stack();
  assert.equal((await request(stack, '/assets/live2d/fixture/texture.png')).text, 'new texture');
  assert.equal((await request(stack, '/assets/live2d-current/fixture/model.moc3')).text, 'new moc');
  fs.unlinkSync(path.join(installed.installedRoot, 'assets/live2d/fixture/model.physics3.json'));
  assert.equal((await request(stack, '/assets/live2d/fixture/texture.png')).text, 'base texture');
  assert.equal((await request(stack, '/assets/live2d/fixture/model.model3.json')).text, '{"bundled":true}');
});
