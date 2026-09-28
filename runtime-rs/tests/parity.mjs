import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.dirname(root);
const appRoot = process.env.AICS_RUST_APP_ROOT ? fs.realpathSync(process.env.AICS_RUST_APP_ROOT) : repo;
const binaryName = process.platform === 'win32' ? 'huiyu-runtime.exe' : 'huiyu-runtime';
const runtimeBinary=process.env.AICS_RUST_RUNTIME_EXE||(process.env.AICS_RUST_APP_ROOT?path.join(appRoot,binaryName):path.join(root,'target/release',binaryName));
const { openWorkspaceEngine } = require(path.join(repo, 'server/workspace/engine.js'));
const workspaceId = '4ef78272-7b1c-4146-9292-dc2d3323cbf2';
const sourceProfile = `profile-${'a'.repeat(64)}`;
const principal = `desktop:${sourceProfile}`;
const image = await require(path.join(repo, 'node_modules/sharp'))({ create: { width: 64, height: 64, channels: 4, background: '#73668b' } }).png().toBuffer();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function nodeHost() {
  const express = require(path.join(repo, 'node_modules/express'));
  const { createDesktopWorkspaceHost } = require(path.join(repo, 'server/workspace/host.js'));
  const app = express();
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const host = await createDesktopWorkspaceHost({ configRoot: process.argv[3], secret: process.env.AICS_DESKTOP_GATEWAY_TOKEN,
    sourceProfileId: sourceProfile, gatewayOrigin: origin });
  app.use(host.router);
  process.send({ origin });
  process.on('message', async message => {
    if (message !== 'close') return;
    await host.close(); server.close(); process.disconnect();
  });
}

async function fixture(directory) {
  const engine = openWorkspaceEngine({ root: directory, workspaceId, writerEpoch: 'fixture', create: true });
  const context = { workspaceId, principalId: principal, protocolVersion: 1 };
  const artwork = { id: 'seed-1', image_id: 'seed-image', custom_future_field: { '10': 10, '2': 2, nested: [true, null, 'kept'], z: 1e-7 }, prompt: '中性测试' };
  const prepare = { kind: 'prepareSave', operationId: 'seed-save', artwork,
    media: { alias: 'seed-image', sha256: digest(image), bytes: image.length, mime: 'image/png' } };
  await engine.execute(prepare, context);
  await engine.execute({ kind: 'uploadChunk', operationId: 'seed-save', offset: 0, data: image }, context);
  const receipt = await engine.execute({ kind: 'commitSave', operationId: 'seed-save' }, context);
  engine.close();
  // Deterministic read-load fixture, not a claim that bulk import was migrated.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(directory, 'huiyu.sqlite3'));
  const { entityKey } = require(path.join(repo, 'server/workspace/records.js'));
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO artworks VALUES(?,?,?,?,NULL)');
  for (let index = 0; index < 1000; index++) {
    const id = `item-${String(index).padStart(5, '0')}`;
    insert.run(entityKey(id), JSON.stringify(id), JSON.stringify({ id, image_id: 'seed-image', note: 'read-load' }), 1);
  }
  db.exec('COMMIT'); db.close();
  return { prepare, receipt };
}

async function startRust(configRoot, secret) {
  const binary = runtimeBinary;
  const env = { ...process.env, AICS_DESKTOP_GATEWAY_TOKEN: secret, AICS_DESKTOP_SOURCE_PROFILE_ID: sourceProfile, AICS_DESKTOP_CONFIG_ROOT: configRoot };
  Object.assign(env, { AICS_RUNTIME_ROOT: path.join(configRoot, 'runtime'), AI_WORKSPACE_ROOT: path.join(configRoot, 'ai'),
    SD_HOST: 'http://127.0.0.1:1', COMFY_HOST: 'http://127.0.0.1:1', OLLAMA_HOST: 'http://127.0.0.1:1', TTS_HOST: 'http://127.0.0.1:1', TRANSLATE_PORT: '1',
    TRANSLATION_PYTHON: path.join(configRoot,'absent-python'), AICS_TOOLS_ROOT: path.join(appRoot,'tools'), AICS_DESKTOP_COMMANDS: 'disabled', DISABLE_TUNNEL:'1' });
  for (const key of ['AICS_ASSETS_ROOT', 'AICS_CHARACTER_REF_ROOT', 'AICS_DATA_ROOT']) delete env[key];
  if(process.env.AICS_RUST_APP_ROOT)for(const key of ['AICS_ORT_DYLIB_PATH','AICS_VIPS_DYLIB_PATH'])delete env[key];
  const child = spawn(binary, ['--app-root', appRoot, '--bind', '127.0.0.1:0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Rust startup timed out: ${stderr}`)), 15000);
    let stdout = '';
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Rust exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      for (const line of stdout.split('\n').slice(0, -1)) {
        try { const message = JSON.parse(line); if (message.event === 'ready') { clearTimeout(timeout); resolve(message.origin); } } catch { /* incomplete diagnostic line */ }
      }
    });
  }).catch(async error => { await stop(child); throw error; });
  return { child, origin, secret, stderr: () => stderr };
}

async function signed(server, action = 'session') {
  const body = JSON.stringify({ action, timestamp: Date.now(), nonce: randomBytes(32).toString('hex'), windowId: 'atelier', sourceProfileId: sourceProfile, origin: server.origin });
  const proof = createHmac('sha256', server.secret).update(`aics-desktop-host:v1\n${body}`).digest('hex');
  const response = await fetch(`${server.origin}/api/desktop-host`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aics-host-proof': proof }, body, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function api(server, endpoint, method = 'GET', input) {
  const response = await fetch(`${server.origin}/api/workspace${endpoint}`, { method,
    headers: { origin: server.origin, 'x-aics-workspace-session': server.session.token, ...(input ? { 'content-type': 'application/json' } : {}) },
    body: input ? JSON.stringify({ protocolVersion: 1, workspaceId, ...input }) : undefined, signal: AbortSignal.timeout(30000) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.result;
}

async function exercise(server, baseline) {
  server.session = (await signed(server)).workspace;
  const status = await api(server, '/status');
  assert.equal(status.schemaVersion, 3);
  const seed = await api(server, '/artworks/seed-1');
  assert.deepEqual(seed, baseline.receipt.artwork);
  // An old Node receipt must remain the identity of a retried Rust save.
  const { kind, ...prepare } = baseline.prepare;
  const replay = await api(server, '/artwork-saves/seed-save', 'POST', prepare);
  assert.deepEqual(replay.receipt, baseline.receipt);
  const receipt = await api(server, '/artworks/seed-1', 'PATCH', { operationId: 'patch-parity', expectedRevision: seed.revision, patch: { note: 'Rust/Node parity', nested: { untouched: true }, number: 1e21 } });
  assert.deepEqual(await api(server, '/artworks/seed-1', 'PATCH', { operationId: 'patch-parity', expectedRevision: seed.revision, patch: { note: 'Rust/Node parity', nested: { untouched: true }, number: 1e21 } }), receipt);
  await api(server, '/artwork-saves/upload-parity', 'POST', { operationId: 'upload-parity', artwork: { id: 'new-save', image_id: 'new-image', prompt: '隔离保存' },
    media: { alias: 'new-image', sha256: digest(image), bytes: image.length, mime: 'image/png' } });
  await api(server, '/artwork-saves/upload-parity/chunks', 'PUT', { offset: 0, data: image.toString('base64') });
  const saved = await api(server, '/artwork-saves/upload-parity/commit', 'POST', {});
  assert.deepEqual(await api(server, '/artwork-saves/upload-parity/commit', 'POST', {}), saved);
  const setting = await api(server, '/profile/settings', 'PUT', { operationId: 'theme-parity', key: 'aics_theme', value: 'dark', expectedRevision: null });
  assert.deepEqual(await api(server, '/profile/settings', 'PUT', { operationId: 'theme-parity', key: 'aics_theme', value: 'dark', expectedRevision: null }), setting);
  const headers = { origin: server.origin, 'x-aics-workspace-session': server.session.token, 'content-type': 'application/json' };
  const grant = await fetch(`${server.origin}/api/workspace/media-capabilities`, { method: 'POST', headers, body: JSON.stringify({ alias: 'seed-image' }) }).then(r => r.json());
  const range = await fetch(new URL(grant.url, server.origin), { headers: { origin: server.origin, range: 'bytes=1-8' } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), image.subarray(1, 9));
  const rounds = [];
  for (let round = 0; round < 5; round++) {
    const samples = [];
    for (let index = 0; index < 40; index++) {
      const start = performance.now();
      const page = await api(server, '/artworks?limit=100');
      assert.equal(page.items.length, 100);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    rounds.push({ p50Ms: samples[19], p95Ms: samples[37] });
  }
  return { receipt, saved, setting, rounds };
}

async function run() {
  const tempBase = fs.realpathSync(os.tmpdir());
  const temp = fs.mkdtempSync(path.join(tempBase, 'huiyu-rust-parity-'));
  const children = [];
  try {
    const source = path.join(temp, 'fixture');
    const baseline = await fixture(source);
    const config = path.join(temp, 'node-config');
    const nodeRoot = path.join(config, 'workspaces', workspaceId);
    const rustConfig = path.join(temp, 'rust-config');
    const rustRoot = path.join(rustConfig, 'workspaces', workspaceId);
    fs.cpSync(source, nodeRoot, { recursive: true }); fs.cpSync(source, rustRoot, { recursive: true });
    fs.writeFileSync(path.join(config, 'workspace-active.json'), JSON.stringify({ formatVersion: 1, workspaceId, generation: 1,
      activatedRevision: 1, domains: ['artwork', 'settings', 'chat', 'draft'], migrationId: 'fixture', backupId: null, restoreCandidateId: null, bundledUi: true }));
    fs.copyFileSync(path.join(config, 'workspace-active.json'), path.join(rustConfig, 'workspace-active.json'));
    const secret = randomBytes(32).toString('hex');
    const node = fork(fileURLToPath(import.meta.url), ['--node-host', config], { env: { ...process.env, AICS_DESKTOP_GATEWAY_TOKEN: secret },
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(node);
    let nodeError = ''; node.stderr.on('data', chunk => { nodeError = (nodeError + chunk).slice(-16000); });
    const nodeOrigin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Node fixture startup timed out: ${nodeError}`)), 15000);
      node.once('message', message => { clearTimeout(timer); resolve(message.origin); });
      node.once('error', error => { clearTimeout(timer); reject(error); });
      node.once('exit', code => { clearTimeout(timer); reject(new Error(`Node fixture exited ${code}: ${nodeError}`)); });
    });
    const nodeServer = { origin: nodeOrigin, secret };
    const nodeResult = await exercise(nodeServer, baseline);
    const nodeExit = once(node, 'exit'); node.send('close'); await nodeExit;
    const rust = await startRust(rustConfig, secret); children.push(rust.child);
    const rustResult = await exercise(rust, baseline);
    assert.deepEqual(rustResult.receipt, nodeResult.receipt);
    assert.deepEqual(rustResult.saved, nodeResult.saved);
    assert.deepEqual(rustResult.setting, nodeResult.setting);
    let browser;
    if (process.env.AICS_RUST_BROWSER_REPORT) {
      const { verifyBrowser } = await import('./browser.mjs');
      browser = await verifyBrowser(rust, sourceProfile, process.env.AICS_RUST_BROWSER_REPORT);
    }
    const rustExit = once(rust.child, 'exit'); await signed(rust, 'shutdown'); await rustExit;
    // Read Rust writes through the old engine, including operation identities.
    const reopened = openWorkspaceEngine({ root: rustRoot, workspaceId, writerEpoch: 'node-reopen', create: false });
    try {
      const saved = await reopened.execute({ kind: 'getArtwork', id: 'seed-1' }, { workspaceId, principalId: principal, protocolVersion: 1 });
      assert.deepEqual(saved, rustResult.receipt.artwork);
    } finally { reopened.close(); }
    const binary = runtimeBinary;
    const report = { formatVersion: 1, measuredAt: new Date().toISOString(), fixtureRows: 1001, measuredRows: 1002,
      sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), nodeVersion: process.version,
      runtimeSha256: digest(fs.readFileSync(binary)), cargoLockSha256: digest(fs.readFileSync(path.join(root, 'Cargo.lock'))), appRoot,
      checks: ['Node receipt retried by Rust', 'unknown fields round-trip', 'idempotent patch', 'chunk upload and commit retry', 'profile CAS receipt', 'single-object media Range', 'Rust writes reopened by Node'],
      latency: { node: nodeResult.rounds, rust: rustResult.rounds }, browser,
      limits: 'Isolated workspace HTTP slice; optional real gallery/control browser acceptance with neutral fixture settings only. No production data, model execution, installation, full-runtime memory or whole-product performance claim.' };
    if (process.env.AICS_RUST_PARITY_REPORT) fs.writeFileSync(process.env.AICS_RUST_PARITY_REPORT, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const child of children) await stop(child);
    const resolved = fs.realpathSync(temp);
    if (fs.lstatSync(temp).isSymbolicLink() || !resolved.startsWith(tempBase + path.sep) || path.basename(resolved) !== path.basename(temp)) throw new Error('Refusing cleanup outside the owned fixture directory');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit'); child.kill(); await closed;
}

if (process.argv[2] === '--node-host') await nodeHost();
else await run();
