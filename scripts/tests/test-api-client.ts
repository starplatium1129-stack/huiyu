'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');
const { ref }: typeof import('vue') = require('vue');
const {
  ApiClientError,
  createApiClient,
}: typeof import('../../src/api/client.ts') = require('../../src/api/client.ts');
const {
  CONTROL_API_TIMEOUTS,
  createControlApi,
}: typeof import('../../src/api/controlApi.ts') = require('../../src/api/controlApi.ts');
const {
  MAINTENANCE_API_TIMEOUTS,
  createMaintenanceApi,
  maintenanceFailure,
}: typeof import('../../src/api/maintenanceApi.ts') = require('../../src/api/maintenanceApi.ts');
const { CHAT_API_TIMEOUTS, createChatApi }: typeof import('../../src/api/chatApi.ts') = require('../../src/api/chatApi.ts');
const { VOICE_API_TIMEOUTS, createVoiceApi }: typeof import('../../src/api/voiceApi.ts') = require('../../src/api/voiceApi.ts');
const { MEDIA_STATUS_API_TIMEOUT, createMediaStatusApi }: typeof import('../../src/api/mediaStatusApi.ts') = require('../../src/api/mediaStatusApi.ts');
const { GENERATION_API_TIMEOUTS, createGenerationApi }: typeof import('../../src/api/generationApi.ts') = require('../../src/api/generationApi.ts');
const { useControlActions }: typeof import('../../src/composables/useControlActions.ts') = require('../../src/composables/useControlActions.ts');
const { useControlStatus }: typeof import('../../src/composables/useControlStatus.ts') = require('../../src/composables/useControlStatus.ts');

const root = path.resolve(__dirname, '..', '..');

function jsonResponse(body: any, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function pendingFetch(signals: any) {
  return (_url: unknown, init: any) => new Promise((_resolve, reject) => {
    signals.push(init.signal);
    init.signal.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}

function controlStatus(overrides = {}) {
  return {
    ok: true,
    running: true,
    sdOnline: true,
    comfyOnline: true,
    ttsOnline: true,
    ollamaOnline: true,
    ollamaModels: ['model'],
    ollamaVram: 1024,
    webuiManaged: false,
    comfyManaged: false,
    modeBusy: false,
    operation: null,
    sdHost: 'http://127.0.0.1:7860',
    comfyHost: 'http://127.0.0.1:8188',
    ttsHost: 'http://127.0.0.1:9880',
    ollamaHost: 'http://127.0.0.1:11434',
    localLink: 'http://127.0.0.1:3000/',
    shareLinkAvailable: false,
    tunnelStatus: 'disabled',
    tunnelAvailable: false,
    uptime: 1,
    voices: {},
    scripts: { voiceStart: true, voiceStop: true, webui: true, comfy: true },
    ...overrides,
  };
}

test('client accepts a 200 JSON object without an ok field', async () => {
  const client = createApiClient(async () => jsonResponse({ value: 42 }));
  assert.deepEqual(await client.request('/success'), { value: 42 });
});

test('phase 2 APIs accept real successful status and translation objects without ok', async () => {
  const payloads = [
    { online: true, model: 'ollama-model', models: [{ name: 'ollama-model' }] },
    { online: false, voices: { nene: false, natsume: false }, translation: { ready: false } },
    { models: { nene: { available: true } } },
    { online: false, checkpoint: '', models: [], samplers: [], schedulers: [], upscalers: [] },
    { sourceLanguage: 'zh', targetLanguage: 'ja', translation: 'こんにちは', segments: [] },
  ];
  const client = createApiClient(async () => jsonResponse(payloads.shift()));
  assert.equal((await createChatApi(client).getStatus()).model, 'ollama-model');
  assert.equal((await createVoiceApi(client).getStatus()).online, false);
  assert.ok((await createMediaStatusApi(client).getLive2DStatus()).models.nene);
  assert.equal((await createMediaStatusApi(client).getSDStatus()).online, false);
  assert.equal((await createVoiceApi(client).translate('你好')).translation, 'こんにちは');
});

test('provider test keeps ApiClientError error and detail for failed envelopes', async () => {
  const client = createApiClient(async () => jsonResponse({
    ok: false, error: 'API 连接失败', detail: '上游返回 401', code: 'UPSTREAM_AUTH',
  }, 421));
  await assert.rejects(createChatApi(client).testProvider({ baseUrl: 'https://example.test', model: 'm', apiKey: 'secret' }), error => {
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.status, 421);
    assert.equal(error.detail, '上游返回 401');
    assert.match(error.message, /API 连接失败：上游返回 401/);
    return true;
  });
});

test('host config validates public fields, rejects apiKey leakage, and uses correct clear/save requests', async () => {
  const calls: any = [];
  const responses = [
    jsonResponse({ ok: true, configured: true, model: 'host-model', baseUrl: 'https://host.test/v1' }),
    jsonResponse({ ok: true, configured: false }),
  ];
  const client = createApiClient(async (url, init) => {
    calls.push({ url: String(url), init });
    return responses.shift();
  });
  const api = createChatApi(client);
  const saved = await api.saveHostConfig({ baseUrl: 'https://host.test/v1', model: 'host-model', apiKey: 'secret' });
  assert.equal(saved.baseUrl, 'https://host.test/v1');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { baseUrl: 'https://host.test/v1', model: 'host-model', apiKey: 'secret' });
  await api.clearHostConfig();
  assert.equal(calls[1].init.method, 'DELETE');
  assert.equal(calls[1].init.body, undefined);

  const unconfigured = createChatApi(createApiClient(async () => jsonResponse({ ok: true, configured: false })));
  const empty = await unconfigured.getHostConfig();
  assert.equal(empty.configured, false);
  assert.equal(empty.model, undefined);
  assert.equal(empty.baseUrl, undefined);

  for (const response of [
    { ok: true, configured: true, baseUrl: 'https://host.test' },
    { ok: true, configured: true, model: 'm' },
  ]) {
    const invalidConfigured = createChatApi(createApiClient(async () => jsonResponse(response)));
    await assert.rejects(invalidConfigured.getHostConfig(), error => error instanceof ApiClientError && error.kind === 'invalid-response');
    await assert.rejects(invalidConfigured.saveHostConfig({ baseUrl: 'u', model: 'm', apiKey: 'secret' }), error => error instanceof ApiClientError && error.kind === 'invalid-response');
  }

  for (const response of [
    { ok: true, configured: true, model: 'm', baseUrl: 'https://host.test', apiKey: 'must-not-appear' },
    { ok: true, configured: false, apiKey: 'must-not-appear' },
  ]) {
    const leaking = createChatApi(createApiClient(async () => jsonResponse(response)));
    await assert.rejects(leaking.getHostConfig(), error => error instanceof ApiClientError && error.kind === 'invalid-response');
  }
});

test('phase 2 timeout baselines keep status short and prepare/translate at least 190 seconds', () => {
  assert.ok(CHAT_API_TIMEOUTS.status <= 10_000);
  assert.ok(CHAT_API_TIMEOUTS.host <= 10_000);
  assert.ok(CHAT_API_TIMEOUTS.providerTest <= 30_000);
  assert.ok(VOICE_API_TIMEOUTS.status <= 10_000);
  assert.ok(VOICE_API_TIMEOUTS.prepare >= 190_000);
  assert.ok(VOICE_API_TIMEOUTS.translate >= 190_000);
  assert.ok(MEDIA_STATUS_API_TIMEOUT <= 10_000);
});

test('generation API owns the application generation job endpoints with envelope validation', async () => {
  const calls: any = [];
  const client = createApiClient(async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return jsonResponse({ ok: true, online: true, checkpoint: 'wai', samplers: ['Euler a'], schedulers: [], capabilities: { hiresUpscalers: ['Auto'] } });
    }
    if (calls.length === 2) {
      return jsonResponse({ ok: true, job: { id: 'job-1', status: 'queued', provider: 'comfy' } }, 202);
    }
    if (calls.length === 3) {
      return jsonResponse({ ok: true, job: { id: 'job-1', status: 'succeeded', provider: 'comfy', resultUrl: '/r.png' } });
    }
    return jsonResponse({ ok: true, job: { id: 'job-1', status: 'cancelled', provider: 'comfy' } });
  });
  const api = createGenerationApi(client);

  const status = await api.getStatus();
  assert.equal(status.online, true);
  assert.equal(calls[0].init.method, undefined);
  assert.equal(calls[0].url, '/api/generation/status');

  const created = await api.createJob({ prompt: '1girl', steps: 28, cfg: 5.5 });
  assert.equal(created.job.id, 'job-1');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].url, '/api/generation/jobs');
  assert.deepEqual(JSON.parse(calls[1].init.body), { prompt: '1girl', steps: 28, cfg: 5.5 });

  const polled = await api.getJob('job-1');
  assert.equal(polled.job.status, 'succeeded');
  assert.equal(calls[2].url, '/api/generation/jobs/job-1');

  await api.deleteJob('job-1');
  assert.equal(calls[3].init.method, 'DELETE');
  assert.equal(calls[3].url, '/api/generation/jobs/job-1');
});

test('generation API rejects malformed status and job envelopes', async () => {
  const badStatus = createGenerationApi(createApiClient(async () => jsonResponse({ ok: true, online: true })));
  await assert.rejects(badStatus.getStatus(), error => error instanceof ApiClientError && error.kind === 'invalid-response');

  const badJob = createGenerationApi(createApiClient(async () => jsonResponse({ ok: true, job: { status: 'queued' } }, 202)));
  await assert.rejects(badJob.createJob({ prompt: 'x' }), error => error instanceof ApiClientError && error.kind === 'invalid-response');

  const failedJob = createGenerationApi(createApiClient(async () => jsonResponse({ ok: false, error: '资源不可用', code: 'COMFY_RESOURCES_UNAVAILABLE' }, 503)));
  await assert.rejects(failedJob.createJob({ prompt: 'x' }), error => error instanceof ApiClientError && error.kind === 'http' && error.status === 503 && error.code === 'COMFY_RESOURCES_UNAVAILABLE');
});

test('generation API timeout baselines keep status/job probes short and creation generous', () => {
  assert.ok(GENERATION_API_TIMEOUTS.status <= 15_000);
  assert.ok(GENERATION_API_TIMEOUTS.job <= 15_000);
  assert.ok(GENERATION_API_TIMEOUTS.create >= 60_000);
});

test('translate caller abort maps to aborted and passes the caller signal through', async () => {
  let requestSignal: any;
  const client = createApiClient(async (_url, init) => {
    requestSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  });
  const controller = new AbortController();
  const request = createVoiceApi(client).translate('你好', { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, error => error instanceof ApiClientError && error.kind === 'aborted');
  assert.equal(requestSignal.aborted, true);
});

test('phase 2 callers do not keep ordinary JSON endpoint fetches, while TTS and sdapi remain allowed', () => {
  const scopedFiles = [
    'src/composables/chat/useChatProvider.ts',
    'src/components/ChatApiSettings.vue',
    'src/components/VoiceStudio.vue',
    'src/composables/useVoice.ts',
    'src/composables/useLive2D.ts',
    'src/composables/generation/useSDGenerate.ts',
  ];
  const ordinaryEndpoint = /fetch\s*\(\s*['"]\/api\/(?:chat-status|chat-provider|tts-status|voice\/prepare|translate|live2d-status|sd-status)/;
  for (const relativePath of scopedFiles) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(source, ordinaryEndpoint, `${relativePath} must use phase 2 API modules`);
  }
  const voice = fs.readFileSync(path.join(root, 'src/composables/useVoice.ts'), 'utf8');
  assert.match(voice, /preparing\s*=\s*voiceApi\.prepare/);
  assert.match(voice, /prepareKey !== key/);
  assert.match(voice, /voiceApi\.translate/);
  assert.match(voice, /translationFailed/);
});

test('client maps standard 400/409/501/504 envelopes without losing fields', async () => {
  for (const status of [400, 409, 501, 504]) {
    const client = createApiClient(async () => jsonResponse({
      ok: false,
      error: `failure-${status}`,
      detail: `detail-${status}`,
      code: `CODE_${status}`,
      retryAfterSeconds: status,
    }, status));
    await assert.rejects(client.request(`/failure-${status}`), error => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.kind, 'http');
      assert.equal(error.status, status);
      assert.equal(error.message, `failure-${status}：detail-${status}`);
      assert.equal(error.detail, `detail-${status}`);
      assert.equal(error.code, `CODE_${status}`);
      assert.equal(error.retryAfterSeconds, status);
      return true;
    });
  }
});

test('client rejects an explicit 200 ok:false response by default', async () => {
  const client = createApiClient(async () => jsonResponse({ ok: false, error: 'degraded' }));
  await assert.rejects(
    client.request('/explicit-failure'),
    error => error instanceof ApiClientError && error.kind === 'http' && error.status === 200,
  );
});

test('only controlApi.getStatus accepts a complete 200 degraded status', async () => {
  const degraded = controlStatus({
    ok: false,
    degraded: true,
    error: 'probe failed',
    sdOnline: false,
    ttsOnline: false,
    ollamaOnline: false,
    ollamaModels: [],
    ollamaVram: 0,
  });
  const client = createApiClient(async () => jsonResponse(degraded));
  await assert.rejects(
    client.request('/api/status'),
    error => error instanceof ApiClientError && error.kind === 'http',
  );
  assert.deepEqual(await createControlApi(client).getStatus(), degraded);
});

test('controlApi rejects an incomplete degraded response instead of exposing a generic escape hatch', async () => {
  for (const payload of [
    { ok: false, degraded: true, error: 'probe failed' },
    controlStatus({ ok: false, degraded: true, operation: {} }),
    controlStatus({ ok: false, degraded: true, scripts: {} }),
  ]) {
    const client = createApiClient(async () => jsonResponse(payload));
    await assert.rejects(
      createControlApi(client).getStatus(),
      error => error instanceof ApiClientError && error.kind === 'http' && error.status === 200,
    );
  }
});

test('controlApi accepts the real logs success shape without an ok field', async () => {
  const payload = { logs: ['gateway ready'], total: 1, operation: null };
  const api = createControlApi(createApiClient(async () => jsonResponse(payload)));
  assert.deepEqual(await api.getLogs(0), payload);
});

test('client classifies non-JSON, empty, truncated, array and invalid object shape responses', async () => {
  const fixtures = [
    new Response('<html>nope</html>', { status: 200 }),
    new Response('', { status: 200 }),
    new Response('{"ok":', { status: 200 }),
    new Response('[]', { status: 200 }),
  ];
  for (const response of fixtures) {
    const client = createApiClient(async () => response);
    await assert.rejects(client.request('/invalid'), error => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.kind, 'invalid-response');
      assert.match(error.message, /无效响应/);
      assert.doesNotMatch(error.message, /SyntaxError/);
      return true;
    });
  }

  const client = createApiClient(async () => jsonResponse({ ok: true, value: 'wrong' }));
  await assert.rejects(
    client.request('/bad-shape', { validate: value => typeof value.count === 'number' }),
    error => error instanceof ApiClientError && error.kind === 'invalid-response',
  );
});

test('client maps a fetch rejection to network', async () => {
  const client = createApiClient(async () => { throw new TypeError('socket closed'); });
  await assert.rejects(client.request('/network'), error => {
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.kind, 'network');
    assert.match(error.detail, /socket closed/);
    return true;
  });
});

test('client distinguishes timeout from caller abort', async () => {
  const timeoutSignals: any = [];
  const timeoutClient = createApiClient(pendingFetch(timeoutSignals));
  await assert.rejects(
    timeoutClient.request('/timeout', { timeoutMs: 15 }),
    error => error instanceof ApiClientError && error.kind === 'timeout',
  );
  assert.equal(timeoutSignals[0].aborted, true);

  const abortSignals: any = [];
  const abortClient = createApiClient(pendingFetch(abortSignals));
  const caller = new AbortController();
  const request = abortClient.request('/abort', { signal: caller.signal, timeoutMs: 1_000 });
  caller.abort();
  await assert.rejects(
    request,
    error => error instanceof ApiClientError && error.kind === 'aborted',
  );
  assert.equal(abortSignals[0].aborted, true);
});

test('aborting one concurrent request does not affect another request', async () => {
  const pending = new Map();
  const client = createApiClient((url, init) => new Promise((resolve, reject) => {
    const key = String(url);
    pending.set(key, { resolve, signal: init.signal });
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const firstController = new AbortController();
  const first = client.request('/first', { signal: firstController.signal, timeoutMs: 1_000 });
  const second = client.request('/second', { timeoutMs: 1_000 });
  firstController.abort();
  pending.get('/second').resolve(jsonResponse({ value: 'second' }));
  await assert.rejects(first, error => error instanceof ApiClientError && error.kind === 'aborted');
  assert.deepEqual(await second, { value: 'second' });
  assert.equal(pending.get('/second').signal.aborted, false);
});

test('client merges JSON headers and does not add content type to GET', async () => {
  const calls: any = [];
  const client = createApiClient(async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ ok: true });
  });
  await client.request('/post', {
    method: 'POST',
    headers: { 'X-Test': 'kept' },
    body: { value: 1 },
  });
  await client.request('/get', { method: 'GET' });

  const postHeaders = new Headers(calls[0].init.headers);
  assert.equal(postHeaders.get('content-type'), 'application/json');
  assert.equal(postHeaders.get('x-test'), 'kept');
  assert.equal(calls[0].init.body, '{"value":1}');
  const getHeaders = new Headers(calls[1].init.headers);
  assert.equal(getHeaders.has('content-type'), false);
  assert.equal(calls[1].init.body, undefined);
});

test('client removes the caller listener and clears its timeout after success', async () => {
  let addCount = 0;
  let removeCount = 0;
  let requestSignal: any;
  const callerSignal = {
    aborted: false,
    addEventListener(event: unknown, listener: unknown) {
      assert.equal(event, 'abort');
      assert.equal(typeof listener, 'function');
      addCount += 1;
    },
    removeEventListener(event: unknown, listener: unknown) {
      assert.equal(event, 'abort');
      assert.equal(typeof listener, 'function');
      removeCount += 1;
    },
  };
  const client = createApiClient(async (_url, init) => {
    requestSignal = init.signal;
    return jsonResponse({ ok: true });
  });
  await client.request('/cleanup', { signal: callerSignal, timeoutMs: 15 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(addCount, 1);
  assert.equal(removeCount, 1);
  assert.equal(requestSignal.aborted, false, 'cleared timer must not abort a completed request');
});

test('maintenanceApi preserves desktop 501 code and rollback metadata', async () => {
  const responses = [
    jsonResponse({
      ok: false,
      error: '桌面应用模式下不可用',
      detail: '请在源码开发模式中运行',
      code: 'DESKTOP_MAINTENANCE_UNAVAILABLE',
    }, 501),
    jsonResponse({
      ok: false,
      error: '写盘失败',
      rolledBack: false,
      dataIntegrity: 'INCONSISTENT',
      recovery: '从 content-* 备份恢复',
    }, 500),
  ];
  const api = createMaintenanceApi(createApiClient(async () => responses.shift()));
  await assert.rejects(api.buildWeb(), error => {
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.status, 501);
    assert.equal(error.code, 'DESKTOP_MAINTENANCE_UNAVAILABLE');
    assert.equal(error.detail, '请在源码开发模式中运行');
    return true;
  });
  await assert.rejects(api.saveScenes({ scenes: [], tags: [], curation: {} }), error => {
    const failure = maintenanceFailure(error);
    assert.ok(failure);
    assert.equal(failure.rolledBack, false);
    assert.equal(failure.dataIntegrity, 'INCONSISTENT');
    assert.equal(failure.recovery, '从 content-* 备份恢复');
    return true;
  });
});

test('maintenanceApi requires an atomic content snapshot and supports exhausted IDs', async () => {
  const snapshot = { scenes: [], tags: [], curation: {}, blueprints: [] };
  const responses = [
    jsonResponse({ ok: true, version: 7, nextSceneId: null, sceneCount: 0, retiredCount: 1, snapshot }),
    jsonResponse({ ok: true, version: 8, count: 0, backup: 'test', snapshot }),
    jsonResponse({ ok: true, version: 9, nextSceneId: 'sc002', sceneCount: 1, retiredCount: 0 }),
    jsonResponse({ ok: true, count: 1, backup: 'old' }),
  ];
  const api = createMaintenanceApi(createApiClient(async () => responses.shift()));
  assert.equal((await api.getScenesState()).nextSceneId, null);
  assert.deepEqual((await api.saveScenes({ scenes: [], baseVersion: 7 })).snapshot, snapshot);
  await assert.rejects(api.getScenesState(), error => error instanceof ApiClientError);
  await assert.rejects(api.saveScenes({ scenes: [], baseVersion: 8 }), error => error instanceof ApiClientError);
});

test('useControlActions.doStart stops after a real config API failure', async () => {
  const calls: any = [];
  const toasts: { message: string; isError: boolean|undefined; }[] = [];
  let startedPolling = 0;
  let statusPolls = 0;
  const api = createControlApi(createApiClient(async url => {
    calls.push(String(url));
    return jsonResponse({ ok: false, error: '配置保存失败', detail: 'disk full' }, 500);
  }));
  const status = {
    lastStatus: () => ({ voices: { nene: {}, natsume: {} } }),
    sdHost: ref('http://127.0.0.1:7860'),
    comfyHost: ref('http://127.0.0.1:8188'),
    ttsHost: ref('http://127.0.0.1:9880'),
    voiceNeneRef: ref('nene.wav'),
    voiceNenePrompt: ref('nene'),
    voiceNatsumeRef: ref('natsume.wav'),
    voiceNatsumePrompt: ref('natsume'),
    feedbackText: ref(''),
    actionBusy: ref(false),
    mainBtnLabel: ref('启动'),
    pollStatus: () => { statusPolls += 1; },
    startPolling: () => { startedPolling += 1; },
  };
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
  });
  try {
    const actions = useControlActions(status, {
      showToast: (message, isError) => toasts.push({ message, isError }),
      control: api,
    });
    await actions.doStart();
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  }
  assert.deepEqual(calls, ['/api/config']);
  assert.equal(startedPolling, 0);
  assert.equal(statusPolls, 1);
  assert.equal(status.actionBusy.value, false);
  assert.ok(toasts.some(toast => toast.isError && /配置保存失败：disk full/.test(toast.message)));
});

test('useControlStatus stopPolling aborts isolated in-flight status and logs requests', async () => {
  const statusSignals: any = [];
  const logSignals: any = [];
  const waitForAbort = (signal: AbortSignal|undefined, bucket: unknown[]) => new Promise((_resolve, reject) => {
    bucket.push(signal);
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const status = useControlStatus({
    showToast: () => {},
    api: {
      getStatus: options => waitForAbort(options.signal, statusSignals),
      getLogs: (_since, options) => waitForAbort(options.signal, logSignals),
    },
  });
  status.startPolling();
  // 控制室打开后立即检测；下一拍等待在途请求，停止时仍释放两个独立信号。
  try {
    assert.equal(statusSignals.length, 1);
    assert.equal(logSignals.length, 1);
    assert.notEqual(statusSignals[0], logSignals[0]);
    await new Promise(resolve => setTimeout(resolve, 3100));
    assert.equal(statusSignals.length, 1, 'slow status must not be replaced by a timer tick');
    assert.equal(logSignals.length, 1, 'slow logs must not be replaced by a timer tick');
    assert.equal(statusSignals[0].aborted, false);
    assert.equal(logSignals[0].aborted, false);
  } finally {
    status.stopPolling();
  }
  await Promise.resolve();
  assert.equal(statusSignals.every((signal: any) => signal.aborted), true);
  assert.equal(logSignals.every((signal: any) => signal.aborted), true);
});

test('useControlStatus aborts older same-kind requests and clears protected stale data', async () => {
  const statusSignals: any = [];
  const logSignals: any = [];
  const waitForAbort = (signal: AbortSignal|undefined, bucket: any) => new Promise((_resolve, reject) => {
    bucket.push(signal);
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  let protectedFailures = false;
  const status = useControlStatus({
    showToast: () => {},
    api: {
      getStatus: options => waitForAbort(options.signal, statusSignals),
      getLogs: (_since, options) => protectedFailures
        ? Promise.reject(new ApiClientError('forbidden', { kind: 'http', status: 403 }))
        : waitForAbort(options.signal, logSignals),
      getShareLink: () => Promise.reject(new ApiClientError('bad host', { kind: 'http', status: 421 })),
    },
  });

  const firstStatus = status.pollStatus();
  const firstLogs = status.pollLogs();
  await Promise.resolve();
  const secondStatus = status.pollStatus();
  const secondLogs = status.pollLogs();
  await Promise.resolve();
  assert.equal(statusSignals[0].aborted, true);
  assert.equal(logSignals[0].aborted, true);
  assert.equal(statusSignals[1].aborted, false);
  assert.equal(logSignals[1].aborted, false);
  status.stopPolling();
  await Promise.all([firstStatus, firstLogs, secondStatus, secondLogs]);

  status.logs.value = ['old log'];
  status.logIndex.value = 9;
  status.shareLink.value = 'https://old.invalid/?token=secret';
  protectedFailures = true;
  await status.pollLogs();
  await status.loadShareLink();
  assert.deepEqual(status.logs.value, []);
  assert.equal(status.logIndex.value, 0);
  assert.equal(status.shareLink.value, '');
});

test('scoped migration keeps Companion unmount aborts and removes bare fetch calls', () => {
  const scopedFiles = [
    'src/composables/useControlActions.ts',
    'src/composables/useControlStatus.ts',
    'src/views/SceneManagerView.vue',
    'src/composables/scene/useSceneShowcaseUpload.ts',
    'src/views/HomeView.vue',
    'src/views/CompanionView.vue',
    'src/composables/chat/useCharacterRoomSession.ts',
    // 2026-08-22 陪伴页行为/剪贴板/语音簇自 CompanionView 下沉，随迁禁裸 fetch 清单。
    'src/composables/useCompanionBehaviorRuntime.ts',
    'src/composables/useCompanionClipboardImport.ts',
    'src/composables/useCompanionSpeechInput.ts',
  ];
  for (const relativePath of scopedFiles) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${relativePath} must use the typed API modules`);
  }
  // 事件轮询（controlApi/imgCount 聚合 + AbortController）已归
  // useCompanionBehaviorRuntime，卸载中止哨兵随之迁移（存活标志更名 alive）。
  const companionBehavior = fs.readFileSync(path.join(root, 'src/composables/useCompanionBehaviorRuntime.ts'), 'utf8');
  assert.match(companionBehavior, /controlApi\.getStatus\(\{ signal: controller\.signal \}\)/);
  assert.match(companionBehavior, /!alive || controller.signal.aborted/);
  assert.match(companionBehavior, /status\.ok === false/);
  assert.match(companionBehavior, /alive = false\s+eventPollController\?\.abort\(\)/);

  const roomSession = fs.readFileSync(path.join(root, 'src/composables/chat/useCharacterRoomSession.ts'), 'utf8');
  assert.match(roomSession, /controlApi\.getStatus\(\{ signal: controller\.signal \}\)/);
  assert.match(roomSession, /controlApi\.switchMode\('chat', \{ signal: controller\.signal \}\)/);
  assert.match(roomSession, /roomPollRequest\?\.abort\(\)/);
  assert.match(roomSession, /roomActionRequest\?\.abort\(\)/);
});

test('API modules keep operation timeouts within the documented baselines', () => {
  assert.ok(CONTROL_API_TIMEOUTS.quick <= 10_000);
  assert.ok(CONTROL_API_TIMEOUTS.action <= 30_000);
  // 2026-08-29：training 模块已下线，TRAINING_API_TIMEOUTS 的基线断言随之删除
  // （留着会让 lint:js 报 no-undef，pre-push 钩子因此拒推）。
  assert.ok(MAINTENANCE_API_TIMEOUTS.upload <= 120_000);
  assert.ok(MAINTENANCE_API_TIMEOUTS.buildWeb <= 120_000);
  assert.ok(MAINTENANCE_API_TIMEOUTS.run >= 130_000);
});
