import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const development = import('../dev-server.mjs');

function isolatedProcess(children: ChildProcess[]) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', windowsHide: true,
  });
  children.push(child);
  return child;
}

test('development restarts only after a changed successful build and keeps the last process on type errors', async () => {
  const { startDevelopment } = await development;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-dev-cycle-'));
  const children: ChildProcess[] = [];
  const errors: unknown[] = [];
  let mode: 'changed' | 'cached' | 'failed' = 'changed';
  let builds = 0;
  const session = await startDevelopment(root, {
    watch: false,
    build() {
      builds++;
      if (mode === 'failed') throw new Error('fixture type error');
      return mode === 'changed';
    },
    start: () => isolatedProcess(children),
    reportError: error => errors.push(error),
  });
  try {
    assert.equal(children.length, 1);
    assert.ok(session.pid);
    const initial = session.pid;
    mode = 'cached';
    await session.rebuild();
    assert.equal(session.pid, initial);
    mode = 'failed';
    await session.rebuild();
    assert.equal(session.pid, initial);
    assert.equal(children.length, 1);
    assert.match(String(errors[0]), /fixture type error/);
    mode = 'changed';
    await session.rebuild();
    assert.equal(children.length, 2);
    assert.notEqual(session.pid, initial);
    assert.equal(children[0].killed, true);
    assert.equal(builds, 4);
  } finally {
    await session.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(session.pid, undefined);
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  await session.rebuild();
  assert.equal(builds, 4, 'closed sessions must never start another build or child');
});

test('an initially failing check starts no gateway and can recover on the next successful source build', async () => {
  const { startDevelopment } = await development;
  const children: ChildProcess[] = [];
  let valid = false;
  const errors: unknown[] = [];
  const session = await startDevelopment(process.cwd(), {
    watch: false,
    build() { if (!valid) throw new Error('invalid initial source'); return true; },
    start: () => isolatedProcess(children),
    reportError: error => errors.push(error),
  });
  try {
    assert.equal(session.pid, undefined);
    assert.equal(children.length, 0);
    assert.equal(errors.length, 1);
    valid = true;
    await session.rebuild();
    assert.equal(children.length, 1);
    assert.ok(session.pid);
  } finally { await session.close(); }
});

test('source watcher reacts to TypeScript edits without looping on its generated JavaScript', async () => {
  const { startDevelopment } = await development;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-dev-watch-'));
  fs.writeFileSync(path.join(root, 'server.ts'), 'export const fixture = 1;\n');
  const children: ChildProcess[] = [];
  const errors: unknown[] = [];
  let builds = 0;
  const session = await startDevelopment(root, {
    debounceMs: 20,
    build() {
      builds++;
      fs.writeFileSync(path.join(root, 'server.js'), `// generated fixture ${builds}\n`);
      return true;
    },
    start: () => isolatedProcess(children),
    reportError: error => errors.push(error),
  });
  try {
    const initial = builds;
    fs.writeFileSync(path.join(root, 'server.ts'), 'export const fixture = 2;\n');
    const deadline = Date.now() + 5000;
    while (builds === initial && Date.now() < deadline) await delay(20);
    assert.ok(builds > initial, 'a source edit must trigger a build');
    await delay(120);
    const settled = builds;
    fs.writeFileSync(path.join(root, 'server.js'), '// generated output only\n');
    await delay(100);
    assert.equal(builds, settled, 'emitted JavaScript must not trigger another compile');
    assert.deepEqual(errors, []);
  } finally {
    await session.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
