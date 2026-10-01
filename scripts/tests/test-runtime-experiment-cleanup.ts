import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { test } from 'node:test';
import { scanDir } from '../maintenance/clean-runtime-experiments';

test('runtime cleanup scan keeps fresh empty directories and fails closed on links or unreadable entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-cleanup-fixture-'));
  try {
    const recent = scanDir(root);
    assert.equal(recent.complete, true);
    assert.ok(recent.newest >= Date.now() - 10000);
    fs.writeFileSync(path.join(root, 'old.txt'), 'fixture');
    const old = new Date(Date.now() - 60 * 86400000);
    fs.utimesSync(path.join(root, 'old.txt'), old, old);
    fs.mkdirSync(path.join(root, 'new-empty'));
    fs.utimesSync(root, old, old);
    assert.ok(scanDir(root).newest > old.getTime());
    const unreadable = scanDir(root, { ...fs, readdirSync: (() => { throw new Error('fixture unavailable'); }) as typeof fs.readdirSync });
    assert.equal(unreadable.complete, false);
    // Simulate a child directory link without platform symlink privileges.
    const reads: string[] = [];
    const linked = scanDir(root, { ...fs,
      lstatSync: ((file: fs.PathLike) => String(file).endsWith('new-empty')
        ? { isSymbolicLink: () => true } : fs.lstatSync(file)) as typeof fs.lstatSync,
      readdirSync: ((file: fs.PathLike, options: unknown) => { reads.push(String(file)); return fs.readdirSync(file, options as never); }) as typeof fs.readdirSync,
    });
    assert.equal(linked.complete, false);
    assert.deepEqual(reads, [root]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
