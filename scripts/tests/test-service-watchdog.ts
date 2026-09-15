'use strict';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('assert') = require('assert');
const { createServiceWatchdog }: typeof import('../../services/service-watchdog.js') = require('../../services/service-watchdog.js');

function fakeService(name: string, state: { online: unknown; managed: unknown; failRestart?: unknown; }) {
  const calls = { probe: 0, restart: 0 };
  return {
    name,
    calls,
    probe: async function () {
      calls.probe += 1;
      return state.online;
    },
    restart: async function () {
      calls.restart += 1;
      if (state.failRestart) return { ok: false, error: 'simulated restart failure' };
      state.online = true;
      return { ok: true };
    },
    shouldManage: function () { return state.managed; }
  };
}

function sleep(ms: number|undefined) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

test('service watchdog: never-online services are not auto-restarted', async () => {
  const state = { online: false, managed: true };
  const service = fakeService('tts', state);
  const events: { service: string; kind: "down"|"restarted"|"restart-failed"; attempt?: number; error?: string; }[] = [];
  const watchdog = createServiceWatchdog({
    services: [service],
    intervalMs: 50,
    maxBackoffMs: 120,
    onEvent: (event) => events.push(event),
  });
  watchdog.start();
  await sleep(260);
  watchdog.stop();
  assert.strictEqual(service.calls.restart, 0, 'offline-from-start must not restart');
  assert.strictEqual(events.some((event) => event.kind === 'down'), false);
});

test('service watchdog: online-to-offline restarts with backoff and resets on health', async () => {
  const state = { online: true, managed: true };
  const service = fakeService('translation', state);
  const events: { service: string; kind: "down"|"restarted"|"restart-failed"; attempt?: number; error?: string; }[] = [];
  const watchdog = createServiceWatchdog({
    services: [service],
    intervalMs: 50,
    maxBackoffMs: 120,
    onEvent: (event) => events.push(event),
  });
  watchdog.start();
  await sleep(150); // 先建立 wasHealthy
  assert.strictEqual(service.calls.probe > 0, true);
  state.online = false;
  await sleep(320); // 触发 down + 一次重启（50ms 退避）
  assert.strictEqual(service.calls.restart, 1, 'one restart must be triggered after going down');
  assert.strictEqual(events.some((event) => event.kind === 'down'), true);
  assert.strictEqual(events.some((event) => event.kind === 'restarted'), true);
  assert.strictEqual(watchdog.status().services.translation.restarting, false);
  assert.strictEqual(watchdog.status().services.translation.attempt, 0);
  assert.ok(watchdog.status().services.translation.lastRestartAt > 0);
  watchdog.stop();
});

test('service watchdog: failed restart backs off and retries', async () => {
  const state = { online: true, managed: true, failRestart: true };
  const service = fakeService('tts', state);
  const watchdog = createServiceWatchdog({
    services: [service],
    intervalMs: 50,
    maxBackoffMs: 120,
  });
  watchdog.start();
  await sleep(150); // 先建立 wasHealthy
  state.online = false;
  await sleep(600);
  assert.strictEqual(service.calls.restart >= 2, true, 'failed restart must be retried with backoff');
  assert.strictEqual(watchdog.status().services.tts.attempt >= 1, true);
  assert.ok(watchdog.status().services.tts.lastError.length > 0);
  watchdog.stop();
});

test('service watchdog: stop clears timers and reports stopped', async () => {
  const state = { online: true, managed: true };
  const service = fakeService('tts', state);
  const watchdog = createServiceWatchdog({
    services: [service],
    intervalMs: 50,
    maxBackoffMs: 120,
  });
  watchdog.start();
  await sleep(150);
  watchdog.stop();
  const before = service.calls.probe;
  await sleep(200);
  assert.strictEqual(service.calls.probe, before, 'stop() must clear the interval');
  assert.strictEqual(watchdog.status().running, false);
});
