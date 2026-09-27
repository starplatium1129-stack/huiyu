import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

const guard = path.resolve(__dirname, '../lib/desktop-deploy-guard.ps1');
const windows = { skip: process.platform !== 'win32' };
async function fixture(run: (f: { root: string; install: string; config: string; owner: string; check: (install?: string, config?: string) => ReturnType<typeof spawnSync>; start: () => Promise<ChildProcess> }) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-deploy-guard-'));
  const install = path.join(root, 'install'), config = path.join(root, 'config');
  const workspace = path.join(config, 'workspaces', 'fixture');
  const owner = path.join(workspace, '.workspace-owner.json');
  fs.mkdirSync(install); fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(config, 'workspace-active.json'), JSON.stringify({ workspaceId: 'fixture' }));
  const probe = path.join(root, 'probe.ps1');
  fs.writeFileSync(probe, `param($Guard,$Install,$Config)
$ErrorActionPreference = 'Stop'
. $Guard
try { Assert-DesktopDeploymentStopped -InstallDir $Install -ConfigRoot $Config; exit 0 }
catch { Write-Output $_.Exception.Message; exit 27 }
`);
  let child: ChildProcess | undefined;
  try {
    await run({ root, install, config, owner,
      check: (target = install, data = config) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe, guard, target, data], { encoding: 'utf8', windowsHide: true, timeout: 15000 }),
      start: async () => {
        const executable = path.join(install, 'node.exe'), script = path.join(root, 'runtime.cjs');
        fs.copyFileSync(process.execPath, executable);
        fs.writeFileSync(script, `const fs=require('node:fs'); const owner=process.argv[2];
fs.writeFileSync(owner,JSON.stringify({workspaceId:'fixture',pid:process.pid,nonce:'fixture',startedAt:performance.timeOrigin}));
process.on('message',()=>{fs.unlinkSync(owner);process.exit(0)});process.send('ready');`);
        child = spawn(executable, [script, owner], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        await once(child, 'message'); return child;
      },
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('huiyu-deploy-guard-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('deployment waits for an actual runtime to quit and release its owner, without stopping it', windows, async () => {
  await fixture(async f => {
    const child = await f.start(), before = fs.readFileSync(f.owner);
    const blocked = f.check();
    assert.equal(blocked.status, 27, String(blocked.stderr));
    assert.match(String(blocked.stdout), /DESKTOP_RUNNING/);
    assert.equal(child.exitCode, null);
    assert.deepEqual(fs.readFileSync(f.owner), before);
    const unrelated = f.check(path.join(f.root, 'other-install'), path.join(f.root, 'other-config'));
    assert.equal(unrelated.status, 0, String(unrelated.stderr));
    const exited = once(child, 'exit'); child.send('quit'); await exited;
    const ready = f.check();
    assert.equal(ready.status, 0, String(ready.stderr));
    assert.equal(fs.existsSync(f.owner), false);
  });
});

test('deployment preserves a stale owner instead of deleting it to make progress', windows, async () => {
  await fixture(async f => {
    fs.writeFileSync(f.owner, JSON.stringify({ workspaceId: 'fixture', pid: 2147483647, nonce: 'retained', startedAt: 1 }));
    const before = fs.readFileSync(f.owner), result = f.check();
    assert.equal(result.status, 27, String(result.stderr));
    assert.match(String(result.stdout), /WORKSPACE_LOCK_REMAINS/);
    assert.deepEqual(fs.readFileSync(f.owner), before);
  });
});
