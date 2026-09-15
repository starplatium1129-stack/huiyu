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

  const proxy = http.createServer(function (req: IncomingMessage, res: ServerResponse) {
    const upstream = http.request(req.url ?? '/', {
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
  process.env.HTTP_PROXY = 'http://127.0.0.1:' + proxyPort;
  delete process.env.NO_PROXY;
  t.after(() => {
    if (oldHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = oldHttpProxy;
    if (oldNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = oldNoProxy;
  });

  const json = await readJson('http://127.0.0.1:' + targetPort + '/', '/proxied.json');
  assert.deepEqual(json, { via: 'target' });
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
