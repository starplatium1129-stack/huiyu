'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');

const {
  acquireDesktopBuildLock,
  desktopBuildLockPath,
  withDesktopBuildLock,
}: typeof import('../maintenance/desktop-build-lock') = require('../maintenance/desktop-build-lock');
const { resolveNpmInvocation, stageResources }: typeof import('../maintenance/desktop-stage-resources') = require('../maintenance/desktop-stage-resources');
const { runTauri }: any = require('../maintenance/run-tauri');
const { resolveSdkRoot }: typeof import('../maintenance/desktop-build-environment') = require('../maintenance/desktop-build-environment');
const { customizeTemplate }: typeof import('../maintenance/build-game-installer') = require('../maintenance/build-game-installer');

test('desktop SDK discovery supports the workspace and does not ignore an explicit broken path', () => {
  const root = path.resolve('fixture-root');
  const local = path.join(root, 'runtime/desktop-build-sdk/CubismSdkForNative-5-r.5');
  assert.equal(resolveSdkRoot(root, {}, (candidate: any) => candidate.startsWith(local)), local);
  const explicit = path.resolve('explicit-sdk');
  assert.equal(resolveSdkRoot(root, { LIVE2D_CUBISM_SDK_DIR: explicit }, () => false), explicit);
  assert.equal(resolveSdkRoot(root, {}, () => false), '');
});

test('game installer preserves upstream install and maintenance behavior', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../desktop-tauri/src-tauri/installer/vendor/tauri-2.12.0.nsi'), 'utf8');
  const themed = customizeTemplate(source, 'C:\\preview\\art.bmp', 'C:\\preview\\game-ui.nsh');
  const sections = (text: any) => text.slice(text.indexOf('Section EarlyChecks'));
  let payload = sections(themed);
  assert.equal((payload.match(/"\$INSTDIR\\huiyu-icon.ico" 0/g) || []).length, 3);
  payload = payload.replaceAll(' "" "$INSTDIR\\huiyu-icon.ico" 0', '')
    .replace("\n  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'", '');
  for (const location of ['$DESKTOP', '$SMPROGRAMS', '$SMPROGRAMS\\$AppStartMenuFolder']) {
    const migration = `
  !insertmacro IsShortcutTarget "${location}\\\${PRODUCTNAME}.lnk" "$INSTDIR\\\${MAINBINARYNAME}.exe"
  Pop $0
  \${If} $0 = 1
    \${IfNot} \${FileExists} "${location}\\绘遇 HUIYU.lnk"
      Rename "${location}\\\${PRODUCTNAME}.lnk" "${location}\\绘遇 HUIYU.lnk"
    \${EndIf}
  \${EndIf}
`;
    assert.equal(payload.split(migration).length, 2, 'migration must check ownership and collisions');
    payload = payload.replace(migration, '');
  }
  payload = payload.replaceAll('绘遇 HUIYU.lnk', '${PRODUCTNAME}.lnk')
    .replace('"DisplayName" "绘遇 · HUIYU"', '"DisplayName" "${PRODUCTNAME}"');
  assert.equal(payload, sections(source), 'only display name and guarded shortcut migration may differ; payload and upgrade behavior stay upstream-owned');
  for (const key of ['PRODUCTNAME', 'UNINSTKEY', 'MANUPRODUCTKEY']) {
    const definition = new RegExp(`!define ${key} [^\\r\\n]+`);
    assert.equal(themed.match(definition)?.[0], source.match(definition)?.[0], key);
  }
  for (const name of ['.onInit', 'PageLeaveReinstall', 'RunMainBinary']) {
    const block = (text: any) => text.slice(text.indexOf(`Function ${name}`), text.indexOf('FunctionEnd', text.indexOf(`Function ${name}`)));
    assert.equal(block(themed), block(source), name);
  }
  assert.match(themed, /Page custom GameDirectory GameDirectoryLeave/);
  assert.match(themed, /Page custom GameFinish GameFinishLeave/);
  assert.throws(() => customizeTemplate(source.replace('!insertmacro MUI_PAGE_WELCOME', '; removed'), 'a', 'b'), /anchor drift/);
});

function write(filePath: any, content: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function remove(root: string) {
  const actual=fs.realpathSync(root);
  assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));
  assert.ok(/^aics-/.test(path.basename(actual)));
  fs.rmSync(actual,{recursive:true,force:true});
}
function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-stage-fixture-'));
  for (const directory of ['server', 'routes', 'services', 'scripts/lib', 'data', 'dist', 'assets', 'tools']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  write(path.join(root, 'server.js'), 'legacy runtime excluded');
  write(path.join(root, 'docs/redirects.json'), '{"/docs/old":"/docs/new"}');
  write(path.join(root, 'scripts/lib/managed-webui.ps1'), '# fixture');
  write(path.join(root, 'scripts/lib/managed-comfyui.ps1'), '# fixture');
  write(path.join(root, 'scripts/lib/runtime.js'), 'excluded');
  write(path.join(root, 'data/characters.json'), '{}'); write(path.join(root, 'dist/index.html'), '<!doctype html>');
  write(path.join(root, 'assets/asset.txt'), 'asset'); write(path.join(root, 'tools/nav.js'), 'browser');
  for (const name of ['Install-OfflineResources.cmd', 'offline-resource-assistant.ps1', 'install-offline-resources.ps1']) {
    write(path.join(root, 'tools', name), `offline helper: ${name}`);
  }
  write(path.join(root, 'tools/interrogate/pixai_worker.py'), '# model worker');
  write(path.join(root, 'tools/interrogate/pixai-manifest.json'), '{}');
  write(path.join(root, 'tools/interrogate/test_pixai_worker.py'), '# excluded test');
  for(const name of ['history.json','projects.json','prompts.json','live2d-candidates.json','live2d-candidates.json.br'])write(path.join(root,'data',name),'private');
  write(path.join(root,'data/references/fixture.json'),'{}');write(path.join(root,'tools/control-server.js'),'old-node-service');
  write(path.join(root, 'assets/character-references/private.png'), 'private');
  write(path.join(root, 'assets/live2d-candidates/private.model3.json'), 'private');
  write(path.join(root, 'runtime-rs/src/main.rs'), 'fn main() {}');
  write(path.join(root, 'runtime-rs/Cargo.toml'), '[package]'); write(path.join(root, 'runtime-rs/Cargo.lock'), '# fixture');
  const sha = (data: string) => (require('node:crypto') as typeof import('node:crypto')).createHash('sha256').update(data).digest('hex');
  const binary = 'runtime-rs/target/release/huiyu-runtime.exe'; write(path.join(root, binary), 'binary');
  const { SOURCES }: typeof import('../maintenance/desktop-rust-inputs') = require('../maintenance/desktop-rust-inputs');
  const { snapshot }: typeof import('../lib/delivery-identity') = require('../lib/delivery-identity');
  write(path.join(root, 'runtime/rust-evidence/build.json'), JSON.stringify({ formatVersion: 1, source: snapshot(root, SOURCES), binary: { path: binary, bytes: 6, sha256: sha('binary') } }));
  const files = ['libvips-42.dll', 'onnxruntime.dll'].map(name => { write(path.join(root, `fixture-native/${name}`), name); return { name, source: `fixture-native/${name}`, bytes: Buffer.byteLength(name), sha256: sha(name) }; });
  write(path.join(root, 'runtime-rs/native-licenses/LICENSE'), 'license');
  write(path.join(root, 'runtime-rs/native-licenses/README.md'), 'fixture notes\n');
  write(path.join(root, 'runtime-rs/native-licenses/components/fixture/COPYING'), 'upstream bytes\r\n ');
  const inventory = JSON.stringify({ schemaVersion: 1, files: [
    { file: 'LICENSE', bytes: 7, sha256: sha('license') },
    { file: 'README.md', bytes: Buffer.byteLength('fixture notes\n'), sha256: sha('fixture notes\n') },
    { file: 'components/fixture/COPYING', bytes: Buffer.byteLength('upstream bytes\r\n '), sha256: sha('upstream bytes\r\n ') },
  ] }) + '\n';
  write(path.join(root, 'runtime-rs/native-licenses/materials.sha256.json'), inventory);
  write(path.join(root, 'runtime-rs/native-dependencies.windows-x64.json'), JSON.stringify({ schemaVersion: 1, platform: 'win32-x64', status: 'candidate', files,
    licenses: [{ file: 'native-licenses/LICENSE', bytes: 7, sha256: sha('license') }], redistribution: { pending: ['fixture notices pending'] },
    licenseEvidence: { index: 'native-licenses/materials.sha256.json', indexBytes: Buffer.byteLength(inventory), indexSha256: sha(inventory),
      readme: 'native-licenses/README.md', components: 'native-licenses/components/fixture/COPYING', librsvgCargoSourceIndex: 'native-licenses/components/fixture/COPYING' } }));
  return root;
}
test('npm invocation works without shelling through npm.cmd', () => {
  const npm = resolveNpmInvocation();
  const result = spawnSync(npm.command, [...npm.args, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || 'npm --version failed');
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('Rust stage verifies bound inputs, excludes legacy/private files, and replaces atomically', () => {
  const root = createFixture(), stage = path.join(root, 'desktop-tauri/src-tauri/resources');
  try {
    write(path.join(stage, 'stale.txt'), 'old');
    const result = stageResources({ root, stage, logger: () => {} });
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/huiyu-runtime.exe'), 'utf8'), 'binary');
    assert.equal(fs.existsSync(path.join(stage, 'gateway/native/onnxruntime.dll')), true);
    assert.equal(fs.existsSync(path.join(stage, 'gateway/native-licenses/LICENSE')), true);
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/native-licenses/components/fixture/COPYING'), 'utf8'), 'upstream bytes\r\n ');
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/native-licenses/README.md'), 'utf8'), 'fixture notes\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'gateway/rust-runtime-build.json'), 'utf8')).nativeMaterialCount, 4);
    assert.equal(result.releaseReady, false); assert.deepEqual(result.pending, ['fixture notices pending']);
    for (const name of ['server.js', 'server', 'routes', 'services', 'node_modules', 'package.json', 'scripts/lib/runtime.js', 'assets/character-references/private.png', 'assets/live2d-candidates/private.model3.json','data/history.json','data/projects.json','data/prompts.json','data/live2d-candidates.json','data/live2d-candidates.json.br','tools/control-server.js']) assert.equal(fs.existsSync(path.join(stage, 'gateway', name)), false, name);
    assert.equal(fs.existsSync(path.join(stage,'gateway/data/references/fixture.json')),true);
    assert.equal(fs.existsSync(path.join(stage,'gateway/tools/nav.js')),true);
    for (const name of ['Install-OfflineResources.cmd', 'offline-resource-assistant.ps1', 'install-offline-resources.ps1']) {
      assert.equal(fs.readFileSync(path.join(stage, 'gateway/tools', name), 'utf8'), `offline helper: ${name}`);
    }
    assert.equal(fs.readFileSync(path.join(stage,'gateway/tools/interrogate/pixai_worker.py'),'utf8'),'# model worker');
    assert.equal(fs.existsSync(path.join(stage,'gateway/tools/interrogate/pixai-manifest.json')),true);
    assert.equal(fs.existsSync(path.join(stage,'gateway/tools/interrogate/test_pixai_worker.py')),false);
    assert.equal(fs.existsSync(path.join(stage, 'stale.txt')), false);
    const { assertNativeReleaseReady }: typeof import('../maintenance/desktop-rust-inputs') = require('../maintenance/desktop-rust-inputs');
    assert.throws(() => assertNativeReleaseReady(path.join(stage,'gateway')), /not approved/);
    const manifestPath = path.join(root,'runtime-rs/native-dependencies.windows-x64.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    manifest.status = 'redistribution-verified'; manifest.redistribution.pending = [];
    Object.assign(manifest.licenseEvidence, { publicRedistributionApproved:true, completeLinkedLicenseClosure:true });
    write(manifestPath,JSON.stringify(manifest));
    assert.equal(stageResources({root,stage,logger:()=>{}}).releaseReady,true);
    assert.doesNotThrow(() => assertNativeReleaseReady(path.join(stage,'gateway')));
  } finally { remove(root); }
});
test('stale Rust source or tampered DLL leaves previous complete stage untouched', () => {
  const root = createFixture(), stage = path.join(root, 'resources');
  try {
    write(path.join(stage, 'old/marker.txt'), 'old');
    write(path.join(root, 'fixture-native/onnxruntime.dll'), 'tampered');
    assert.throws(() => stageResources({ root, stage, logger: () => {} }), /bytes mismatch/);
    assert.equal(fs.readFileSync(path.join(stage, 'old/marker.txt'), 'utf8'), 'old');
    write(path.join(root, 'runtime-rs/src/main.rs'), 'changed');
    assert.throws(() => stageResources({ root, stage, logger: () => {} }), /stale/);
    assert.equal(fs.existsSync(path.join(stage, 'gateway')), false);
  } finally { remove(root); }
});
test('prepare builds Rust and bundled UI before staging and verifying the candidate',async()=>{
  const root=createFixture(),events:string[]=[];
  const {prepareTauri}:typeof import('../maintenance/prepare-tauri')=require('../maintenance/prepare-tauri');
  try {
    const result=await prepareTauri({root,logger:()=>{},buildInstaller:()=>events.push('installer'),buildRuntime:()=>events.push('rust'),
      buildDesktopUi:()=>{events.push('ui');write(path.join(root,'desktop-tauri/web/index.html'),'desktop');},
      verifyGateway:()=>{events.push('verify');assert.ok(fs.existsSync(path.join(root,'desktop-tauri/src-tauri/resources/gateway/huiyu-runtime.exe')));}});
    assert.deepEqual(events,['installer','rust','ui','verify']);assert.equal(result.releaseReady,false);
  }finally{remove(root);}
});
test('bundle verifier isolates model hosts and credentials from inherited settings',()=>{
  const {isolatedEnvironment}:typeof import('../maintenance/verify-desktop-gateway')=require('../maintenance/verify-desktop-gateway');
  const env=isolatedEnvironment('fixture-state','fixture-gateway');
  for(const key of ['SD_HOST','COMFY_HOST','TTS_HOST','OLLAMA_HOST'])assert.equal(env[key],'http://127.0.0.1:1');
  assert.equal(env.DISABLE_TUNNEL,'1');assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.AICS_DESKTOP_CONFIG_ROOT,undefined);
});
test('development native environment uses locked DLLs and preserves explicit overrides',{skip:process.platform!=='win32'},()=>{
  const root=createFixture();const {developmentNativeEnvironment}:typeof import('../maintenance/desktop-rust-inputs')=require('../maintenance/desktop-rust-inputs');
  try{const supplied={AICS_ORT_DYLIB_PATH:'explicit-ort.dll'};const env=developmentNativeEnvironment(root,supplied);
    assert.equal(env.AICS_ORT_DYLIB_PATH,'explicit-ort.dll');assert.equal(env.AICS_VIPS_DYLIB_PATH,path.join(root,'fixture-native/libvips-42.dll'));assert.deepEqual(supplied,{AICS_ORT_DYLIB_PATH:'explicit-ort.dll'});
    write(path.join(root,'fixture-native/libvips-42.dll'),'tampered');assert.throws(()=>developmentNativeEnvironment(root,supplied),/bytes mismatch/);
  }finally{remove(root);}
});
test('non-Windows development does not read the Windows native manifest',{skip:process.platform==='win32'},()=>{
  const {developmentNativeEnvironment}:typeof import('../maintenance/desktop-rust-inputs')=require('../maintenance/desktop-rust-inputs');
  const supplied:NodeJS.ProcessEnv={AICS_ORT_DYLIB_PATH:'/explicit/libonnxruntime.so',PATH:'/fixture/bin'};
  const result=developmentNativeEnvironment('/missing-fixture-root',supplied);
  assert.deepEqual(result,supplied);assert.notEqual(result,supplied);assert.equal(result.AICS_VIPS_DYLIB_PATH,undefined);
});
test('workspace lock serializes concurrent build critical sections', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-lock-fixture-'));
  const lockRoot = path.join(root, 'locks');
  let active = 0;
  let maximum = 0;
  try {
    await Promise.all([1, 2].map(() => withDesktopBuildLock({
      workspaceRoot: root,
      lockRoot,
      pollMs: 5,
      waitTimeoutMs: 1000,
    }, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
    })));
    assert.equal(maximum, 1);
  } finally {
    remove(root);
  }
});

test('workspace lock never steals an old lock from a live owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-lock-live-owner-'));
  const lockRoot = path.join(root, 'locks');
  const lockPath = desktopBuildLockPath(root, lockRoot);
  try {
    fs.mkdirSync(lockPath, { recursive: true });
    write(path.join(lockPath, 'owner.json'), JSON.stringify({
      token: 'live-owner',
      pid: process.pid,
      hostname: os.hostname(),
      workspace: root,
    }) + '\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    await assert.rejects(
      acquireDesktopBuildLock({
        workspaceRoot: root,
        lockRoot,
        pollMs: 5,
        waitTimeoutMs: 30,
        staleMs: 1,
      }),
      /desktop build lock timeout/,
    );
  } finally {
    remove(root);
  }
});

test('runTauri holds the lock across build, verification, preparation and CLI', async () => {
  const events: any = [];
  await runTauri(['build', '--no-bundle'], {
    root: 'fixture-root',
    env:{},
    binding: { sourceIdentity: () => { events.push('capture-source'); return {} as never; },
      sdkIdentity:() => {events.push('capture-sdk');return {root:'fixture-sdk',inputs:{sha256:'a'.repeat(64)}};},
      recordBuild:(_root: string,_source: unknown,_bundle: boolean,sdk: any) => {assert.equal(sdk.inputs.sha256,'a'.repeat(64));events.push('bind-build');} },
    npmCommand: 'npm',
    checkEnvironment: () => { events.push('environment'); },
    withLock: async (options: any, callback: any) => {
      events.push('lock');
      const result = await callback();
      events.push('unlock');
      return result;
    },
    runCommand: (command: any, args: any) => {
      events.push(`${command}:${args.join(' ')}`);
      return 0;
    },
    prepareTauri: async () => { events.push('prepare'); },
    tauriCli: 'tauri-cli.js',
    spawnTauri: (command: any, args: any, options: any) => {
      assert.equal(options.env.LIVE2D_CUBISM_SDK_SHA256,'a'.repeat(64));
      events.push(`${command}:${args.join(' ')}`);
      return 0;
    },
  });
  assert.deepEqual(events, [
    'lock',
    'environment',
    'capture-source',
    'capture-sdk',
    'npm:run build',
    'prepare',
    `${process.execPath}:tauri-cli.js build --no-bundle`,
    'bind-build',
    'unlock',
  ]);
});


test('updater verifies distributed bytes and rejects tampering', () => {
  const crypto: typeof import('node:crypto') = require('node:crypto');
  const { verifyUpdaterSignature }: typeof import('../maintenance/build-modern-installer') = require('../maintenance/build-modern-installer');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-updater-signature-'));
  try {
    const file = path.join(root, 'fixture.exe');
    fs.writeFileSync(file, 'installer fixture');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const id = Buffer.from('12345678');
    const key = Buffer.concat([Buffer.from('Ed'), id, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]);
    const raw = crypto.sign(null, crypto.createHash('blake2b512').update(fs.readFileSync(file)).digest(), privateKey);
    const packet = Buffer.concat([Buffer.from('ED'), id, raw]);
    const comment = 'timestamp:1';
    const global = crypto.sign(null, Buffer.concat([raw, Buffer.from(comment)]), privateKey);
    const signature = Buffer.from(['untrusted comment: fixture', packet.toString('base64'), 'trusted comment: ' + comment, global.toString('base64')].join('\n')).toString('base64');
    const pub = Buffer.from('untrusted comment: fixture\n' + key.toString('base64')).toString('base64');
    assert.equal(verifyUpdaterSignature(file, signature, pub), true);
    fs.appendFileSync(file, 'tampered');
    assert.throws(() => verifyUpdaterSignature(file, signature, pub), /signature verification failed/);
  } finally { remove(root); }
});
