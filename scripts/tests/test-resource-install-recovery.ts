'use strict';

import { PathLike } from 'node:fs';

const { test }: typeof import('node:test') = require('node:test');
const { fork }: typeof import('node:child_process') = require('node:child_process');
const { fs, path, assert, write, json, snapshot, fixture, code }: typeof import('./resource-install-fixtures') = require('./resource-install-fixtures');
const { killAt }: typeof import('./resource-install-process') = require('./resource-install-process');

if (require.main === module) {
  for (const phase of ['journal', 'copied', 'staged', 'prepared', 'switched']) {
    test('SIGKILL at ' + phase + ' recovers stale lock and installs one complete version', async t => {
      const f = fixture(t);
      const old = await f.installer().install({ releaseId: 'base' });
      await killAt(f.config(), phase);
      const recovered = await f.installer().recover();
      assert.equal(recovered.ok, true);
      assert.equal(recovered.state.current.identity, f.policy.releases.delta.targetIdentity);
      assert.equal((await f.installer().status()).pending, null);
      assert.equal(fs.readFileSync(path.join(old.installedRoot, 'assets/a.txt'), 'utf8'), 'OLD');
      assert.equal(fs.existsSync(path.join(old.installedRoot, 'assets/removed.txt')), true);
    });
  }

  test('corrupt switched version is rolled back after process death; rejected bytes stay quarantined', async t => {
    const f = fixture(t);
    const old = await f.installer().install({ releaseId: 'base' });
    await killAt(f.config(), 'switched');
    const root = f.installer().root;
    const journal = json(path.join(root, 'pending.json'));
    write(path.join(root, 'versions', journal.target.identity, 'assets/a.txt'), 'CORRUPT-NEW');
    const recovered = await f.installer().recover();
    assert.equal(recovered.action, 'rolled-back');
    assert.deepEqual(recovered.state, old.state);
    assert.ok(fs.readdirSync(path.join(root, 'transactions', journal.id)).some(name => name.startsWith('rejected-')));
    assert.equal((await f.installer().install({ releaseId: 'delta' })).action, 'installed');
  });

  test('simultaneous cross-process recoverers never steal the new owner lock', async t => {
    const f = fixture(t);
    await f.installer().install({ releaseId: 'base' });
    await killAt(f.config(), 'copied');
    const file = path.join(f.base, 'recover-runner.js');
    const library = path.resolve(__dirname, '../lib/resource-install.js');
    write(file, `const fs = require('node:fs');
const { createResourceInstaller } = require(${JSON.stringify(library)});
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
createResourceInstaller({...config, access:{isLocalStudioHost:()=>true,isAuthorized:()=>true}}).recover()
 .then(result=>process.send({ok:result.ok})).catch(error=>{process.send({code:error.code});process.exitCode=error.code==='BUSY'?0:1;});`);
    const run = () => new Promise((resolve, reject) => {
      const worker = fork(file, [f.config()], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let message: unknown;
      worker.on('message', value => { message = value; });
      worker.on('error', reject);
      worker.on('exit', codeValue => codeValue === 0 ? resolve(message) : reject(new Error(JSON.stringify(message))));
    });
    const outputs = await Promise.all([run(), run(), run()]);
    assert.ok(outputs.some(value => value?.ok));
    assert.ok(outputs.every(value => value?.ok || value?.code === 'BUSY'));
    assert.equal((await f.installer().status()).state.sequence, 2);
  });

  test('junction in candidate assets is rejected before external file content is read', async t => {
    const f = fixture(t);
    const assets = path.join(f.packs, 'base/assets');
    const outside = path.join(f.base, 'outside');
    fs.renameSync(assets, outside);
    fs.symlinkSync(outside, assets, 'junction');
    const before = snapshot(outside);
    const opened: string[] = [];
    const io = Object.create(fs);
    io.openSync = (file: PathLike, ...args) => { opened.push(String(file)); return fs.openSync(file, ...args); };
    await assert.rejects(f.installer({ io }).install({ releaseId: 'base' }), code('UNSAFE_LINK'));
    assert.ok(opened.every(file => !file.startsWith(outside)));
    assert.deepEqual(snapshot(outside), before);
  });

  test('user-root ancestor junction, dangling junction and lock-directory junction fail closed', async t => {
    const f = fixture(t);
    const alias = path.join(f.base, 'alias');
    fs.symlinkSync(f.user, alias, 'junction');
    assert.throws(() => f.installer({ userDataRoot: alias }), code('UNSAFE_LINK'));
    await f.installer().install({ releaseId: 'base' });
    const root = f.installer().root;
    fs.renameSync(path.join(root, 'locks'), path.join(root, 'saved-locks'));
    fs.symlinkSync(path.join(f.base, 'missing-target'), path.join(root, 'locks'), 'junction');
    await assert.rejects(f.installer().status(), code('UNSAFE_LINK'));
  });

  test('junction injected into interrupted staging cannot write outside resource storage', async t => {
    const f = fixture(t);
    const old = await f.installer().install({ releaseId: 'base' });
    await killAt(f.config(), 'journal');
    const root = f.installer().root;
    const journal = json(path.join(root, 'pending.json'));
    const tree = path.join(root, 'transactions', journal.id, 'tree');
    fs.mkdirSync(tree, { recursive: true });
    fs.symlinkSync(f.artwork, path.join(tree, 'assets'), 'junction');
    const before = snapshot(f.artwork);
    await assert.rejects(f.installer().recover(), code('UNSAFE_LINK'));
    assert.deepEqual(snapshot(f.artwork), before);
    assert.deepEqual((await f.installer().status()).state, old.state);
  });

  test('hardlinked package asset cannot become an installed resource', async t => {
    const f = fixture(t);
    const asset = path.join(f.packs, 'base/assets/a.txt');
    const outside = path.join(f.base, 'outside.txt');
    write(outside, 'OLD');
    fs.unlinkSync(asset);
    fs.linkSync(outside, asset);
    await assert.rejects(f.installer().install({ releaseId: 'base' }), code('UNSAFE_LINK'));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OLD');
  });

  test('journal traversal/tampering never selects an arbitrary recovery directory', async t => {
    const f = fixture(t);
    const old = await f.installer().install({ releaseId: 'base' });
    await killAt(f.config(), 'journal');
    const file = path.join(f.installer().root, 'pending.json');
    const journal = json(file);
    journal.id = '../../artwork';
    write(file, JSON.stringify(journal));
    await assert.rejects(f.installer().recover(), code('JOURNAL_INVALID'));
    assert.equal(fs.readFileSync(path.join(old.installedRoot, 'assets/a.txt'), 'utf8'), 'OLD');
  });

  test('staging content is rehashed after interruption, not trusted from saved progress', async t => {
    const f = fixture(t);
    await f.installer().install({ releaseId: 'base' });
    await killAt(f.config(), 'copied');
    const root = f.installer().root;
    const journal = json(path.join(root, 'pending.json'));
    write(path.join(root, 'transactions', journal.id, 'tree/assets/a.txt'), 'CORRUPTED');
    const recovered = await f.installer().recover();
    assert.equal(fs.readFileSync(path.join(recovered.installedRoot, 'assets/a.txt'), 'utf8'), 'NEW-CONTENT');
  });

  test('rollback rejects corrupt previous version while healthy current remains installed', async t => {
    const f = fixture(t);
    const old = await f.installer().install({ releaseId: 'base' });
    const next = await f.installer().install({ releaseId: 'delta' });
    write(path.join(old.installedRoot, 'assets/a.txt'), 'BAD');
    await assert.rejects(f.installer().rollback(), code('CONTENT_INVALID'));
    const status = await f.installer().status();
    assert.deepEqual(status.state, next.state);
    assert.equal(status.previous.ok, false);
  });
}
