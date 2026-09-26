'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const identity = require('./runtime-identity.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const live = child => Boolean(child?.pid && child.exitCode === null && child.signalCode === null);

function createRuntime({ config, onEvent = () => {} }) {
  identity.isolatedDirectories(config);
  const sourceProfileId = identity.profileId(config.userData);
  let current, pendingStart, port = config.gatewayPort || 0, generation = 0;
  let disposed = false, paused = false, ready = false, recoveryTimer, recoveryAttempts = 0, stopping;
  const state = () => ({ connection: ready ? 'ready' : 'unavailable', pid: current?.child.pid || null,
    generation, port, origin: port ? `http://127.0.0.1:${port}` : null,
    runtimeEpoch: ready ? current.epoch : null, owned: Boolean(current && live(current.child)) });
  function recover() {
    if (disposed || paused || recoveryTimer || recoveryAttempts >= 3) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      void start().catch(() => recover());
    }, 400 * 2 ** recoveryAttempts++);
  }
  function hostInput(action, role = 'atelier', extra = {}) {
    if (!identity.ROLES.has(role)) throw new Error('HOST_ROLE_DENIED');
    if (action !== 'session' && role !== 'atelier') throw new Error('HOST_ROLE_DENIED');
    return { action, windowId: role, origin: identity.ORIGIN, sourceProfileId, ...extra };
  }
  async function request(action, role, extra, timeoutMs) {
    const owner = current;
    if (!owner || !live(owner.child) || !ready) throw new Error('Runtime unavailable');
    const result = await identity.hostRequest(port, owner.secret, hostInput(action, role, extra), timeoutMs);
    if (current !== owner || !live(owner.child)) throw new Error('Runtime epoch changed');
    owner.snapshot = identity.ownerSnapshot(config.configRoot, owner.child.pid) || owner.snapshot;
    return result;
  }
  async function start() {
    if (disposed) throw new Error('Runtime is disposed');
    paused = false;
    if (stopping) await stopping;
    if (ready && current && live(current.child)) return state();
    if (pendingStart) return pendingStart;
    pendingStart = (async () => {
      const attempt = ++generation;
      if (disposed || attempt !== generation) throw new Error('Runtime start cancelled');
      // Reuse exactly the owned port on recovery. A conflict is a refusal, never
      // permission to attach to or terminate an unrelated service.
      port = await identity.freePort(port);
      if (disposed || attempt !== generation) throw new Error('Runtime start cancelled');
      const secret = identity.randomSecret();
      const runtimeRoot = path.join(config.configRoot, 'gateway');
      fs.mkdirSync(runtimeRoot, { recursive: true });
      const log = fs.openSync(path.join(config.configRoot, 'electron-runtime.log'), 'a');
      const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), AICS_APP_ROOT: config.gatewayRoot,
        AICS_ASSETS_ROOT: config.assetsRoot, AICS_TOOLS_ROOT: path.join(config.gatewayRoot, 'tools'),
        AICS_SCRIPTS_ROOT: path.join(config.gatewayRoot, 'scripts'), AICS_RUNTIME_ROOT: runtimeRoot,
        AICS_DESKTOP_CONFIG_ROOT: config.configRoot, AICS_DESKTOP_SOURCE_PROFILE_ID: sourceProfileId,
        AICS_DESKTOP_GATEWAY_TOKEN: secret, AICS_DESKTOP_PACKAGED: '1', AICS_DESKTOP_BUNDLED_UI: '1',
        AICS_DISABLE_LEGACY_RUNTIME_MIGRATION: '1', AI_WORKSPACE_ROOT: config.aiRoot,
        DISABLE_TUNNEL: '1', AUTO_TUNNEL: '0', AICS_CHARACTER_REF_ROOT: path.join(config.aiRoot, 'CharacterReferences') };
      delete env.AICS_DESKTOP_ATTACH_TOKEN; delete env.LIVE2D_SELFTEST;
      const child = spawn(config.nodeExe, [path.join(__dirname, 'runtime-child.cjs'), path.join(config.gatewayRoot, 'server.js')],
        // Windows' default spawn job terminates the process before its IPC
        // disconnect handler can drain SQLite. The detached process has no
        // visible console and must exit through runtime-child's bounded drain.
        { cwd: config.gatewayRoot, env, detached: true, windowsHide: true, stdio: ['ignore', log, log, 'ipc'] });
      fs.closeSync(log);
      const owner = { child, secret, epoch: identity.epoch(secret), generation: attempt, snapshot: null, stopping: false };
      current = owner; ready = false;
      owner.exit = new Promise(resolve => child.once('close', resolve));
      child.on('message', message => { if (message?.type === 'listening') owner.snapshot = identity.ownerSnapshot(config.configRoot, child.pid); });
      child.once('error', error => { owner.error = error; });
      child.once('close', () => {
        identity.releaseExitedOwner(owner.snapshot, child, config.gatewayRoot);
        if (current !== owner) return;
        ready = false; current = null;
        onEvent('aics:gateway-unavailable', null);
        if (!owner.stopping) recover();
      });
      try {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          if (owner.error) throw owner.error;
          if (disposed || generation !== attempt || !live(child)) throw new Error('Gateway startup interrupted');
          if (await identity.health(port, secret).catch(() => false)) {
            if (disposed || generation !== attempt || current !== owner) throw new Error('Gateway startup cancelled');
            ready = true; recoveryAttempts = 0;
            owner.snapshot = identity.ownerSnapshot(config.configRoot, child.pid) || owner.snapshot;
            onEvent('aics:gateway-ready', state().origin); return state();
          }
          await delay(150);
        }
        throw new Error('Gateway did not become healthy');
      } catch (error) { await stopOwner(owner); throw error; }
    })().finally(() => { pendingStart = null; });
    return pendingStart;
  }
  async function stopOwner(owner) {
    if (!owner || owner.stopping) return owner?.exit;
    owner.stopping = true;
    owner.snapshot = identity.ownerSnapshot(config.configRoot, owner.child.pid) || owner.snapshot;
    if (current === owner) ready = false;
    if (!live(owner.child)) return;
    await identity.hostRequest(port, owner.secret, hostInput('shutdown'), 8000).catch(() => {});
    if (owner.child.connected) owner.child.send({ type: 'shutdown' }, () => {});
    await Promise.race([owner.exit, delay(7000)]);
    if (live(owner.child)) { owner.child.kill(); await Promise.race([owner.exit, delay(3000)]); }
    if (live(owner.child)) throw new Error('Owned gateway did not exit');
    identity.releaseExitedOwner(owner.snapshot, owner.child, config.gatewayRoot);
  }
  async function stop() {
    disposed = true; generation++; clearTimeout(recoveryTimer); recoveryTimer = null;
    stopping = stopOwner(current);
    await stopping;
    await pendingStart?.catch(() => {});
    current = null; ready = false;
  }
  async function pause() {
    paused = true; generation++; clearTimeout(recoveryTimer); recoveryTimer = null;
    stopping = stopOwner(current); await stopping;
    await pendingStart?.catch(() => {});
    stopping = null; current = null; ready = false;
  }
  async function restart() {
    if (disposed) throw new Error('Runtime is disposed');
    generation++; clearTimeout(recoveryTimer); recoveryTimer = null;
    stopping = stopOwner(current); await stopping; stopping = null;
    await pendingStart?.catch(() => {});
    return start();
  }
  async function bootstrap(role) {
    if (!identity.ROLES.has(role)) throw new Error('HOST_ROLE_DENIED');
    const owner = current;
    const confirmed = ready && owner && await identity.health(port, owner.secret).catch(() => false);
    if (owner !== current) throw new Error('Runtime epoch changed');
    const response = confirmed ? await request('session', role) : null;
    if (owner !== current) throw new Error('Runtime epoch changed');
    return { protocolVersion: 1, windowRole: role, windowId: role, sourceProfileId, sourceOrigin: identity.ORIGIN,
      bundledUiAvailable: true, connection: confirmed ? 'ready' : 'unavailable',
      runtime: confirmed ? { origin: state().origin, protocolVersion: 1, ownership: 'managed', runtimeEpoch: owner.epoch, workspace: response.workspace } : null };
  }
  return { start, stop, pause, restart, bootstrap, state,
    async prepare(role) { await request('prepare-candidate', role); return bootstrap(role); },
    async activate(role, args) {
      if (!args || !/^[a-f0-9-]{36}$/.test(args.migrationId || '') || typeof args.bundledUi !== 'boolean') throw new Error('Invalid activation request');
      await request('activate', role, { migrationId: args.migrationId, bundledUi: args.bundledUi }, 120000); return bootstrap(role);
    },
    async enableBundled(role) { await request('enable-bundled', role, {}, 120000); return bootstrap(role); },
  };
}
module.exports = { createRuntime };
