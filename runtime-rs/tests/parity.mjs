import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.dirname(root);
const appRoot = process.env.AICS_RUST_APP_ROOT ? fs.realpathSync(process.env.AICS_RUST_APP_ROOT) : repo;
const binaryName = process.platform === 'win32' ? 'huiyu-runtime.exe' : 'huiyu-runtime';
const runtimeBinary=process.env.AICS_RUST_RUNTIME_EXE||(process.env.AICS_RUST_APP_ROOT?path.join(appRoot,binaryName):path.join(root,'target/release',binaryName));
const legacy = JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-workspace.json', import.meta.url), 'utf8'));
const { workspaceId, sourceProfile, principal } = legacy;
const image = Buffer.from(legacy.image, 'base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(directory) {
  // Restore bytes and SQL captured from Node schema 3, never from the runtime
  // under test. The fixture records its source commit and supported scope.
  fs.mkdirSync(directory, { recursive: true });
  for (const [relative, bytes] of Object.entries(legacy.database.files)) {
    const target = path.resolve(directory, relative);
    assert.ok(target.startsWith(path.resolve(directory) + path.sep));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(bytes, 'base64'));
  }
  const db = new DatabaseSync(path.join(directory, 'huiyu.sqlite3'));
  try {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN');
    for (const { sql } of legacy.database.schema) db.exec(sql);
    for (const [table, rows] of Object.entries(legacy.database.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row).map(key => JSON.stringify(key));
        db.prepare(`INSERT INTO ${JSON.stringify(table)} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
      }
    }
    db.exec(`PRAGMA user_version=${legacy.database.userVersion}`);
    // Stable extra rows retain the existing read-load measurement independently
    // of the historical one-artwork fixture and do not exercise bulk import.
    const insert = db.prepare('INSERT INTO artworks VALUES(?,?,?,?,NULL)');
    for (let index = 0; index < 1000; index++) {
      const id = `item-${String(index).padStart(5, '0')}`;
      insert.run(id, JSON.stringify(id), JSON.stringify({ id, image_id: 'seed-image', note: 'read-load' }), 1);
    }
    db.exec('COMMIT');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
  return legacy.baseline;
}

async function startRust(configRoot, secret) {
  const binary = runtimeBinary;
  const env = { ...process.env, AICS_DESKTOP_GATEWAY_TOKEN: secret, AICS_DESKTOP_SOURCE_PROFILE_ID: sourceProfile, AICS_DESKTOP_CONFIG_ROOT: configRoot };
  Object.assign(env, { AICS_RUNTIME_ROOT: path.join(configRoot, 'runtime'), AI_WORKSPACE_ROOT: path.join(configRoot, 'ai'),
    SD_HOST: 'http://127.0.0.1:1', COMFY_HOST: 'http://127.0.0.1:1', OLLAMA_HOST: 'http://127.0.0.1:1', TTS_HOST: 'http://127.0.0.1:1', TRANSLATE_PORT: '1',
    TRANSLATION_PYTHON: path.join(configRoot,'absent-python'), AICS_TOOLS_ROOT: path.join(appRoot,'tools'), AICS_DESKTOP_COMMANDS: 'disabled', DISABLE_TUNNEL:'1' });
  for (const key of ['AICS_ASSETS_ROOT', 'AICS_CHARACTER_REF_ROOT', 'AICS_DATA_ROOT']) delete env[key];
  if(process.env.AICS_RUST_APP_ROOT)delete env.AICS_VIPS_DYLIB_PATH;
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
  const tempBase = fs.realpathSync.native(os.tmpdir());
  const temp = fs.mkdtempSync(path.join(tempBase, 'huiyu-rust-parity-'));
  const children = [];
  try {
    const source = path.join(temp, 'fixture');
    const baseline = fixture(source);
    const rustConfig = path.join(temp, 'rust-config');
    const rustRoot = path.join(rustConfig, 'workspaces', workspaceId);
    fs.cpSync(source, rustRoot, { recursive: true });
    fs.writeFileSync(path.join(rustConfig, 'workspace-active.json'), JSON.stringify({ formatVersion: 1, workspaceId, generation: 1,
      activatedRevision: 1, domains: ['artwork', 'settings', 'chat', 'draft'], migrationId: 'fixture', backupId: null, restoreCandidateId: null, bundledUi: true }));
    const secret = randomBytes(32).toString('hex');
    const rust = await startRust(rustConfig, secret); children.push(rust.child);
    const rustResult = await exercise(rust, baseline);
    assert.deepEqual(rustResult.receipt, legacy.expected.receipt);
    assert.deepEqual(rustResult.saved, legacy.expected.saved);
    assert.deepEqual(rustResult.setting, legacy.expected.setting);
    let browser;
    if (process.env.AICS_RUST_BROWSER_REPORT) {
      const { verifyBrowser } = await import('./browser.mjs');
      browser = await verifyBrowser(rust, sourceProfile, process.env.AICS_RUST_BROWSER_REPORT);
    }
    const rustExit = once(rust.child, 'exit'); await signed(rust, 'shutdown'); await rustExit;
    // Read persisted rows with SQLite directly: no Rust/retired Node decoding
    // implementation can make a matching HTTP response hide corrupt storage.
    const reopened = new DatabaseSync(path.join(rustRoot, 'huiyu.sqlite3'), { readOnly: true });
    try {
      assert.deepEqual(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(reopened.prepare('SELECT count(*) AS n FROM artworks').get().n, 1002);
      for (const receipt of [legacy.expected.receipt, legacy.expected.saved]) {
        const row = reopened.prepare('SELECT * FROM artworks WHERE id_key=?').get(receipt.artwork.id);
        assert.deepEqual({ id: JSON.parse(row.id_json), body: JSON.parse(row.body), revision: row.revision, deletedAt: row.deleted_at }, receipt.artwork);
        const operation = reopened.prepare('SELECT * FROM operations WHERE principal_id=? AND operation_id=?').get(principal, receipt.operationId);
        assert.equal(operation.state, 'committed');
        assert.deepEqual(JSON.parse(operation.receipt_json), receipt);
      }
      const original = reopened.prepare('SELECT * FROM operations WHERE principal_id=? AND operation_id=?').get(principal, 'seed-save');
      assert.deepEqual({ ...original }, legacy.database.tables.operations[0]);
      const setting = reopened.prepare("SELECT body,revision FROM profile_records WHERE domain='settings' AND record_key='aics_theme'").get();
      assert.deepEqual(JSON.parse(setting.body), legacy.expected.setting.value);
      assert.equal(setting.revision, legacy.expected.setting.revision);
      const hash = legacy.baseline.prepare.media.sha256;
      for (const alias of ['seed-image', 'new-image']) {
        assert.equal(reopened.prepare('SELECT hash FROM media_aliases WHERE alias=?').get(alias).hash, hash);
      }
      assert.deepEqual(fs.readFileSync(path.join(rustRoot, 'media/objects', hash.slice(0, 2), hash)), image);
    } finally { reopened.close(); }
    const binary = runtimeBinary;
    const report = { formatVersion: 1, measuredAt: new Date().toISOString(), fixtureRows: 1001, measuredRows: 1002,
      sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), nodeVersion: process.version,
      runtimeSha256: digest(fs.readFileSync(binary)), cargoLockSha256: digest(fs.readFileSync(path.join(root, 'Cargo.lock'))), appRoot,
      legacySourceCommit: legacy.sourceCommit,
      checks: ['fixed Node schema-3 database opened by Rust', 'legacy receipt retried unchanged', 'unknown fields round-trip', 'idempotent patch', 'chunk upload and commit retry', 'profile CAS receipt', 'single-object media Range', 'Rust writes and legacy operation identity independently read by SQLite'],
      latency: { rust: rustResult.rounds }, browser,
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

await run();
