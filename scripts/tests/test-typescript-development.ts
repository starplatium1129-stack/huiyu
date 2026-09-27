import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const development = import('../dev-server.mjs');
async function stopFixture(child:ChildProcess){
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>(resolve=>{child.once('close',()=>resolve());child.kill();});
}

function isolatedProcess(children: ChildProcess[]) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', windowsHide: true,
  });
  children.push(child);
  return child;
}

test('development restarts only after a changed successful build and keeps the last process on compilation errors', async () => {
  const { startDevelopment } = await development;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-dev-cycle-'));
  const children: ChildProcess[] = [];
  const errors: any[] = [];
  let mode: 'changed' | 'cached' | 'failed' = 'changed';
  let builds = 0;
  const session = await startDevelopment(root, {
    watch: false,
    build() {
      builds++;
      if (mode === 'failed') throw new Error('fixture compiler error');
      return mode === 'changed';
    },
    start: () => isolatedProcess(children),
    stop:stopFixture,
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
    assert.match(String(errors[0]), /fixture compiler error/);
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
  const errors: any[] = [];
  const session = await startDevelopment(process.cwd(), {
    watch: false,
    build() { if (!valid) throw new Error('invalid initial source'); return true; },
    start: () => isolatedProcess(children),
    stop:stopFixture,
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

test('source watcher reacts to Rust edits without looping on Cargo outputs', async () => {
  const { startDevelopment } = await development;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-dev-watch-'));
  fs.mkdirSync(path.join(root,'runtime-rs/src'),{recursive:true});
  fs.mkdirSync(path.join(root,'runtime-rs/target/debug'),{recursive:true});
  fs.writeFileSync(path.join(root, 'runtime-rs/src/main.rs'), 'fn main() {}\n');
  const children: ChildProcess[] = [];
  const errors: any[] = [];
  let builds = 0;
  const session = await startDevelopment(root, {
    debounceMs: 20,
    build() {
      builds++;
      fs.writeFileSync(path.join(root, 'runtime-rs/target/debug/huiyu-runtime.exe'), `// generated fixture ${builds}\n`);
      return true;
    },
    start: () => isolatedProcess(children),
    stop:stopFixture,
    reportError: error => errors.push(error),
  });
  try {
    const initial = builds;
    fs.writeFileSync(path.join(root, 'runtime-rs/src/main.rs'), 'fn main() { println!("changed"); }\n');
    const deadline = Date.now() + 5000;
    while (builds === initial && Date.now() < deadline) await delay(20);
    assert.ok(builds > initial, 'a source edit must trigger a build');
    await delay(120);
    const settled = builds;
    fs.writeFileSync(path.join(root, 'runtime-rs/target/debug/huiyu-runtime.exe'), '// generated output only\n');
    await delay(100);
    assert.equal(builds, settled, 'Cargo output must not trigger another compile');
    assert.deepEqual(errors, []);
  } finally {
    await session.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed drain retains the previous process and never launches a second writer',async()=>{
  const {startDevelopment}=await development;const children:ChildProcess[]=[],errors:unknown[]=[];let blocked=true;
  const session=await startDevelopment(process.cwd(),{watch:false,build:()=>true,start:()=>isolatedProcess(children),
    stop:async child=>{if(blocked)throw Error('fixture drain refused');await stopFixture(child);},reportError:error=>errors.push(error)});
  try{const first=session.pid;await session.rebuild();assert.equal(session.pid,first);assert.equal(children.length,1);assert.equal(children[0].killed,false);assert.match(String(errors[0]),/drain refused/);}
  finally{blocked=false;await session.close();}
});

test('development shutdown signs a fresh host request and refuses an unconfirmed drain',async()=>{
  const {drainDevelopmentRuntime}=await development;
  const {createServer}=await import('node:http');const {createHmac}=await import('node:crypto');const children:ChildProcess[]=[];
  const secret='a'.repeat(64),profile='profile-'+'b'.repeat(64);let allow=false,requests=0;const nonces=new Set<string>();
  const child=isolatedProcess(children);
  const server=createServer((req,res)=>{
    if(req.url==='/api/health'){const challenge=String(req.headers['x-aics-desktop-challenge']);res.end(JSON.stringify({desktopProof:createHmac('sha256',secret).update(challenge).digest('hex')}));return;}
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      assert.equal(req.url,'/api/desktop-host');assert.equal(req.headers['x-aics-host-proof'],createHmac('sha256',secret).update('aics-desktop-host:v1\n'+body).digest('hex'));
      const value=JSON.parse(body);assert.equal(value.sourceProfileId,profile);assert.equal(value.action,'shutdown');assert.equal(value.windowId,'atelier');assert.ok(Math.abs(Date.now()-value.timestamp)<5000);assert.match(value.nonce,/^[a-f0-9]{64}$/);assert.ok(!nonces.has(value.nonce));nonces.add(value.nonce);requests++;
      res.statusCode=allow?200:503;res.end(JSON.stringify({closed:allow}));if(allow)setTimeout(()=>child.kill(),10);
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try{await assert.rejects(drainDevelopmentRuntime(child,{secret,profile,origin}),/drain not confirmed/);assert.equal(child.killed,false);
    allow=true;await drainDevelopmentRuntime(child,{secret,profile,origin});assert.equal(requests,2);assert.ok(child.exitCode!==null||child.signalCode!==null);
  }finally{await stopFixture(child);await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
