'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const { randomUUID }: typeof import('node:crypto') = require('node:crypto');
const { loadResourceConfiguration, publicError }: typeof import('./resource-install-config') = require('./resource-install-config');
const { resolveInstalledResourceRoots }: typeof import('./resource-install-resolver') = require('./resource-install-resolver');
const { createResourceInstaller }: typeof import('./resource-install') = require('./resource-install');
const { createResourceDownloader }: typeof import('./resource-download') = require('./resource-download');
const { completeLive2dPaths }: typeof import('./resource-install-live2d') = require('./resource-install-live2d');
const { releasePolicy, ID }: typeof import('./resource-install-policy') = require('./resource-install-policy');
const { child, noLinks, readJson, writeJson, mkdir, initialize, lockFile, fail }: typeof import('./resource-install-fs') = require('./resource-install-fs');

const ACTIONS = ['import', 'download', 'recover', 'rollback'];
const ACTIVE = ['running', 'cancelling'];
function taskFile(ctx: any) { return child(ctx.store, 'gateway/task.json'); }
function savedTask(ctx: any) {
  const value = readJson(fs, taskFile(ctx), true);
  if (!value) return null;
  if (!/^[a-f\d-]{36}$/.test(value.id || '') || !ACTIONS.includes(value.action)
    || !['running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.state)
    || (value.releaseId !== null && !ID.test(value.releaseId || ''))) fail('STATE_INVALID', 'Invalid resource task');
  return { id: value.id, action: value.action, releaseId: value.releaseId,
    resumeAction: ['download', 'import'].includes(value.resumeAction) ? value.resumeAction : null,
    state: ACTIVE.includes(value.state) ? 'interrupted' : value.state,
    phase: ACTIVE.includes(value.state) ? 'interrupted' : 'settled',
    bytes: 0, total: 0, startedAt: Number(value.startedAt) || 0,
    finishedAt: Number(value.finishedAt) || 0,
    error: ACTIVE.includes(value.state) ? publicError({ code: 'INTERRUPTED' })
      : value.error ? publicError(value.error) : null };
}

// One bounded task record; lifecycle journals/verified partial files remain the recovery source
// of truth. GET/startup never initialize storage. Only explicit local mutations create it.
function createResourceManager(gateway: any) {
  let config: any = null;
  let snapshot: any = null;
  let issue: any = null;
  let task: any = null;
  let active: any = null;
  let closed = false;
  let settled = Promise.resolve();
  let modelGroups: any = [];
  let previousAvailable = false;
  let lastInstalled: any = null;

  function refresh() {
    if (active) return;
    config = null;
    task = null;
    previousAvailable = false;
    snapshot = null;
    modelGroups = [];
    issue = null;
    try {
      config = loadResourceConfiguration(gateway);
      if (!config) { task = null; return; }
      task = savedTask(config.ctx);
      snapshot = resolveInstalledResourceRoots(config.options);
      if (snapshot) {
        lastInstalled = { identity: snapshot.identity, releaseId: snapshot.releaseId, files: snapshot.verifiedFiles };
        previousAvailable = Boolean(snapshot.previousIdentity);
        modelGroups = completeLive2dPaths(snapshot.versionRoot, snapshot.entries, fs);
      }
    } catch (error) { issue = publicError(error); }
  }
  function mount() {
    if (active || closed || !snapshot || !config) return null;
    try {
      if (!config.unchanged()) fail('CONFIG_CHANGED', 'Configuration changed');
      if (noLinks(fs, child(config.ctx.store, 'pending.json'), { missing: true })) fail('PENDING_TRANSACTION', 'Recovery required');
      const locks = child(config.ctx.store, 'locks');
      if (noLinks(fs, locks, { missing: true }) && fs.readdirSync(locks).length) fail('BUSY', 'Writer active');
      const state = readJson(fs, child(config.ctx.store, 'current.json'));
      if (state?.sequence !== snapshot.sequence || state?.current?.identity !== snapshot.identity) fail('STATE_CONFLICT', 'Version changed');
      noLinks(fs, snapshot.versionRoot);
      return { snapshot, modelGroups };
    } catch (error) { snapshot = null; issue = publicError(error); return null; }
  }
  function status(fresh: any = false) {
    if (!active && (fresh || (config && !config.unchanged()))) refresh();
    if (!active && snapshot) mount();
    const recoveryRequired = Boolean(issue && ['PENDING_TRANSACTION', 'BUSY', 'STATE_CONFLICT'].includes(issue.code))
      || Boolean(task && ['interrupted', 'cancelled', 'failed'].includes(task.state));
    return { ok: true, configured: Boolean(config), managementEnabled: Boolean(config && gateway.RESOURCE_MANAGEMENT && !closed),
      busy: Boolean(active), mounted: Boolean(snapshot && !active),
      current: snapshot ? { identity: snapshot.identity, releaseId: snapshot.releaseId, files: snapshot.verifiedFiles } : active ? lastInstalled : null,
      canRollback: previousAvailable, recoveryRequired, issue,
      releases: (config?.releases || []).map((release: any) => ({ ...release,
        downloaded: release.source === 'http' && cachePresent(release.id) })),
      task: task ? structuredClone(task) : null };
  }
  function cachePresent(id: any) {
    try {
      const release = releasePolicy(config.ctx, id);
      const file = child(config.ctx.store, 'downloads/' + release.packageIdentity + '/complete.json');
      return readJson(fs, file, true)?.packageIdentity === release.packageIdentity;
    } catch { return false; }
  }
  function save() { writeJson(fs, taskFile(config.ctx), task); }
  function start(action: any, releaseId: any, localAuthorized: any) {
    if (closed || localAuthorized !== true) fail('ACCESS_DENIED', 'Local authorization required');
    if (gateway.RESOURCE_MANAGEMENT !== true) fail('MANAGEMENT_DISABLED', 'Operator must enable management');
    if (active) fail('BUSY', 'A resource task is active');
    if (!ACTIONS.includes(action)) fail('USAGE', 'Unknown action');
    refresh();
    if (!config) fail('CONFIG_REQUIRED', 'Resource policy required');
    const priorTask = task;
    let resumeAction = null;
    if (action === 'recover' && priorTask && ['download', 'recover'].includes(priorTask.action)
      && (priorTask.action === 'download' || priorTask.resumeAction === 'download')
      && ['interrupted', 'cancelled', 'failed'].includes(priorTask.state)
      && !noLinks(fs, child(config.ctx.store, 'pending.json'), { missing: true })) {
      resumeAction = 'download'; releaseId = priorTask.releaseId;
    }
    if (action === 'import' || action === 'download' || resumeAction === 'download') releasePolicy(config.ctx, releaseId);
    if (action === 'recover' && (priorTask?.action === 'import' || priorTask?.resumeAction === 'import') && priorTask.releaseId
      && ['interrupted', 'cancelled', 'failed'].includes(priorTask.state)
      && !noLinks(fs, child(config.ctx.store, 'pending.json'), { missing: true })) {
      resumeAction = 'import'; releaseId = priorTask.releaseId;
      releasePolicy(config.ctx, releaseId);
    }
    const controller = new AbortController();
    const operationConfig = config;
    initialize(config.ctx);
    const releaseGate = lockFile(config.ctx, 'gateway');
    try {
      mkdir(fs, child(config.ctx.store, 'gateway'));
      task = { id: randomUUID(), action, releaseId: releaseId || null, resumeAction,
        state: 'running', phase: 'checking', bytes: 0, total: 0, startedAt: Date.now(), finishedAt: 0, error: null };
      save();
    } catch (error) { releaseGate(); throw error; }
    snapshot = null; modelGroups = [];
    active = controller;
    const options = { ...config.options,
      access: { isLocalStudioHost: () => localAuthorized === true,
        isAuthorized: () => !closed && gateway.RESOURCE_MANAGEMENT === true && operationConfig.unchanged() },
      onEvent: (event: any) => {
        task.phase = event.phase;
        task.bytes = Number.isSafeInteger(event.bytes) ? event.bytes : 0;
        task.total = Number.isSafeInteger(event.total) ? event.total : 0;
        // Avoid a metadata write for every chunk; lifecycle partials/journals are durable.
      } };
    const accepted = structuredClone(task);
    settled = new Promise(resolve => setImmediate(resolve)).then(async () => {
      const installer: any = createResourceInstaller(options);
      const request = { releaseId, signal: controller.signal };
      if (action === 'download' || resumeAction === 'download') await createResourceDownloader(options).download(request);
      else if (action === 'import' || resumeAction === 'import') await installer.install(request);
      else await installer[action](request);
      task.state = 'completed';
    }).catch(error => {
      task.state = error.code === 'CANCELLED' || controller.signal.aborted ? 'cancelled' : 'failed';
      task.error = publicError(task.state === 'cancelled' ? { code: 'CANCELLED' } : error);
    }).finally(() => {
      task.finishedAt = Date.now(); task.phase = 'settled';
      try { save(); } catch (error) { task.state = 'failed'; task.error = publicError(error); }
      try { releaseGate(); } catch (error) { issue = publicError(error); }
      active = null;
      if (!closed) refresh();
    });
    return accepted;
  }
  function cancel(id: any, localAuthorized: any) {
    if (localAuthorized !== true || !config?.unchanged() || !gateway.RESOURCE_MANAGEMENT) fail('ACCESS_DENIED', 'Local authorization required');
    if (!task || task.id !== id) fail('TASK_NOT_FOUND', 'Task not found');
    if (active) { task.state = 'cancelling'; active.abort(); }
    return structuredClone(task);
  }
  refresh();
  return { status, start, cancel, mount,
    invalidate(error: any) { snapshot = null; issue = publicError(error); },
    close() { closed = true; active?.abort(); return settled; },
    settled() { return settled; } };
}
export = { createResourceManager };
