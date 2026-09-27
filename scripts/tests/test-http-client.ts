'use strict';

/**
 * HTTP client 测试 — 已迁移到 node:test。
 */

const { test }: typeof import('node:test') = require('node:test');
import assert = require('node:assert/strict');
const http: typeof import('node:http') = require('node:http');
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
const {
  UpstreamError,
  abortError,
  isAbortError,
  readJson,
  readBody,
  expectSuccess,
  request,
  parseProxyEnv,
  matchesNoProxy,
  resolveProxy,
}: typeof import('../../services/http-client') = require('../../services/http-client');

test('abortError 识别', () => {
  assert.equal(isAbortError(abortError()), true, 'abortError must be recognized');
  assert.equal(isAbortError(new Error('nope')), false, 'normal errors must not look like aborts');
});

test('UpstreamError 字段', () => {
  const badUrl = new UpstreamError('boom', { code: 'X', status: 502, detail: 'd' });
  assert.equal(badUrl.name, 'UpstreamError');
  assert.equal(badUrl.code, 'X');
  assert.equal(badUrl.status, 502);
  assert.equal(badUrl.detail, 'd');
});

test('真实 HTTP：JSON 成功 / 状态错误 / 二进制 / 预中止', async (t) => {
  const server = http.createServer(function (req: IncomingMessage, res: ServerResponse) {
    if (req.url === '/ok.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
      return;
    }
    if (req.url === '/fail') {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('down');
      return;
    }
    if (req.url === '/blob') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from([1, 2, 3]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = 'http://127.0.0.1:' + address.port + '/';

  const json = await readJson(baseUrl, '/ok.json');
  assert.deepEqual(json, { hello: 'world' });

  let statusError = null;
  try {
    await readJson(baseUrl, '/fail');
  } catch (error) {
    statusError = error;
  }
  assert.ok(statusError instanceof UpstreamError);
  assert.equal(statusError.code, 'UPSTREAM_STATUS');
  assert.equal(statusError.status, 503);
  assert.ok(String(statusError.detail).includes('down'));

  const blob = await expectSuccess(baseUrl, '/blob');
  assert.deepEqual([...blob.body], [1, 2, 3]);
  assert.ok(String(blob.contentType).includes('octet-stream'));

  const controller = new AbortController();
  controller.abort();
  let aborted = null;
  try {
    await request(baseUrl, '/ok.json', { signal: controller.signal });
  } catch (error) {
    aborted = error;
  }
  assert.ok(isAbortError(aborted), 'pre-aborted signal must reject as AbortError');
});

test('parseProxyEnv 解析', () => {
  assert.deepEqual(parseProxyEnv('http://127.0.0.1:7897'), { host: '127.0.0.1', port: 7897, auth: undefined });
  assert.deepEqual(parseProxyEnv('127.0.0.1:7897'), { host: '127.0.0.1', port: 7897, auth: undefined });
  assert.deepEqual(parseProxyEnv('http://user:pass@127.0.0.1:7897'), { host: '127.0.0.1', port: 7897, auth: 'user:pass' });
  assert.equal(parseProxyEnv(undefined), null);
  assert.equal(parseProxyEnv(''), null);
  assert.equal(parseProxyEnv('socks5://127.0.0.1:1080'), null, '非 http 代理不支持');
  assert.equal(parseProxyEnv('http://:bad-port'), null);
  assert.equal(parseProxyEnv('http://127.0.0.1:99999'), null, '端口越界');
});

test('matchesNoProxy 匹配', () => {
  assert.equal(matchesNoProxy('127.0.0.1', undefined), true, '回环地址无条件绕过');
  assert.equal(matchesNoProxy('localhost', ''), true);
  assert.equal(matchesNoProxy('opencode.ai', undefined), false);
  assert.equal(matchesNoProxy('opencode.ai', '*'), true);
  assert.equal(matchesNoProxy('opencode.ai', 'example.com'), false);
  assert.equal(matchesNoProxy('opencode.ai', 'opencode.ai'), true);
  assert.equal(matchesNoProxy('zen.opencode.ai', '.opencode.ai'), true, '子域匹配');
  assert.equal(matchesNoProxy('zen.opencode.ai', '*.opencode.ai'), true);
  assert.equal(matchesNoProxy('opencode.ai', 'opencode.ai:443'), true, '带端口条目');
  assert.equal(matchesNoProxy('opencode.ai', 'example.com, api.deepseek.com'), false);
  assert.equal(matchesNoProxy('api.deepseek.com', 'example.com, api.deepseek.com'), true);
});

test('HTTP_PROXY 生效：http 目标走正向代理', async (t) => {
  const target = http.createServer(function (_req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ via: 'target' }));
  });
  t.after(() => target.close());
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetAddress = target.address() as AddressInfo;
  const targetPort = targetAddress.port;

  let proxyRequests = 0;
  const proxy = http.createServer(function (req: IncomingMessage, res: ServerResponse) {
    proxyRequests++;
    assert.equal(new URL(req.url!).hostname, 'upstream-fixture.invalid');
    const upstream = http.request('http://127.0.0.1:' + targetPort + new URL(req.url!).pathname, {
      method: req.method,
      headers: Object.assign({}, req.headers, { host: req.headers.host }),
    }, function (upRes) {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    upstream.on('error', function () {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  t.after(() => proxy.close());
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address() as AddressInfo;
  const proxyPort = proxyAddress.port;

  const oldHttpProxy = process.env.HTTP_PROXY;
  const oldNoProxy = process.env.NO_PROXY;
  const oldLowerNoProxy = process.env.no_proxy;
  process.env.HTTP_PROXY = 'http://127.0.0.1:' + proxyPort;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  t.after(() => {
    if (oldHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = oldHttpProxy;
    if (oldNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = oldNoProxy;
    if (oldLowerNoProxy === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = oldLowerNoProxy;
  });

  const json = await readJson('http://upstream-fixture.invalid/', '/proxied.json');
  assert.deepEqual(json, { via: 'target' });
  assert.equal(proxyRequests, 1, 'request must actually traverse the proxy');
});

test('HTTPS CONNECT can be cancelled before proxy response headers arrive', { timeout: 2000 }, async (t) => {
  const proxy = http.createServer();
  const sockets = new Set<import('node:stream').Duplex>();
  let connected!: () => void;
  const connection = new Promise<void>(resolve => { connected = resolve; });
  let disconnected!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  proxy.on('connect', (_req, socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', disconnected);
    socket.once('end', () => socket.end()); socket.resume(); connected();
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const old = { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  process.env.HTTPS_PROXY = 'http://127.0.0.1:' + (proxy.address() as AddressInfo).port;
  delete process.env.NO_PROXY; delete process.env.no_proxy;
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    proxy.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const controller = new AbortController();
  const pending = request('https://upstream-fixture.invalid/', '/', { signal: controller.signal, timeoutMs: 300 });
  const rejected = assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
  await connection;
  controller.abort();
  await rejected;
  await closed;
});

test('cancellation during proxy TLS handshake closes the tunnel', { timeout: 2000 }, async (t) => {
  const proxy = http.createServer();
  let socketRef: import('node:stream').Duplex | undefined, handshaking!: () => void, disconnected!: () => void;
  const handshake = new Promise<void>(resolve => { handshaking = resolve; });
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  proxy.on('connect', (_req, socket) => {
    socketRef = socket; socket.on('error', () => {}); socket.once('close', disconnected);
    socket.once('end', () => socket.end());
    socket.once('data', () => handshaking()); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.resume();
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const old = { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  process.env.HTTPS_PROXY = 'http://127.0.0.1:' + (proxy.address() as AddressInfo).port;
  delete process.env.NO_PROXY; delete process.env.no_proxy;
  t.after(() => {
    socketRef?.destroy(); proxy.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const controller = new AbortController();
  const rejected = assert.rejects(request('https://upstream-fixture.invalid/', '/', { signal: controller.signal, timeoutMs: 500 }), { code: 'ABORT_ERR' });
  await handshake; controller.abort(); await rejected; await closed;
});

test('total deadline bounds a response that continuously supplies bytes', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200); res.write('first');
    const timer = setInterval(() => res.write('more'), 5);
    res.once('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await request('http://127.0.0.1:' + (server.address() as AddressInfo).port, '/', { timeoutMs: 500, totalTimeoutMs: 80 });
  await assert.rejects(readBody(result.response), { code: 'UPSTREAM_DEADLINE' });
});

test('public DNS lookup is bounded by cancellation and the total deadline', async (t) => {
  const dns = require('node:dns/promises') as typeof import('node:dns/promises');
  let release!: (value: Array<{ address: string; family: number }>) => void;
  const lookup = new Promise<Array<{ address: string; family: number }>>(resolve => { release = resolve; });
  t.mock.method(dns, 'lookup', () => lookup);
  let connections = 0;
  t.mock.method(require('node:https'), 'request', () => { connections++; throw new Error('Unexpected socket after cancelled DNS'); });
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  t.after(() => release([{ address: '8.8.8.8', family: 4 }]));
  const controller = new AbortController();
  const cancelled = request('https://dns-fixture.invalid/', '/', { publicOnly: true, signal: controller.signal, totalTimeoutMs: 80 });
  let outcome: unknown;
  const observed = cancelled.catch(error => { outcome = error; });
  controller.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(isAbortError(outcome), 'cancellation must settle while DNS is still pending');
  await observed;
  await assert.rejects(request('https://dns-fixture.invalid/', '/', { publicOnly: true, totalTimeoutMs: 30 }), { code: 'UPSTREAM_DEADLINE' });
  release([{ address: '8.8.8.8', family: 4 }]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(connections, 0, 'late DNS completion must not open a socket');
});

test('cancellation destroys an open response body and removes the abort listener', async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.write('partial'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = new AbortController();
  const { getEventListeners } = require('node:events') as typeof import('node:events');
  const result = await request('http://127.0.0.1:' + (server.address() as AddressInfo).port, '/', { signal: controller.signal });
  const body = assert.rejects(readBody(result.response), { code: 'ABORT_ERR' });
  controller.abort(); await body;
  assert.equal(result.response.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('NO_PROXY 命中时绕过代理直连', async (t) => {
  const target = http.createServer(function (_req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ direct: true }));
  });
  t.after(() => target.close());
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as AddressInfo).port;

  const oldHttpProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = 'http://127.0.0.1:1';
  t.after(() => {
    if (oldHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = oldHttpProxy;
  });

  const json = await readJson('http://127.0.0.1:' + targetPort + '/', '/direct.json');
  assert.deepEqual(json, { direct: true }, '127.0.0.1 应无条件直连，不经过（故意坏掉的）代理');
});

test('resolveProxy 按协议选环境变量', (t) => {
  const oldHttpProxy = process.env.HTTP_PROXY;
  const oldHttpsProxy = process.env.HTTPS_PROXY;
  const oldNoProxy = process.env.NO_PROXY;
  process.env.HTTP_PROXY = 'http://127.0.0.1:1000';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:2000';
  delete process.env.NO_PROXY;
  t.after(() => {
    if (oldHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = oldHttpProxy;
    if (oldHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = oldHttpsProxy;
    if (oldNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = oldNoProxy;
  });

  const httpProxy = resolveProxy(new URL('http://example.com/'));
  const httpsProxy = resolveProxy(new URL('https://example.com/'));
  assert.ok(httpProxy);
  assert.ok(httpsProxy);
  assert.equal(httpProxy.port, 1000);
  assert.equal(httpsProxy.port, 2000);
});
