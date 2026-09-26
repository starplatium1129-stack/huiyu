'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { isolatedDirectories } = require('./runtime-identity.cjs');
const { translate, inactive } = require('./live2d-commands.cjs');
const MAX_BYTES = 64 * 1024, MAX_PENDING = 32;
const EVENTS = new Set(['ready', 'stopped', 'hit-test', 'motion-started', 'motion-failed', 'entrance-finished'].map(name => 'aics:live2d:' + name));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function createNativeRenderer({ config, onEvent = () => {}, getCompanionHwnd }) {
  isolatedDirectories(config);
  let current, pendingStart, stopping, generation = 0, nextId = 0, revision = 0, lastFrame, disposed = false;
  function alive(owner) { return owner && !owner.closed && owner.child.exitCode === null && owner.child.signalCode === null; }
  function finish(owner, reason) {
    if (owner.closed) return;
    owner.closed = true;
    for (const entry of owner.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    owner.pending.clear();
    if (current === owner) {
      current = null;
      onEvent('aics:live2d:stopped', { reason });
    }
  }
  function request(owner, payload, timeoutMs = 5000) {
    if (!alive(owner)) return Promise.reject(new Error('Renderer host unavailable'));
    if (owner.pending.size >= MAX_PENDING || owner.child.stdin.writableLength > MAX_BYTES) return Promise.reject(new Error('Renderer queue is full'));
    const id = ++nextId, bytes = Buffer.from(JSON.stringify({ id, ...payload }) + '\n');
    if (bytes.length >= MAX_BYTES) return Promise.reject(new Error('Renderer message exceeds limit'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // No uncertain command is replayed. Closing the probe's stdin invokes
        // the verified R12 supervisor cleanup and Windows child job ownership.
        finish(owner, 'Renderer request timed out'); owner.child.stdin.end(); owner.child.kill();
      }, timeoutMs);
      owner.pending.set(id, { resolve, reject, timer });
      owner.child.stdin.write(bytes, error => { if (error) { finish(owner, 'Renderer stdin disconnected'); owner.child.stdin.end(); } });
    });
  }
  function startProbe() {
    const log = fs.openSync(path.join(config.configRoot, 'electron-live2d.log'), 'a');
    const child = spawn(config.nativeExe, ['--live2d-renderer-probe-host'], { cwd: config.pocRoot, windowsHide: true,
      env: { ...process.env, AICS_LIVE2D_RENDERER_PROCESS: '1', AICS_DESKTOP_CONFIG_ROOT: config.configRoot,
        AICS_DESKTOP_WEBVIEW_DATA_DIR: config.userData }, stdio: ['pipe', 'pipe', log] });
    fs.closeSync(log);
    const owner = { child, generation: ++generation, pending: new Map(), buffer: Buffer.alloc(0), closed: false, initialized: false, diagnostics: null };
    current = owner;
    owner.exited = new Promise(resolve => child.once('close', resolve));
    child.once('error', error => finish(owner, 'Renderer host failed: ' + error.message));
    child.once('close', () => finish(owner, 'Renderer host exited'));
    child.stdin.on('error', () => finish(owner, 'Renderer stdin failed'));
    child.stdout.on('data', chunk => {
      if (current !== owner || owner.closed) return;
      owner.buffer = Buffer.concat([owner.buffer, chunk]);
      let end;
      while ((end = owner.buffer.indexOf(10)) !== -1) {
        if (current !== owner || owner.closed) return;
        if (end >= MAX_BYTES) { finish(owner, 'Renderer protocol exceeds limit'); child.stdin.end(); return; }
        const line = owner.buffer.subarray(0, end); owner.buffer = owner.buffer.subarray(end + 1);
        let message;
        try { message = JSON.parse(line.toString('utf8')); } catch { finish(owner, 'Invalid renderer protocol'); child.stdin.end(); return; }
        if (message.type === 'event' && EVENTS.has(message.name)) {
          if (message.name === 'aics:live2d:stopped') owner.initialized = false;
          onEvent(message.name, message.payload);
        } else if (message.type === 'reply') {
          const entry = owner.pending.get(message.id); if (!entry) continue;
          clearTimeout(entry.timer); owner.pending.delete(message.id);
          if (message.result && Object.hasOwn(message.result, 'Ok')) entry.resolve(message.result.Ok);
          else entry.reject(new Error(typeof message.result?.Err === 'string' ? message.result.Err : 'Renderer request failed'));
        } else { finish(owner, 'Unexpected renderer protocol'); child.stdin.end(); return; }
      }
      if (owner.buffer.length >= MAX_BYTES) { finish(owner, 'Renderer protocol exceeds limit'); child.stdin.end(); }
    });
    return owner;
  }
  async function ensureStarted() {
    if (disposed) throw new Error('Native renderer is closed');
    if (stopping) await stopping;
    if (disposed) throw new Error('Native renderer is closed');
    if (pendingStart) return pendingStart;
    if (alive(current) && current.initialized) return current;
    const owner = alive(current) ? current : startProbe();
    const expectedRevision = revision;
    pendingStart = request(owner, { op: 'start', assets_root: config.assetsRoot,
      local_root: path.join(config.configRoot, 'gateway/live2d-imports') }, 40000).then(diagnostics => {
      if (disposed || revision !== expectedRevision || current !== owner || owner.closed) throw new Error('Renderer start cancelled');
      owner.initialized = true; owner.diagnostics = diagnostics; return owner;
    }).finally(() => { pendingStart = null; });
    return pendingStart;
  }
  async function send(owner, command, timeoutMs = 5000) {
    const result = await request(owner, { op: 'call', command, timeout_ms: timeoutMs }, timeoutMs + 1000);
    if (current !== owner || owner.closed) throw new Error('Renderer generation changed');
    owner.diagnostics = result.rendererProcess; return result.value;
  }
  async function call(command, args = {}) {
    if (disposed) throw new Error('Native renderer is closed');
    const translated = translate(command, args ?? {}, getCompanionHwnd);
    if (translated.type === 'setFrame') lastFrame = translated;
    if (translated.type === 'setCharacter') {
      const owner = await ensureStarted();
      const result = await send(owner, translated, 45000);
      if (lastFrame) await send(owner, { ...lastFrame, companion_hwnd: translate('aics_live2d_set_frame', {
        rect: lastFrame.rect, visible: lastFrame.visible, opacity: lastFrame.opacity == null ? null : lastFrame.opacity / 255,
        framing: lastFrame.framing }, getCompanionHwnd).companion_hwnd });
      return result;
    }
    if (!alive(current) || !current.initialized) {
      if (translated.type === 'getState') return inactive();
      if (translated.type === 'destroy' || translated.type === 'setFrame') return null;
      throw new Error('Renderer not attached');
    }
    return send(current, translated);
  }
  async function stop() {
    if (stopping) return stopping;
    revision++; const owner = current;
    if (!owner) return;
    stopping = (async () => {
      finish(owner, 'Companion renderer detached'); owner.child.stdin.end();
      await Promise.race([owner.exited, delay(4000)]);
      if (owner.child.exitCode === null && owner.child.signalCode === null) {
        owner.child.kill(); await Promise.race([owner.exited, delay(2000)]);
      }
      await pendingStart?.catch(() => {});
      lastFrame = undefined;
    })().finally(() => { stopping = null; });
    return stopping;
  }
  return { call, stop,
    async close() { disposed = true; await stop(); },
    async diagnostics() {
      if (!alive(current)) return { active: false, hostPid: null, childPid: null, generation };
      const owner = current, result = await request(owner, { op: 'status' });
      return { ...result, hostPid: owner.child.pid, clientGeneration: owner.generation, pending: owner.pending.size };
    },
    async terminateRenderer() { if (alive(current)) await request(current, { op: 'kill' }); },
    async snapshot(label) {
      if (!/^[a-z0-9-]{1,80}$/.test(label)) throw new Error('Invalid snapshot name');
      if (!alive(current) || !current.initialized) throw new Error('Renderer not attached');
      const directory = path.join(config.pocRoot, 'snapshots'); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, label + '.png');
      await send(current, { type: 'snapshot', path: file }, 15000); return file;
    },
  };
}
module.exports = { createNativeRenderer };
