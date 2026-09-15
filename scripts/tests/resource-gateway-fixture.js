'use strict';

const http = require('node:http');
const { once } = require('node:events');
const { fixture, write, fs, path, approve, assert } = require('./resource-install-fixtures');
const { generateManifest } = require('../lib/resource-manifest');
const { stageResourcePack } = require('../lib/resource-pack');
const stackTools = require('./gateway-test-stack');

function resourceFixture(t) {
  const f = fixture(t);
  const make = (id, contents) => {
    for (const [rel, bytes] of Object.entries(contents)) write(path.join(f.source, rel), bytes);
    const manifest = generateManifest({ root: f.source });
    write(path.join(f.source, id + '.json'), JSON.stringify(manifest));
    assert.equal(stageResourcePack({ root: f.source, name: id, manifestPath: id + '.json' }).ok, true);
    approve(f, id, 'full', manifest);
  };
  make('images-old', { 'assets/characters/portrait.png': 'old approved image' });
  make('images-new', { 'assets/characters/portrait.png': 'new approved image' });
  write(path.join(f.program, 'assets/characters/portrait.png'), 'bundled base image');
  write(path.join(f.program, 'data/character-reference-view.json'), '{"legacy":"project-index"}');
  write(path.join(f.program, 'data/character-reference-standards.json'), '{}');
  const configPath = f.config();
  const config = { ROOT_DIR: f.program, ASSETS_ROOT: path.join(f.program, 'assets'), CHARACTER_REF_ROOT: '',
    RESOURCE_CONFIG_PATH: configPath, RESOURCE_MANAGEMENT: true, RUNTIME: { outputs: f.artwork } };
  f.make = make;
  f.gatewayConfig = config;
  f.stack = async (overrides = {}) => {
    const stack = await stackTools.start({ env: { AICS_APP_ROOT: f.program }, configureConfig(gateway) {
      Object.assign(gateway, config, { RUNTIME: gateway.RUNTIME, LIVE2D_ROOT: path.join(f.program, 'assets/live2d') }, overrides);
    } });
    t.after(async () => { await stack.gateway.services.resources.close(); await stack.close(); });
    return stack;
  };
  return f;
}
async function request(stack, url, body, headers = {}) {
  // Native HTTP preserves test Host/path headers; fetch may normalize or replace them.
  return new Promise((resolve, reject) => {
    const req = http.request(stack.baseUrl + url, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(text); } catch { /* Media fixtures need not be JSON. */ }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function startAndSettle(stack, action, releaseId) {
  const started = await request(stack, '/api/resources/tasks', { action, ...(releaseId ? { releaseId } : {}) });
  assert.equal(started.status, 202, started.text);
  await stack.gateway.services.resources.settled();
  return (await request(stack, '/api/resources/status')).data;
}
async function downloadSource(t, f) {
  const big = Buffer.alloc(2 * 1024 * 1024, 93);
  f.make('network', { 'assets/characters/large.webp': big });
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range });
    const rel = req.url.slice('/network/'.length);
    if (!['manifest.json', 'assets/a.txt', 'assets/keep.bin', 'assets/new.bin', 'assets/characters/portrait.png', 'assets/characters/large.webp'].includes(rel)) {
      res.writeHead(404); res.end(); return;
    }
    const bytes = fs.readFileSync(path.join(f.packs, 'network', rel));
    const offset = Number(/^bytes=(\d+)-$/.exec(req.headers.range || '')?.[1] || 0);
    res.writeHead(offset ? 206 : 200, { 'content-length': bytes.length - offset, etag: '"fixture"',
      ...(offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}) });
    if (!rel.endsWith('large.webp')) { res.end(bytes.subarray(offset)); return; }
    let cursor = offset;
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return; }
      const end = Math.min(cursor + 32768, bytes.length);
      res.write(bytes.subarray(cursor, end)); cursor = end;
      if (cursor === bytes.length) { clearInterval(timer); res.end(); }
    }, 8);
    res.once('close', () => clearInterval(timer));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  f.policy.sources.network = { kind: 'http', approved: true, loopbackFixture: true, baseUrl: `http://127.0.0.1:${server.address().port}/` };
  f.policy.releases.network.sourceId = 'network'; f.config();
  return { requests, server };
}
module.exports = { resourceFixture, request, startAndSettle, downloadSource };
