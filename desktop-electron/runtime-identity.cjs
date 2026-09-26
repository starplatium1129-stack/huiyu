'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const ORIGIN = 'https://huiyu.localhost';
const ROLES = new Set(['atelier', 'companion', 'companion-chat']);
const randomSecret = () => crypto.randomBytes(32).toString('hex');
const epoch = secret => crypto.createHash('sha256').update('aics-runtime-epoch:v1:' + secret).digest('hex');

function isolatedDirectories(config) {
  if (!config.pocRoot || !path.isAbsolute(config.pocRoot)) throw new Error('Explicit absolute PoC root required');
  fs.mkdirSync(config.pocRoot, { recursive: true });
  const root = fs.realpathSync(config.pocRoot);
  for (const key of ['configRoot', 'userData', 'aiRoot']) {
    const directory = config[key];
    if (!directory || !path.isAbsolute(directory)) throw new Error('Missing isolated ' + key);
    const relative = path.relative(root, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(key + ' leaves PoC root');
    fs.mkdirSync(directory, { recursive: true });
    const canonical = path.relative(root, fs.realpathSync(directory));
    if (!canonical || canonical.startsWith('..') || path.isAbsolute(canonical)) throw new Error(key + ' resolves outside PoC root');
  }
}
function profileId(directory) {
  const file = path.join(directory, '.huiyu-source-profile');
  try { fs.writeFileSync(file, 'profile-' + randomSecret(), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid profile identity');
  const value = fs.readFileSync(file, 'utf8');
  if (!/^profile-[a-f0-9]{64}$/.test(value)) throw new Error('Invalid profile identity');
  return value;
}
function requestJson(port, route, { method = 'GET', headers = {}, body, timeoutMs = 3000, limit = 32768 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: route, method, headers,
      signal: AbortSignal.timeout(timeoutMs) }, response => {
      let length = 0; const chunks = [];
      response.on('data', chunk => {
        length += chunk.length;
        if (length > limit) { response.destroy(new Error('Runtime response exceeds limit')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error('Runtime request refused: ' + response.statusCode));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid runtime response')); }
      });
    });
    request.on('error', reject); request.end(body);
  });
}
async function health(port, secret) {
  const challenge = randomSecret();
  const response = await requestJson(port, '/api/health', { headers: { 'x-aics-desktop-challenge': challenge }, limit: 16384 });
  const proof = response.desktopProof;
  if (response.ok !== true || response.app !== 'ai-cg-studio' || response.desktopProtocol !== 1 || !/^[a-f0-9]{64}$/.test(proof || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(proof, 'hex'), crypto.createHmac('sha256', secret).update(challenge).digest());
}
function hostRequest(port, secret, input, timeoutMs = 3000) {
  const body = JSON.stringify({ ...input, timestamp: Date.now(), nonce: randomSecret() });
  const proof = crypto.createHmac('sha256', secret).update('aics-desktop-host:v1\n' + body).digest('hex');
  return requestJson(port, '/api/desktop-host', { method: 'POST', timeoutMs, body,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-aics-host-proof': proof } });
}
function freePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(preferred, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}
function ownerSnapshot(configRoot, pid) {
  try {
    const pointerFile = ['workspace-active.json', 'workspace-candidate.json'].map(name => path.join(configRoot, name)).find(fs.existsSync);
    if (!pointerFile) return null;
    const id = JSON.parse(fs.readFileSync(pointerFile)).workspaceId;
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    const directory = path.join(configRoot, 'workspaces', id);
    if ([configRoot, path.dirname(directory), directory].some(file => fs.lstatSync(file).isSymbolicLink())) return null;
    const file = path.join(directory, '.workspace-owner.json');
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    const bytes = fs.readFileSync(file), owner = JSON.parse(bytes);
    return owner.workspaceId === id && owner.pid === pid && typeof owner.nonce === 'string' && owner.nonce && Number.isFinite(owner.startedAt)
      ? { file, bytes, root: directory, owner } : null;
  } catch { return null; }
}
function releaseExitedOwner(snapshot, child, gatewayRoot) {
  if (!snapshot || child.exitCode === null && child.signalCode === null) return;
  try {
    if (!fs.readFileSync(snapshot.file).equals(snapshot.bytes)) return;
    // Reuse the workspace authority's exact ChildProcess/nonce lease recovery;
    // this shell never implements another lock-removal policy.
    const { releaseExitedWorkspaceOwner } = require(path.join(gatewayRoot, 'server/workspace/owner.js'));
    releaseExitedWorkspaceOwner(snapshot.root, snapshot.owner, child);
  } catch { /* Already drained or ownership no longer matches; retain unknown locks. */ }
}
module.exports = { ORIGIN, ROLES, randomSecret, epoch, isolatedDirectories, profileId, health, hostRequest, freePort, ownerSnapshot, releaseExitedOwner };
