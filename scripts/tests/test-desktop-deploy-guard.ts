import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

const guard = path.resolve(__dirname, '../lib/desktop-deploy-guard.ps1');
const windows = { skip: process.platform !== 'win32' };
async function fixture(run: (f: { root: string; install: string; config: string; owner: string; check: (install?: string, config?: string, mode?: string) => ReturnType<typeof spawnSync>; start: () => Promise<ChildProcess> }) => Promise<void>) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-deploy-guard-')));
  const install = path.join(root, 'install'), config = path.join(root, 'config');
  const workspace = path.join(config, 'workspaces', 'fixture');
  const owner = path.join(workspace, '.workspace-owner.json');
  fs.mkdirSync(install); fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(config, 'workspace-active.json'), JSON.stringify({ workspaceId: 'fixture' }));
  const probe = path.join(root, 'probe.ps1');
  fs.writeFileSync(probe, `param($Guard,$Install,$Config,$Mode)
$ErrorActionPreference = 'Stop'
. $Guard
try { if($Mode -eq 'maintain'){Stop-DesktopForDeployment -InstallDir $Install -ConfigRoot $Config}else{Assert-DesktopDeploymentStopped -InstallDir $Install -ConfigRoot $Config}; exit 0 }
catch { Write-Output $_.Exception.Message; exit 27 }
`);
  let child: ChildProcess | undefined;
  try {
    await run({ root, install, config, owner,
      check: (target = install, data = config, mode = 'assert') => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe, guard, target, data, mode], { encoding: 'utf8', windowsHide: true, timeout: 15000 }),
      start: async () => {
        const executable = path.join(install, 'gateway/huiyu-runtime.exe'), script = path.join(root, 'runtime.cjs');
        fs.mkdirSync(path.dirname(executable),{recursive:true});
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
    assert.equal(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(os.tmpdir()));
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
    const legacy = f.check(f.install, f.config, 'maintain');
    assert.equal(legacy.status, 27); assert.match(String(legacy.stdout), /DESKTOP_MAINTENANCE_UNSUPPORTED/);
    assert.equal(child.exitCode, null); assert.deepEqual(fs.readFileSync(f.owner), before);
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

test('resource-only deployment requires matching Rust executable, DLLs and embedded UI host',windows,async()=>{
  await fixture(async f=>{
    const stage=path.join(f.root,'stage'),host=path.join(f.root,'candidate-host.exe');
    const put=(file:string,data:string)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
    const sourceHost='host-prefix\0__TAURI_BUNDLE_TYPE_VAR_UNK\0host-suffix';
    const nsisHost=sourceHost.replace('_VAR_UNK','_VAR_NSS'),installedHost=path.join(f.install,'ai-cg-studio-desktop.exe');
    put(host,sourceHost);put(installedHost,nsisHost);
    for(const name of ['huiyu-runtime.exe','native/libvips-42.dll']){put(path.join(stage,name),name);put(path.join(f.install,'gateway',name),name);}
    const script=path.join(f.root,'native-check.ps1');
    fs.writeFileSync(script,"param($Guard,$Stage,$Install,$HostFile)\n$ErrorActionPreference='Stop'\n. $Guard\ntry{Assert-DesktopRuntimeMatches -StageGateway $Stage -InstallDir $Install -HostExecutable $HostFile;exit 0}catch{Write-Output $_.Exception.Message;exit 27}\n");
    const check=()=>spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,guard,stage,f.install,host],{encoding:'utf8',windowsHide:true,timeout:15000});
    const success=check();assert.equal(success.status,0,success.stdout+success.stderr);
    for(const name of ['huiyu-runtime.exe','native/libvips-42.dll']){
      put(path.join(stage,name),'changed');const denied=check();assert.equal(denied.status,27);assert.match(String(denied.stdout),/DESKTOP_FULL_INSTALL_REQUIRED/);
      assert.equal(fs.readFileSync(path.join(f.install,'gateway',name),'utf8'),name);put(path.join(stage,name),name);
    }
    put(host,sourceHost+'changed embedded desktop UI');assert.match(String(check().stdout),/DESKTOP_FULL_INSTALL_REQUIRED/);
    put(host,sourceHost);put(installedHost,sourceHost);assert.match(String(check().stdout),/DESKTOP_FULL_INSTALL_REQUIRED/,'unpatched host is not the NSIS payload');
    put(installedHost,nsisHost+'tampered');assert.match(String(check().stdout),/DESKTOP_FULL_INSTALL_REQUIRED/,'only the exact bundle marker transformation is allowed');
    put(host,sourceHost+'__TAURI_BUNDLE_TYPE_VAR_UNK');assert.match(String(check().stdout),/DESKTOP_BUNDLE_MARKER_INVALID/,'ambiguous source markers cannot be accepted');
  });
});

test('capable local host is queried and drained; reused PID identity is rejected before invoking its CLI', windows, async () => {
  await fixture(async f => {
    const source = path.join(f.root, 'host.cs'), executable = path.join(f.install, 'ai-cg-studio-desktop.exe');
    fs.writeFileSync(source, String.raw`
using System; using System.IO; using System.Diagnostics; using System.Threading; using System.Collections.Generic; using System.Web.Script.Serialization;
class FixtureHost {
  static void Main(string[] args) {
    string root=Environment.GetEnvironmentVariable("HUIYU_MAINTENANCE_FIXTURE"), config=Path.Combine(root,"config");
    var json=new JavaScriptSerializer();
    if(args.Length>0 && args[0]=="--desktop-maintenance") {
      string pending=Path.Combine(root,"pending-"+args[3]);
      File.WriteAllText(pending,args[3]);File.Move(pending,Path.Combine(root,"signal-"+args[3]));return;
    }
    var process=Process.GetCurrentProcess();
    var identity=new Dictionary<string,object>{{"protocolVersion",1},{"instanceId",new string('a',64)},{"hostPid",process.Id},
      {"startedAtFiletime",process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()},{"executable",process.MainModule.FileName},{"instanceNamespace","com.aics.studio"}};
    File.WriteAllText(Path.Combine(config,"desktop-maintenance.json"),json.Serialize(identity));
    string owner=Path.Combine(config,"workspaces","fixture",".workspace-owner.json");File.WriteAllText(owner,"fixture-owned");
    Console.WriteLine("HOST_READY");Console.Out.Flush();
    while(true) {foreach(string signal in Directory.GetFiles(root,"signal-*")) {
      string id=File.ReadAllText(signal);File.Delete(signal);
      var request=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(config,"desktop-maintenance",id+".request.json")));
      bool closing=(string)request["command"]=="shutdown";
      if(closing) {File.WriteAllText(Path.Combine(root,"drain-started"),"true");Thread.Sleep(150);File.Delete(owner);}
      var response=new Dictionary<string,object>(identity);response["requestId"]=id;response["state"]=closing?"drained":"ready";response["reason"]=null;
      string target=Path.Combine(config,"desktop-maintenance",id+".response.json");File.WriteAllText(target+".tmp",json.Serialize(response));File.Move(target+".tmp",target);
      if(closing)return;
    }Thread.Sleep(10);}
  }
}`);
    const compile = path.join(f.root, 'compile.ps1');
    fs.writeFileSync(compile, `param($Source,$Output)\n$ErrorActionPreference='Stop'\nAdd-Type -Path $Source -ReferencedAssemblies System.dll,System.Web.Extensions.dll -OutputAssembly $Output -OutputType ConsoleApplication\n`);
    const built = spawnSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',compile,source,executable], { encoding:'utf8', windowsHide:true });
    assert.equal(built.status, 0, built.stderr);
    const env = { ...process.env, HUIYU_MAINTENANCE_FIXTURE:f.root };
    const child = spawn(executable, ['--fixture-host'], { windowsHide:true, env, stdio:['ignore','pipe','pipe'] });
    let hostStderr = '';
    child.stderr!.on('data', chunk => { hostStderr += String(chunk); });
    try {
      await once(child.stdout!, 'data');
      const invoke = path.join(f.root, 'invoke.ps1');
      fs.writeFileSync(invoke, `param($Guard,$Install,$Config,$Action)\n$ErrorActionPreference='Stop'\n. $Guard\ntry { if($Action -eq 'status'){Invoke-DesktopMaintenance -InstallDir $Install -ConfigRoot $Config -Command status -TimeoutSeconds 5 | ConvertTo-Json -Compress}else{Stop-DesktopForDeployment -InstallDir $Install -ConfigRoot $Config};exit 0 }catch{Write-Output $_.Exception.Message;exit 27}\n`);
      // Keep draining the fixture's stderr and exit event while PowerShell waits
      // for its receipt; a blocked Node loop would hide the host's actual failure.
      type Invocation = { status: number | null; error?: Error; stdout: string; stderr: string };
      const run = (action: string) => new Promise<Invocation>(resolve => {
        const client = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',invoke,guard,f.install,f.config,action], { env, windowsHide:true, timeout:15000 });
        let stdout = '', stderr = '', error: Error | undefined;
        client.stdout.on('data', chunk => { stdout += String(chunk); });
        client.stderr.on('data', chunk => { stderr += String(chunk); });
        client.on('error', cause => { error = cause; });
        client.on('close', status => resolve({ status, error, stdout, stderr }));
      });
      const diagnostics = (result: Invocation) => JSON.stringify({
        error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
        hostStderr, hostExitCode: child.exitCode, hostSignal: child.signalCode,
        drainStarted: fs.existsSync(path.join(f.root, 'drain-started')),
        ownerPresent: fs.existsSync(f.owner),
      });
      const status = await run('status'); assert.equal(status.status, 0, diagnostics(status)); assert.match(String(status.stdout), /ready/);
      assert.deepEqual(fs.readdirSync(path.join(f.config,'desktop-maintenance')), [], 'only this request files are removed');
      const file = path.join(f.config, 'desktop-maintenance.json'), original = fs.readFileSync(file);
      const identity = JSON.parse(String(original)); identity.startedAtFiletime = '111111111111111111'; fs.writeFileSync(file, JSON.stringify(identity));
      const refused = await run('status'); assert.equal(refused.status, 27, diagnostics(refused)); assert.match(String(refused.stdout), /DESKTOP_MAINTENANCE_IDENTITY/);
      assert.equal(child.exitCode, null); fs.writeFileSync(file, original);
      const exited = once(child, 'exit'), stopped = await run('shutdown');
      assert.equal(stopped.status, 0, diagnostics(stopped)); await exited;
      assert.equal(fs.existsSync(f.owner), false); assert.equal(fs.existsSync(path.join(f.root, 'drain-started')), true);
    } finally { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
  });
});
