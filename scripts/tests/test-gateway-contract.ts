'use strict';
const { test }: typeof import('node:test') = require('node:test');

test('远程同一身份不能借原生 SD 写接口绕过应用分级和方法限制', async () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const stack = await (require('./gateway-test-stack') as typeof import('./gateway-test-stack')).start();
  const previous = process.env.AICS_ADULT_REMOTE;
  process.env.AICS_ADULT_REMOTE = '0';
  const remote = { 'x-token': stack.config.TOKEN, 'x-forwarded-for': '198.51.100.8' };
  async function request(route, method, headers, body = {}) {
    const response = await fetch(stack.baseUrl + route, {
      method, headers: { ...headers, 'content-type': 'application/json' },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: method === 'HEAD' ? null : await response.json() };
  }
  try {
    const application = await request('/api/generation/jobs', 'POST', remote, { prompt: 'nsfw', width: 832, height: 1216, adultEnabled: true });
    assert.equal(application.status, 403);
    assert.equal(application.body.code, 'ADULT_REMOTE_NOT_ALLOWED');
    for (const route of ['/sdapi/v1/txt2img', '/sdapi/v1/options', '/sdapi/v1/interrupt']) {
      const denied = await request(route, 'POST', remote, { prompt: 'fixture' });
      assert.equal(denied.status, 403, route);
      assert.equal(denied.body.code, 'SD_NATIVE_LOCAL_ONLY');
    }
    assert.equal(stack.upstreams.sd.mock.state.calls.filter(call => call.method === 'POST').length, 0);
    assert.equal((await request('/sdapi/v1/options', 'GET', remote)).status, 200);
    assert.equal((await request('/sdapi/v1/samplers', 'POST', remote)).status, 405);
    assert.equal((await request('/sdapi/v1/options', 'DELETE', {})).status, 405);
    assert.equal((await request('/sdapi/v1/txt2img', 'POST', { 'x-forwarded-for': '198.51.100.8' })).status, 401);
    const local = await request('/sdapi/v1/txt2img', 'POST', {}, { prompt: 'ordinary fixture' });
    assert.equal(local.status, 200);
    assert.equal(local.body.images.length, 1);
    assert.equal(stack.upstreams.sd.mock.state.calls.filter(call => call.method === 'POST' && call.path === '/sdapi/v1/txt2img').length, 1);
    const burst = await Promise.all(Array.from({ length: 24 }, () => request('/api/generation/jobs', 'POST', remote, { prompt: 'ordinary fixture' })));
    const throttled = burst.find(response => response.status === 429 && response.body.code === 'RATE_LIMITED');
    assert.ok(throttled, 'application generation still enforces its rate limit');
    const admitted = burst.filter(response => response.status !== 429 || response.body.code !== 'RATE_LIMITED').length;
    assert.ok(admitted >= 8 && admitted <= 13, 'generation bucket should admit about 12 requests, admitted ' + admitted);
    assert.ok(Number(throttled.headers.get('retry-after')) > 0);
    assert.ok(Number(throttled.body.retryAfterSeconds) > 0);
  } finally {
    if (previous === undefined) delete process.env.AICS_ADULT_REMOTE;
    else process.env.AICS_ADULT_REMOTE = previous;
    await stack.close();
  }
});

test('SD 代理：超过 15 秒的生成正常返回，复用连接不累积超时监听器', { timeout:25000 }, async () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const http: typeof import('node:http') = require('node:http');
  const stack = await (require('./gateway-test-stack') as typeof import('./gateway-test-stack')).start();
  const agent = new http.Agent({ keepAlive:true, maxSockets:1 });
  const timeoutListeners = [];
  const sockets = new Set();
  stack.server.on('request', (req, res) => {
    if (!req.url.startsWith('/sdapi/')) return;
    sockets.add(req.socket);
    res.once('finish', () => timeoutListeners.push(req.socket.listenerCount('timeout')));
  });
  function request(path, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request(stack.baseUrl + path, { method, agent }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status:res.statusCode, body:JSON.parse(body) }); } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('fixture request timed out')));
      req.end();
    });
  }
  try {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      assert.equal((await request('/sdapi/v1/progress')).status, 200);
    }
    assert.equal(sockets.size, 1, 'regression must exercise a reused client socket');
    assert.ok(Math.max(...timeoutListeners) <= timeoutListeners[0], 'polling must not keep adding socket timeout listeners');
    stack.upstreams.sd.mock.state.faults.renderMs = 15500;
    const generated = await request('/sdapi/v1/txt2img', 'POST');
    assert.equal(generated.status, 200, 'generation must outlive the connection establishment deadline');
    assert.equal(generated.body.images.length, 1);
  } finally { agent.destroy(); await stack.close(); }
});

test('gateway WebSocket：仅本机可升级，持令牌的远程连接也不能获得原生双向通道', async () => {
  const assert: typeof import('node:assert/strict') = require('node:assert/strict');
  const http: typeof import('node:http') = require('node:http');
  const fs: typeof import('node:fs') = require('node:fs');
  const crypto: typeof import('node:crypto') = require('node:crypto');
  const { EventEmitter }: typeof import('node:events') = require('node:events');
  const token = 'websocket-fixture-token-0123456789abcdef';
  const tunnelHost = 'gateway-contract.trycloudflare.com';
  const stack = await (require('./gateway-test-stack') as typeof import('./gateway-test-stack')).start({
    token,
    configureConfig(config) { config.DISABLE_TUNNEL = false; config.CLOUDFLARED_PATH = __filename; },
    spawn(command, args, options) {
      fs.writeSync(options.stdio[1], 'https://' + tunnelHost + '\nRegistered tunnel connection\n');
      const child = new EventEmitter();
      child.pid = null; // 隔离假进程，清理不得触碰真实 PID。
      child.unref = function () {};
      return child;
    },
  });
  let upstreamUpgrades = 0;
  stack.upstreams.sd.mock.server.on('upgrade', (req, socket) => {
    upstreamUpgrades += 1;
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  });
  function upgrade(headers) {
    return new Promise((resolve) => {
      const req = http.request(stack.baseUrl + '/sdapi/v1/progress', {
        headers: { Connection:'Upgrade', Upgrade:'websocket', 'Sec-WebSocket-Version':'13', 'Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
      });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(0));
      req.setTimeout(3000, () => req.destroy());
      req.end();
    });
  }
  try {
    stack.gateway.startTunnel();
    const headers = { Host:tunnelHost, 'x-forwarded-for':'203.0.113.9', Cookie:'aics_token=' + token, Origin:'https://' + tunnelHost };
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await fetch(stack.baseUrl + '/api/status');
      const status = await response.json();
      if (status.tunnelStatus === 'active') { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'fixture tunnel must become active via its normal log registration');
    assert.equal(await upgrade(headers), 403, 'a token does not authorize a native bidirectional channel');
    assert.equal(await upgrade({ Host:'127.0.0.1:' + stack.address.port }), 101, 'local compatibility upgrade remains available');
    assert.notEqual(await upgrade({ ...headers, Host:'foreign.example' }), 101);
    assert.notEqual(await upgrade({ ...headers, Cookie:'' }), 101);
    assert.notEqual(await upgrade({ Host:'127.0.0.1:' + stack.address.port, Origin:'https://external.example' }), 101);
    assert.equal(upstreamUpgrades, 1, 'rejected upgrade attempts must never reach upstream');
  } finally { await stack.close(); }
});

test("gateway-contract", async () => {
/**
 * scripts/tests/test-gateway-contract.js
 *
 * 路由级安全 / 正确性回归。断言的是真实 HTTP 响应，而不是 helper 的返回值 ——
 * 2026-07-27 审计的教训：test-security.js 断言了 server/security.js 里正确的那份
 * isDirectLocalRequest，而 bug 在 routes/control.js 自己复制的弱版本里，
 * 于是「测通过」和「线上安全」完全脱钩。
 */

var assert: typeof import('assert') = require('assert');
var http: typeof import('http') = require('http');
var fs: typeof import('fs') = require('fs');
var path: typeof import('path') = require('path');
var gatewayTestStack: typeof import('./gateway-test-stack') = require('./gateway-test-stack');

var PORT = 0;
var TOKEN = 'contract-token-0123456789abcdef0123456789ab';
var LOCAL = null;
// 隧道请求的形状：socket 来自 127.0.0.1（cloudflared），但带转发头。
var TUNNELED = null;

function request(options) {
  return new Promise(function (resolve, reject) {
    var req = http.request({
      host:'127.0.0.1',
      port:options.port || PORT,
      method:options.method || 'GET',
      path:options.path,
      headers:options.headers || {}
    }, function (res) {
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        var body = Buffer.concat(chunks).toString('utf8');
        var json = null;
        try { json = JSON.parse(body); } catch (error) {}
        resolve({ status:res.statusCode, headers:res.headers, body:body, json:json });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function postJson(pathname, payload, headers) {
  var body = JSON.stringify(payload);
  return request({
    method:'POST',
    path:pathname,
    headers:Object.assign({ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) },
      headers || LOCAL),
    body:body
  });
}

function upgradeRequest(headers) {
  return new Promise(function (resolve) {
    var req = http.request({
      host:'127.0.0.1',
      port:PORT,
      method:'GET',
      path:'/sdapi/v1/progress',
      headers:Object.assign({
        Connection:'Upgrade',
        Upgrade:'websocket',
        'Sec-WebSocket-Version':'13',
        'Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ=='
      }, headers || {})
    });
    req.on('upgrade', function (res, socket) { socket.destroy(); resolve({ status:res.statusCode, kind:'upgraded' }); });
    req.on('response', function (res) { res.resume(); resolve({ status:res.statusCode, kind:'response' }); });
    req.on('error', function (error) { resolve({ status:0, kind:'error', message:error.message }); });
    req.end();
  });
}

async function main() {
  var stack = await gatewayTestStack.start({ token:TOKEN });
  var desktopStack = null;
  PORT = stack.address.port;
  LOCAL = { Host:'127.0.0.1:' + PORT };
  TUNNELED = { Host:'127.0.0.1:' + PORT, 'x-forwarded-for':'9.9.9.9', 'x-token':TOKEN };

  try {
    // ---- S-1: 隧道请求不得被当成本机 ----
    var tunneledConfig = await postJson('/api/config', { sdHost:'http://127.0.0.1:1234' }, TUNNELED);
    assert.strictEqual(tunneledConfig.status, 403,
      'POST /api/config over tunnel must be 403, got ' + tunneledConfig.status);

    var localOnlyRoutes = ['/api/status', '/api/logs', '/api/diagnostics', '/api/share-link'];
    for (var i = 0; i < localOnlyRoutes.length; i++) {
      var tunneled = await request({ path:localOnlyRoutes[i], headers:TUNNELED });
      assert.strictEqual(tunneled.status, 403,
        localOnlyRoutes[i] + ' over tunnel must be 403, got ' + tunneled.status);
    }

    var localStatus = await request({ path:'/api/status', headers:LOCAL });
    assert.strictEqual(localStatus.status, 200, 'direct-local /api/status must still work');

    // 外站 HTML 表单可以直连 localhost：无 JSON body 仍会执行 /api/start，必须在鉴权前挡住。
    var beforeCrossSite = fs.existsSync(stack.runtime.config) ? fs.readFileSync(stack.runtime.config, 'utf8') : null;
    var crossSiteStart = await request({
      method:'POST', path:'/api/start',
      headers:Object.assign({ Origin:'https://external.example', 'Content-Type':'application/x-www-form-urlencoded' }, LOCAL)
    });
    assert.strictEqual(crossSiteStart.status, 401, 'external form must not borrow loopback authorization');
    assert.strictEqual(fs.existsSync(stack.runtime.config) ? fs.readFileSync(stack.runtime.config, 'utf8') : null,
      beforeCrossSite, 'rejected external form must not change tunnel startup preferences');
    var externalTool = await postJson('/api/desktop-tools', { name:'get_workspace_info', args:{} },
      Object.assign({ Origin:'https://external.example', 'x-token':TOKEN }, LOCAL));
    assert.strictEqual(externalTool.status, 403, 'even a shared token must not grant external origins desktop tools');
    var developmentStart = await postJson('/api/start', { enableTunnel:false },
      Object.assign({ Origin:'http://localhost:5173' }, LOCAL));
    assert.strictEqual(developmentStart.status, 200, 'Vite local development must keep working across local ports');

    var firstVisit = await request({
      path:'/gallery?filter=recent&token=' + TOKEN,
      headers:Object.assign({ 'x-forwarded-proto':'https' }, TUNNELED)
    });
    assert.strictEqual(firstVisit.status, 302);
    assert.strictEqual(firstVisit.headers.location, '/gallery?filter=recent');
    assert.strictEqual(firstVisit.headers['cache-control'], 'no-store');
    assert.ok(firstVisit.headers['set-cookie'][0].includes('; Secure'), 'HTTPS tunnel backhaul must issue Secure cookie');

    // ---- S-3: 上游 host 只接受本机 http ----
    var ssrfHosts = ['http://169.254.169.254', 'http://evil.example.com:7860', 'https://127.0.0.1:7860', 'http://127.0.0.1:0'];
    for (var h = 0; h < ssrfHosts.length; h++) {
      var rejected = await postJson('/api/config', { sdHost:ssrfHosts[h] });
      assert.strictEqual(rejected.status, 400, ssrfHosts[h] + ' must be rejected with 400');
    }
    var accepted = await postJson('/api/config', { sdHost:stack.config.SD_HOST });
    assert.strictEqual(accepted.status, 200, 'loopback sdHost must be accepted');
    var comfyAccepted = await postJson('/api/config', { comfyHost:'http://127.0.0.1:8189' });
    assert.strictEqual(comfyAccepted.status, 200, 'loopback comfyHost must be accepted');
    assert.strictEqual(comfyAccepted.json.comfyHost, 'http://127.0.0.1:8189');
    var comfyRejected = await postJson('/api/config', { comfyHost:'http://169.254.169.254:8188' });
    assert.strictEqual(comfyRejected.status, 400, 'non-loopback comfyHost must be rejected');

    // ---- S-4: 原始 token 不得出现在轮询接口里；Host 白名单生效 ----
    var status = await request({ path:'/api/status', headers:LOCAL });
    assert.ok(status.body.indexOf(TOKEN) === -1, '/api/status must not leak the raw token');
    assert.ok(status.json && status.json.shareLink === undefined,
      '/api/status must not carry shareLink; use /api/share-link');

    var foreignHost = await request({ path:'/api/health', headers:{ Host:'attacker.example.com' } });
    assert.strictEqual(foreignHost.status, 421, 'foreign Host must be refused (DNS rebinding guard)');

    var diagnostics = await request({ path:'/api/diagnostics', headers:LOCAL });
    assert.strictEqual(diagnostics.status, 200);
    assert.ok(diagnostics.body.indexOf(TOKEN) === -1, '/api/diagnostics must redact the token');

    // ---- S-2: 未鉴权 WS upgrade 被拒，且不能弄死进程 ----
    var unauthUpgrade = await upgradeRequest({ Host:'127.0.0.1:' + PORT, 'x-forwarded-for':'9.9.9.9' });
    assert.ok(unauthUpgrade.status === 401 || unauthUpgrade.status === 0,
      'unauthenticated WS upgrade must be refused, got ' + unauthUpgrade.status);

    await new Promise(function (resolve) { setTimeout(resolve, 300); });
    var aliveAfterUpgrade = await request({ path:'/api/health', headers:LOCAL });
    assert.strictEqual(aliveAfterUpgrade.status, 200,
      'gateway must survive an unauthenticated WS upgrade (it used to crash on res.status)');
    assert.strictEqual(aliveAfterUpgrade.json.desktopProtocol, 1,
      'gateway health must expose the desktop compatibility protocol');

    // ---- B-3: 状态码与错误信封 ----
    var missingImage = await request({ path:'/scene-showcase/images/sc999.jpg', headers:LOCAL });
    assert.strictEqual(missingImage.status, 404, 'missing showcase asset must be 404, not 500');
    assert.ok(missingImage.body.indexOf('E:\\') === -1 && missingImage.body.indexOf(':\\') === -1,
      'error bodies must not leak absolute host paths');

    var oversize = await postJson('/api/translate', { text:'x'.repeat(70000) });
    assert.strictEqual(oversize.status, 413, 'oversize body must be 413, not 500');

    var badJson = await request({
      method:'POST',
      path:'/api/translate',
      headers:Object.assign({ 'Content-Type':'application/json' }, LOCAL),
      body:'{not json'
    });
    assert.strictEqual(badJson.status, 400, 'malformed JSON must be 400');

    // ---- B-4: 未知 API 路由必须是 JSON 404，不能是 SPA 外壳 ----
    var unknownApi = await request({ path:'/api/does-not-exist', headers:LOCAL });
    assert.strictEqual(unknownApi.status, 404, 'unknown /api route must be 404, got ' + unknownApi.status);
    assert.ok(String(unknownApi.headers['content-type'] || '').indexOf('json') !== -1,
      'unknown /api route must return JSON, not text/html');

    // 前端路由仍应回 SPA 外壳
    var spaRoute = await request({ path:'/scene-explorer', headers:LOCAL });
    assert.ok(spaRoute.status === 200 || spaRoute.status === 404,
      'SPA route should resolve (200 with dist/, 404 without)');

    // ---- S-5: /sdapi 只放行前端真正调用的端点 ----
    // 之前整段透传 /sdapi + /controlnet + /adetailer，SD API 能换模型、
    // 装了扩展还能碰文件系统。
    var sdBlocked = ['/sdapi/v1/options-anything', '/controlnet/model_list', '/adetailer/v1/version'];
    for (var b = 0; b < sdBlocked.length; b++) {
      var denied = await request({ path:sdBlocked[b], headers:LOCAL });
      assert.strictEqual(denied.status, 404, sdBlocked[b] + ' must not be proxied, got ' + denied.status);
      assert.ok(String(denied.headers['content-type'] || '').indexOf('json') !== -1,
        sdBlocked[b] + ' must return JSON 404, not the SPA shell');
    }

    // ---- A-10: ComfyUI 原生端点不得再成为浏览器可达的代理 ----
    var comfyBlocked = [
      '/comfy/prompt', '/comfy/queue', '/comfy/history/abc',
      '/comfy/interrupt', '/comfy/view?filename=output.png', '/comfy/object_info',
      '/prompt', '/queue', '/history', '/interrupt', '/view'
    ];
    for (var cb = 0; cb < comfyBlocked.length; cb++) {
      var comfyDenied = await request({ path:comfyBlocked[cb], headers:LOCAL });
      assert.strictEqual(comfyDenied.status, 404, comfyBlocked[cb] + ' must not be exposed');
      assert.ok(comfyDenied.json && comfyDenied.json.ok === false,
        comfyBlocked[cb] + ' must return the JSON error envelope');
    }
    var remoteAnima = await request({
      path:'/api/anima/status',
      headers:{ Host:'127.0.0.1:' + PORT, 'x-forwarded-for':'9.9.9.9' }
    });
    assert.strictEqual(remoteAnima.status, 401, 'remote Anima status must require a token');

    // ---- B-6: 错误信封只有一种形状 ----
    // 曾经有四种同时存在（{error} / {ok:false,msg} / {ok:false,error} / {error,detail}），
    // 于是前端到处写 `data.error || data.msg || '操作失败'` —— 少写一个候选就退化成无信息文案。
    var errorCases = [
      { name:'unknown api 404', res:await request({ path:'/api/does-not-exist', headers:LOCAL }) },
      { name:'blocked sdapi 404', res:await request({ path:'/sdapi/v1/nope', headers:LOCAL }) },
      { name:'bad chat body 400', res:await postJson('/api/chat', { messages:[] }) },
      { name:'bad translate body 400', res:await postJson('/api/translate', { text:'' }) },
      { name:'bad voice 400', res:await postJson('/api/voice/prepare', { voice:'nobody' }) },
      { name:'bad tts 400', res:await postJson('/api/tts', { voice:'nobody', text:'x' }) },
      { name:'ssrf host 400', res:await postJson('/api/config', { sdHost:'http://evil.example.com' }) },
      { name:'unknown maintenance task 400', res:await postJson('/api/maintenance/run', { task:'nope' }) },
      { name:'tunneled localOnly 403', res:await request({ path:'/api/logs', headers:TUNNELED }) },
      { name:'oversize body 413', res:await postJson('/api/translate', { text:'x'.repeat(70000) }) }
    ];
    for (var e = 0; e < errorCases.length; e++) {
      var envelopeCase = errorCases[e];
      var body = envelopeCase.res.json;
      assert.ok(body, envelopeCase.name + ' must return a JSON body');
      assert.strictEqual(body.ok, false, envelopeCase.name + ' must carry ok:false');
      assert.strictEqual(typeof body.error, 'string',
        envelopeCase.name + ' must carry a string error');
      assert.ok(body.error.length > 0, envelopeCase.name + ' error must not be empty');
    }

    // 成功信封同样固定：ok:true
    var okConfig = await postJson('/api/config', { sdHost:stack.config.SD_HOST });
    assert.strictEqual(okConfig.json && okConfig.json.ok, true, 'success envelope must carry ok:true');

    // /api/status 探测失败必须回 200 + ok:false，与三个同族 *-status 一致。
    // 回 500 时前端的 `if (!r.ok) return` 会把状态墙冻在上一次的值上。
    var statusSiblings = ['/api/status', '/api/sd-status', '/api/tts-status', '/api/chat-status'];
    for (var s = 0; s < statusSiblings.length; s++) {
      var probe = await request({ path:statusSiblings[s], headers:LOCAL });
      assert.strictEqual(probe.status, 200,
        statusSiblings[s] + ' must report degraded state as 200, got ' + probe.status);
      assert.ok(probe.json, statusSiblings[s] + ' must return JSON');
    }

    // 原生写端点的远程能力检查先于限流；没有令牌桶空隙可以绕过应用门控。
    var burst = await Promise.all(Array.from({ length:24 }, function () {
      return postJson('/sdapi/v1/txt2img', { prompt:'probe' }, TUNNELED);
    }));
    assert.ok(burst.every(function (shot) { return shot.status === 403 && shot.json.code === 'SD_NATIVE_LOCAL_ONLY'; }),
      'every remote native write must be denied, including the first request');

    // 本机直连是电脑主人，不该被自己的限流挡住。
    // SD 未启动时代理回 502，这里只断言"不是 429"。
    for (var lg = 0; lg < 8; lg++) {
      var localShot = await postJson('/sdapi/v1/txt2img', { prompt:'probe' }, LOCAL);
      assert.notStrictEqual(localShot.status, 429,
        'direct-local requests must never be rate limited (attempt ' + (lg + 1) + ')');
    }

    // 廉价读端点不该共用出图的桶
    var cheapRead = await request({ path:'/sdapi/v1/samplers', headers:TUNNELED });
    assert.notStrictEqual(cheapRead.status, 429,
      'cheap SD reads must not share the txt2img bucket');

    // ---- P-10: data/ 只暴露 SPA 真正读取的文件 ----
    var privateData = [
      'scenes/manifest.json',   // 场景分片清单，build 输入，客户端从不读
      'popular/manifest.json',  // 热门角色分片清单，build 输入，客户端从不读
      'history.json', 'projects.json', 'prompts.json',
      'official-cg-candidates.json', 'retired-scenes.json'
    ];
    for (var d = 0; d < privateData.length; d++) {
      var hidden = await request({ path:'/data/' + privateData[d], headers:LOCAL });
      assert.strictEqual(hidden.status, 404, '/data/' + privateData[d] + ' must not be public');
    }
    var publicData = [
      'scenes.json', 'scenes-index.json', 'scenes-core.json',
      'scenes-nene.json', 'scenes-natsume.json', 'scenes-shared.json',
      'curation.json', 'characters.json', 'loras.json', 'tags.json', 'presets.json'
    ];
    for (var pd = 0; pd < publicData.length; pd++) {
      var served = await request({ path:'/data/' + publicData[pd], headers:LOCAL });
      assert.strictEqual(served.status, 200, '/data/' + publicData[pd] + ' must stay served');
    }

    // ---- P-3: 带 hash 的产物永久缓存，SPA 外壳不缓存 ----
    var distApp = path.join(__dirname, '..', '..', 'dist', '_app');
    if (fs.existsSync(distApp)) {
      var hashed = fs.readdirSync(distApp).filter(function (f) { return /-[\w-]{8,}\.js$/.test(f); })[0];
      if (hashed) {
        var assetRes = await request({ path:'/_app/' + hashed, headers:LOCAL });
        var cc = String(assetRes.headers['cache-control'] || '');
        assert.ok(cc.indexOf('immutable') !== -1 && cc.indexOf('max-age=31536000') !== -1,
          'content-hashed assets must be immutable, got ' + cc);
      }
      var shellRes = await request({ path:'/', headers:LOCAL });
      assert.ok(String(shellRes.headers['cache-control'] || '').indexOf('no-cache') !== -1,
        'SPA shell must stay no-cache');
    }

    // ---- D-2: docs 能取到唯一那份设计系统，但 src/ 其余部分不外泄 ----
    var designSystem = await request({ path:'/src/assets/css/design-system.css', headers:LOCAL });
    assert.strictEqual(designSystem.status, 200, 'docs pages need the canonical design system');
    var srcLeak = await request({ path:'/src/main.ts', headers:LOCAL });
    assert.strictEqual(srcLeak.status, 404, 'only design-system.css may be exposed from src/');

    // ---- P-7: 预压产物优先（brotli > gzip > 原文）----
    // 只有跑过 npm run precompress 才有 .br；没有就跳过而不是失败。
    if (fs.existsSync(path.join(__dirname, '..', '..', 'data', 'scenes.json.br'))) {
      var brotli = await request({ path:'/data/scenes.json', headers:Object.assign({ 'Accept-Encoding':'br' }, LOCAL) });
      assert.strictEqual(brotli.headers['content-encoding'], 'br', 'brotli must win when accepted');
      assert.ok(String(brotli.headers['content-type'] || '').indexOf('json') !== -1,
        'precompressed response must keep the original content type');
      assert.ok(String(brotli.headers.vary || '').indexOf('Accept-Encoding') !== -1,
        'precompressed response must Vary on Accept-Encoding');

      var gzipped = await request({ path:'/data/scenes.json', headers:Object.assign({ 'Accept-Encoding':'gzip' }, LOCAL) });
      assert.strictEqual(gzipped.headers['content-encoding'], 'gzip', 'gzip must be the fallback');
      assert.ok(brotli.body.length < gzipped.body.length, 'brotli must be smaller than gzip');

      var identity = await request({ path:'/data/scenes.json', headers:Object.assign({ 'Accept-Encoding':'identity' }, LOCAL) });
      assert.strictEqual(identity.status, 200, 'clients without br/gzip must still get the file');
      assert.ok(!identity.headers['content-encoding'], 'identity response must not claim an encoding');

      // 预压查找不得成为目录穿越入口
      var traversal = await request({ path:'/data/../server.js', headers:Object.assign({ 'Accept-Encoding':'br' }, LOCAL) });
      assert.notStrictEqual(traversal.status, 200, 'precompressed lookup must not escape the data allowlist');
    }

    // ---- 桌面打包模式（AICS_DESKTOP_PACKAGED=1）：内容维护链路必须 501 ----
    desktopStack = await gatewayTestStack.start({
      token:TOKEN,
      env:{ AICS_DESKTOP_PACKAGED:'1' }
    });
    var DESKTOP_PORT = desktopStack.address.port;
    var desktopLocal = { Host:'127.0.0.1:' + DESKTOP_PORT };
    var scenesPost = await request({
      port:DESKTOP_PORT, method:'POST', path:'/api/maintenance/scenes',
      headers:Object.assign({ 'Content-Type':'application/json', 'Content-Length':2 }, desktopLocal),
      body:'{}'
    });
    assert.strictEqual(scenesPost.status, 501, 'desktop packaged mode must refuse scene saves with 501');
    var toolRun = await request({
      port:DESKTOP_PORT, method:'POST', path:'/api/maintenance/run',
      headers:Object.assign({ 'Content-Type':'application/json', 'Content-Length':2 }, desktopLocal),
      body:'{}'
    });
    assert.strictEqual(toolRun.status, 501, 'desktop packaged mode must refuse maintenance tasks with 501');
    var buildWeb = await request({ port:DESKTOP_PORT, method:'POST', path:'/api/maintenance/build-web', headers:desktopLocal });
    assert.strictEqual(buildWeb.status, 501, 'desktop packaged mode must refuse build-web with 501');
    console.log('Gateway contract tests passed: tunnel localOnly, host validation, ' +
      'rebinding guard, WS upgrade auth, error envelopes, api 404, sdapi allowlist, ' +
      'data allowlist, immutable assets, precompressed serving, desktop mode 501');
  } finally {
    if (desktopStack) await desktopStack.close();
    await stack.close();
  }
}

await main();

});
