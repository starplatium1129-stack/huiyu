import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import childProcess from 'node:child_process';
import translationService = require('../../services/translation-service');
const { createTranslationService } = translationService;

async function fixture(t: TestContext, holdFirst = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-translation-'));
  const script = path.join(root, 'fixture.cjs'); fs.writeFileSync(script, '// process execution is mocked');
  let online = false, release!: () => void, sawHealth!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const firstHealth = new Promise<void>(resolve => { sawHealth = resolve; });
  let healthRequests = 0;
  const upstream = http.createServer(async (_req, res) => {
    sawHealth();
    if (++healthRequests === 1 && holdFirst) await held;
    if (res.destroyed) return;
    res.writeHead(online ? 200 : 503); res.end('fixture');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as import('node:net').AddressInfo).port;
  const children: childProcess.ChildProcess[] = [];
  // No Python/model process or native taskkill is executed in this fixture.
  t.mock.method(childProcess, 'spawn', () => {
    const child = new childProcess.ChildProcess();
    Object.defineProperty(child, 'pid', { value: 65000 + children.length });
    t.mock.method(child, 'kill', () => { online = false; return true; });
    children.push(child); online = true; return child;
  });
  t.mock.method(childProcess, 'execFileSync', (command: string) => { assert.equal(command, 'taskkill'); online = false; return ''; });
  const service = createTranslationService({ url: `http://127.0.0.1:${port}`, port, python: process.execPath, script, logFile: path.join(root, 'translate.log') });
  t.after(async () => {
    release(); service.close();
    for (const child of children) child.emit('exit', 0, null);
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function waitForChild(count: number) {
    const deadline = Date.now() + 1000;
    while (children.length < count) { assert.ok(Date.now() < deadline); await new Promise<void>(resolve => setImmediate(resolve)); }
  }
  return { service, children, firstHealth, release, waitForChild, online: () => { online = true; } };
}

test('translation close cancels active and queued work without starting a fallback process', async t => {
  const f = await fixture(t, true);
  const active = assert.rejects(f.service.translate('active fixture'), { name: 'AbortError' });
  await f.firstHealth;
  const queued = assert.rejects(f.service.translate('queued fixture'), { name: 'AbortError' });
  f.service.close(); await Promise.all([active, queued]); f.release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.children.length, 0);
  assert.equal(f.service.status().queue.pending, 0);
  assert.equal(f.service.status().ready, false);
  f.online(); assert.equal(await f.service.prepare(), true, 'a new lifecycle can prepare again');
});

test('an old translation child exit cannot clear the newly prepared instance', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t);
  const first = f.service.prepare(); await f.waitForChild(1); t.mock.timers.tick(1000); await first;
  f.service.close();
  const second = f.service.prepare(); await f.waitForChild(2); t.mock.timers.tick(1000); await second;
  f.children[0].emit('exit', 0, null);
  assert.equal(f.service.status().ready, true);
  assert.equal(f.service.status().managed, true);
});
