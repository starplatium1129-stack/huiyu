'use strict';
/**
 * server/tunnel.js 自动重连测试
 *
 * 用注入的 spawn mock 模拟 cloudflared：
 *   1. 进程立即退出 → 应自动重新拉起（restartAttempts 递增、restartTimer 激活）
 *   2. 模拟日志出现 Registered tunnel connection → 重连计数清零
 *   3. 手动 stop 后 → 不再自动拉起
 */

var test: typeof import('node:test') = require('node:test');
var assert: typeof import('node:assert') = require('node:assert');
var path: typeof import('path') = require('path');
var fs: typeof import('fs') = require('fs');
var os: typeof import('os') = require('os');

var { createTunnelManager }: typeof import('../../server/tunnel') = require('../../server/tunnel');

var { EventEmitter }: typeof import('node:events') = require('node:events');

function FakeChild() {
  EventEmitter.call(this);
  // No real PID: cleanup must never signal an unrelated host process.
  this.pid = null;
  this.unref = function () {};
}
FakeChild.prototype = Object.create(EventEmitter.prototype);
FakeChild.prototype.constructor = FakeChild;
function fakeSpawn() {
  return new FakeChild();
}

function makeManager() {
  var children: any[] = [];
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-test-'));
  var config = {
    DISABLE_TUNNEL: false,
    CLOUDFLARED_PATH: __filename,  // 必须真实存在，否则 start() 直接 return
    PORT: 3197,
    RUNTIME: {
      tunnelLog: path.join(dir, 'tunnel.log'),
      tunnelPid: path.join(dir, 'tunnel.pid'),
    },
  };
  fs.writeFileSync(config.RUNTIME.tunnelLog, '');
  var manager = createTunnelManager({
    config: config,
    restartBaseMs:10,
    restartMaxMs:20,
    restartLimit:3,
    pollIntervalMs:10,
    spawn: function () {
      var child = fakeSpawn();
      children.push(child);
      return child;
    },
    onStateChange: function () {},
  });
  return { manager: manager, dir: dir, config: config, children: children };
}

function waitFor(predicate: { (): boolean; (): boolean; (): boolean; (): boolean; (): any; }, timeoutMs: any) {
  var deadline = Date.now() + (timeoutMs || 500);
  return new Promise(function (resolve, reject) {
    function check() {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('condition timed out'));
      setTimeout(check, 5);
    }
    check();
  });
}

test('tunnel auto-restarts after cloudflared exits unexpectedly', function (t) {
  var fixture: any = makeManager();
  var manager = fixture.manager;
  t.after(function () { manager.stop(); fs.rmSync(fixture.dir, { recursive: true, force: true }); });
  manager.start();
  assert.strictEqual(fixture.children.length, 1, 'first spawn');

  // 触发进程退出（不清 stop 状态，模拟崩溃）
  fixture.children[0].emit('exit', 1);
  assert.strictEqual(fixture.children.length, 1, 'no immediate respawn (scheduled, not synchronous)');
  return waitFor(function () { return fixture.children.length === 2; });
});

test('restart attempts reset after a registered connection', function (t) {
  var fixture: any = makeManager();
  var manager = fixture.manager;
  var config = fixture.config;
  t.after(function () { manager.stop(); fs.rmSync(fixture.dir, { recursive: true, force: true }); });
  manager.start();
  // 第一次崩溃 → 计划重连
  fixture.children[0].emit('exit', 1);
  return waitFor(function () { return fixture.children.length === 2; }).then(function () {
    // 注入日志让轮询以为连接成功 → 重连计数清零
    fs.writeFileSync(config.RUNTIME.tunnelLog,
      'https://abc-xyz.trycloudflare.com\nRegistered tunnel connection');
    return waitFor(function () { return manager.getUrl() === 'https://abc-xyz.trycloudflare.com'; });
  }).then(function () {
    // 第二次崩溃：计数已清零，仍应继续重连
    fixture.children[1].emit('exit', 0);
    return waitFor(function () { return fixture.children.length === 3; });
  });
});

test('stop prevents further auto-restarts', function (t) {
  var fixture: any = makeManager();
  var manager = fixture.manager;
  t.after(function () { manager.stop(); fs.rmSync(fixture.dir, { recursive: true, force: true }); });
  manager.start();
  manager.stop();
  var attemptsBefore = fixture.children.length;
  fixture.children[0].emit('exit', 1);
  return new Promise(function (resolve) {
    setTimeout(function () {
      assert.strictEqual(fixture.children.length, attemptsBefore, 'no respawn after manual stop');
      resolve();
    }, 50);
  });
});
