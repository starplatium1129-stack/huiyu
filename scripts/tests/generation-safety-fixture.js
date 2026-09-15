'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const CODE_ROOT = path.resolve(__dirname, '..', '..');
const entries = ['render-all-outfits-references.js', 'generate-all-scenes-showcase-miaomiao.js', 'render-showcase-gaps.js'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'office-generation-'));
  const root = path.join(temporary, 'project');
  const output = path.join(temporary, 'candidates');
  const manifest = path.join(temporary, 'active', 'manifest.json');
  const character = { id: 'fixture', displayName: 'Fixture', originalName: 'Fixture', franchise: 'Test',
    identityProse: 'An adult test character.', identityTokens: ['fixture_character'], exactTokens: [], exactPrefixes: [],
    recommendedEngine: 'anima-miaomiao-v1.2', supportedEngines: ['anima'], adultEligibility: 'adult',
    outfits: [{ id: 'coat', name: 'Blue coat', prose: 'A blue coat.', tokens: ['blue_coat'], default: true }] };
  const blueprint = { id: 'bp1', title: 'Walk', category: 'daily', description: 'Walking outside.',
    characterId: character.id, outfitId: 'coat', location: 'garden', action: 'walking', timeOfDay: 'morning',
    lighting: 'soft light', camera: 'medium shot', mood: 'calm', sceneTags: ['garden'],
    promptProse: 'An adult walking in a garden.', promptTokens: ['garden', 'walking'],
    negativeTokens: ['rain'], recommendedSize: '1216x832', adult: false };
  const values = {
    'popular-characters.json': { characters: [character] },
    'scene-blueprints.json': { blueprints: [blueprint] },
    'presets.json': { model_profiles: [{ id: 'anima_miaomiao_v12', name: 'Fixture model',
      model_id: 'anima-miaomiao-v1.2', engine: 'anima', quality_prefix: 'test_quality', negative_prefix: 'test_negative' }] },
    'tags.json': [],
    'scenes.json': [{ id: 'sc001', title: 'Window', char: 'nene', prompt: 'A person by a window.', negative: 'rain', recommendedSize: '832x1216' }],
    'character-reference-standards.json': { characters: [character], perspectives: [
      { id: 'ref_01_face_closeup', name: 'Portrait' }, { id: 'ref_design_front', name: 'Design excluded' }] },
  };
  for (const [name, value] of Object.entries(values)) writeJson(path.join(root, 'data', name), value);
  writeJson(manifest, { entries: [], source: 'active-sentinel', publishedAt: 'unchanged' });
  writeJson(path.join(root, 'assets', 'sentinel.json'), { protected: true });
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return { temporary, root, output, manifest, values, character, blueprint,
    args: ['--root', root, '--output', output, '--concurrency', '1'],
    env: { AI_WORKSPACE_ROOT: path.join(temporary, 'AI'), SCENE_SHOWCASE_DIR: path.dirname(manifest) } };
}

function tree(root) {
  const out = {};
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) out[entry.name] = `link:${fs.readlinkSync(file)}`;
    else if (entry.isDirectory()) out[entry.name] = tree(file);
    else out[entry.name] = sha(fs.readFileSync(file));
  }
  return out;
}

// Synthetic PNG with real chunks, checksums and compressed pixel bytes; no generated art.
function png() {
  function crc(bytes) {
    let c = -1;
    for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (c ^ -1) >>> 0;
  }
  function chunk(type, body) {
    const data = Buffer.concat([Buffer.from(type), body]);
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(body.length); checksum.writeUInt32BE(crc(data));
    return Buffer.concat([length, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 80, 100, 120]))), chunk('IEND', Buffer.alloc(0))]);
}

async function mockGateway(t) {
  const state = { posts: [], gets: [], mode: 'success', onPoll: null, images: 0 };
  const image = png();
  const server = http.createServer(async (req, res) => {
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST') {
      let body = ''; for await (const part of req) body += part;
      state.posts.push(JSON.parse(body));
      if (state.mode === 'bad-submit') return res.end('{');
      if (state.mode === 'missing-id') return json({ ok: true, job: {} });
      res.statusCode = 202;
      return json({ ok: true, job: { id: `job-${state.posts.length}`, status: 'queued' } });
    }
    state.gets.push(req.url);
    if (req.url.startsWith('/api/anima/jobs/')) {
      state.onPoll?.();
      if (state.mode === 'bad-poll') return res.end('{');
      const id = req.url.split('/').pop();
      const failed = state.mode === 'failed' || (state.mode === 'retry-once' && id === 'job-1');
      return json({ ok: true, job: { id: state.mode === 'wrong-id' ? 'unexpected' : id,
        status: failed ? 'failed' : state.mode === 'running' ? 'running' : 'succeeded',
        resultUrl: state.mode === 'missing-result' ? undefined : state.mode === 'foreign' ? 'http://127.0.0.1:1/forbidden' : '/image.png',
        metadata: { seed: 123, review: { verdict: 'pass', reviewedAt: 'forged' } },
        review: { verdict: 'pass' }, publishedAt: 'forged' } });
    }
    state.images++;
    if (state.mode === 'http-error') { res.statusCode = 503; return res.end('unavailable'); }
    if (state.mode === 'redirect') { res.statusCode = 302; res.setHeader('location', 'http://127.0.0.1:1/forbidden'); return res.end(); }
    res.setHeader('content-type', state.mode === 'html' ? 'text/html' : 'image/png');
    res.end(state.mode === 'bad-image' ? Buffer.from('<html>invalid</html>') : state.mode === 'truncated' ? image.subarray(0, 45) : image);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { state, origin, image, fetchImpl: (url, init) => {
    if (new URL(url).origin !== origin) throw new Error(`non-mock network forbidden: ${url}`);
    return fetch(url, init);
  } };
}

async function guarded(f, action, { preview = false } = {}) {
  const original = {}, writes = [];
  const under = (value, base) => typeof value === 'string' && (path.resolve(value) === base || path.resolve(value).startsWith(base + path.sep));
  const methods = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'cpSync', 'truncateSync'];
  for (const method of methods) {
    original[method] = fs[method];
    fs[method] = (...args) => {
      writes.push({ method, path: args[0] });
      if (preview || !under(args[0], f.output) || (['renameSync', 'copyFileSync', 'cpSync'].includes(method) && !under(args[1], f.output))) {
        throw new Error(`forbidden filesystem mutation: ${method} ${args[0]}`);
      }
      return original[method](...args);
    };
  }
  original.readFileSync = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (['data', 'assets', 'runtime'].some(dir => under(file, path.join(CODE_ROOT, dir)))) throw new Error(`production read forbidden: ${file}`);
    return original.readFileSync(file, ...args);
  };
  const logs = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  try { return { result: await action(), writes }; }
  finally { Object.assign(fs, original); Object.assign(console, logs); }
}

module.exports = { CODE_ROOT, entries, sha, writeJson, fixture, tree, png, mockGateway, guarded };
