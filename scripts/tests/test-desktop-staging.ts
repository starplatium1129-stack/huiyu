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
  assert.equal((payload.match(/Call GameCheckStopped/g) || []).length, 2, 'check before prerequisites and again before application replacement');
  assert.equal((payload.match(/Call un.GameCheckStopped/g) || []).length, 1, 'uninstall must reject active processes');
  assert.equal((payload.match(/Call GameCreateResourceShortcut/g) || []).length, 1);
  assert.equal((payload.match(/Call un.GameRemoveResourceShortcut/g) || []).length, 1);
  payload = payload.replace('Section EarlyChecks\n  Call GameCheckStopped', 'Section EarlyChecks')
    .replaceAll('Call GameCheckStopped', '!insertmacro CheckIfAppIsRunning "$INSTDIR\\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"')
    .replaceAll('Call un.GameCheckStopped', '!insertmacro CheckIfAppIsRunning "$INSTDIR\\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"')
    .replace('  Call GameCreateResourceShortcut\n\n', '')
    .replace('\n    Call un.GameRemoveResourceShortcut', '');
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
  assert.equal(payload, sections(source), 'only branding, owned shortcuts and non-destructive running checks may differ; payload and data removal stay upstream-owned');
  for (const key of ['PRODUCTNAME', 'UNINSTKEY', 'MANUPRODUCTKEY']) {
    const definition = new RegExp(`!define ${key} [^\\r\\n]+`);
    assert.equal(themed.match(definition)?.[0], source.match(definition)?.[0], key);
  }
  for (const name of ['.onInit', 'PageLeaveReinstall', 'RunMainBinary']) {
    const block = (text: any) => text.slice(text.indexOf(`Function ${name}`), text.indexOf('FunctionEnd', text.indexOf(`Function ${name}`)));
    const actual = block(themed).replace('\n    Call GameCheckPreviousStopped', '');
    assert.equal(actual, block(source), name);
  }
  assert.match(themed, /Page custom GameDirectory GameDirectoryLeave/);
  assert.match(themed, /Page custom GameFinish GameFinishLeave/);
  assert.throws(() => customizeTemplate(source.replace('!insertmacro MUI_PAGE_WELCOME', '; removed'), 'a', 'b'), /anchor drift/);
});

test('native installer refuses active processes and preserves shortcut ownership', {
  skip: process.platform !== 'win32' || !fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'tauri/NSIS/makensis.exe'))
    || !fs.existsSync(path.resolve('desktop-tauri/src-tauri/target/release/nsis/x64/utils.nsh'))
    ? 'requires Windows NSIS and generated Tauri NSIS helpers' : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-installer-policy-中文 空格-'));
  try {
    const fixture = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'fixtures/installer-policy.ps1'), '-workspaceRoot', path.resolve(__dirname, '../..'), '-auditRoot', root],
    { encoding: 'utf8', windowsHide: true, timeout: 90_000 });
    assert.ifError(fixture.error);
    assert.equal(fixture.status, 0, fixture.stdout + fixture.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8').replace(/^\uFEFF/, '')).result, 'PASS');
  } finally { remove(root); }
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

test('thin installer retains verified resources and refuses incomplete installations before writes', {
  skip: process.platform !== 'win32' || !fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'tauri/NSIS/makensis.exe')),
}, () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aics-upgrade-fixture-$ '));
  try {
    const fixture = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'fixtures/installer-upgrade.ps1'), '-workspaceRoot', path.resolve(__dirname, '../..'), '-auditRoot', root],
    { encoding:'utf8', windowsHide:true, timeout:120_000 });
    assert.ifError(fixture.error);
    assert.equal(fixture.status, 0, fixture.stdout + fixture.stderr);
    assert.match(fixture.stdout, /PASS: fresh-install refusal/);
  } finally { remove(root); }
});
function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-stage-fixture-'));
  for (const directory of ['server', 'routes', 'services', 'scripts/lib', 'data', 'dist', 'assets', 'tools']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  write(path.join(root, 'server.js'), 'legacy runtime excluded');
  write(path.join(root, 'docs/redirects.json'), '{"/docs/old":"/docs/new"}');
  write(path.join(root, 'scripts/lib/managed-webui.ps1'), '# fixture');
  write(path.join(root, 'scripts/lib/managed-comfyui.ps1'), '# fixture');
  write(path.join(root, 'scripts/lib/managed-voice.ps1'), '# voice manager');
  write(path.join(root, 'scripts/lib/prepare-ai-environment.ps1'), '# environment preparer');
  for (const name of ['prepare-inference.py', 'inspect-anima-checkpoint.py', 'convert-anima-checkpoint.py', 'calibrate-anima-teacache.py', 'import-anima-directory.py']) write(path.join(root, 'scripts/maintenance', name), '# native runtime preparer');
  write(path.join(root, 'scripts/lib/runtime.js'), 'excluded');
  write(path.join(root, 'data/characters.json'), '{}'); write(path.join(root, 'dist/index.html'), '<!doctype html>');
  write(path.join(root, 'data/catalog/manifest.json'), '{"version":1,"files":["character/new.json"],"retired":[]}');
  write(path.join(root, 'data/catalog/character/new.json'), '{"kind":"character","id":"new"}');
  write(path.join(root, 'assets/asset.txt'), 'asset'); write(path.join(root, 'tools/nav.js'), 'browser');
  write(path.join(root, 'tools/voxcpm-server.py'), '# VoxCPM2 server');
  for (const name of ['Install-OfflineResources.cmd', 'offline-resource-assistant.ps1', 'install-offline-resources.ps1']) {
    write(path.join(root, 'tools', name), `offline helper: ${name}`);
  }
  write(path.join(root, 'tools/interrogate/pixai_worker.py'), '# model worker');
  write(path.join(root, 'tools/interrogate/pixai-manifest.json'), '{}');
  write(path.join(root, 'tools/interrogate/test_pixai_worker.py'), '# excluded test');
  for (const name of ['worker.py', 'masked_anima.py','clipseg_mask.py','anima_conversion.py','anima_conversion_profile.py','ANIMA_CONVERSION_LICENSE.txt','teacache_anima.py','teacache_profile.py','teacache_calibration.py','TEACACHE_LICENSE.txt', 'requirements.txt', 'runtime-manifest.json']) write(path.join(root, 'tools/inference', name), 'native inference fixture');
  write(path.join(root, 'tools/inference/test_worker.py'), '# excluded test');
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
  const files = ['libvips-42.dll'].map(name => { write(path.join(root, `fixture-native/${name}`), name); return { name, source: `fixture-native/${name}`, bytes: Buffer.byteLength(name), sha256: sha(name) }; });
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
    write(path.join(stage, 'gateway/native/onnxruntime.dll'), 'retired');
    const result = stageResources({ root, stage, logger: () => {} });
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/huiyu-runtime.exe'), 'utf8'), 'binary');
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/tools/voxcpm-server.py'), 'utf8'), '# VoxCPM2 server');
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/scripts/lib/managed-voice.ps1'), 'utf8'), '# voice manager');
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/scripts/lib/prepare-ai-environment.ps1'), 'utf8'), '# environment preparer');
    for (const name of ['prepare-inference.py', 'inspect-anima-checkpoint.py', 'convert-anima-checkpoint.py', 'calibrate-anima-teacache.py', 'import-anima-directory.py']) assert.equal(fs.readFileSync(path.join(stage, 'gateway/scripts/maintenance', name), 'utf8'), '# native runtime preparer');
    assert.equal(fs.existsSync(path.join(stage,'gateway/scripts/lib/managed-webui.ps1')),false);
    assert.equal(fs.existsSync(path.join(stage, 'gateway/native/libvips-42.dll')), true);
    assert.equal(fs.existsSync(path.join(stage, 'gateway/native/onnxruntime.dll')), false);
    assert.equal(fs.existsSync(path.join(stage, 'gateway/native-licenses/LICENSE')), true);
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/native-licenses/components/fixture/COPYING'), 'utf8'), 'upstream bytes\r\n ');
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/native-licenses/README.md'), 'utf8'), 'fixture notes\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'gateway/rust-runtime-build.json'), 'utf8')).nativeMaterialCount, 4);
    assert.equal(result.releaseReady, false); assert.deepEqual(result.pending, ['fixture notices pending']);
    for (const name of ['server.js', 'server', 'routes', 'services', 'node_modules', 'package.json', 'scripts/lib/runtime.js', 'assets/character-references/private.png', 'assets/live2d-candidates/private.model3.json','data/history.json','data/projects.json','data/prompts.json','data/live2d-candidates.json','data/live2d-candidates.json.br','tools/control-server.js']) assert.equal(fs.existsSync(path.join(stage, 'gateway', name)), false, name);
    assert.equal(fs.existsSync(path.join(stage,'gateway/data/references/fixture.json')),true);
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/data/catalog/character/new.json'), 'utf8'), '{"kind":"character","id":"new"}');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, 'gateway/data/catalog/manifest.json'), 'utf8')).files, ['character/new.json']);
    assert.equal(fs.existsSync(path.join(stage,'gateway/tools/nav.js')),true);
    for (const name of ['Install-OfflineResources.cmd', 'offline-resource-assistant.ps1', 'install-offline-resources.ps1']) {
      assert.equal(fs.readFileSync(path.join(stage, 'gateway/tools', name), 'utf8'), `offline helper: ${name}`);
    }
    const assistant = path.join(root, 'tools/offline-resource-assistant.ps1');
    fs.unlinkSync(assistant);
    assert.throws(() => stageResources({ root, stage, logger: () => {} }), /offline resource assistant|ENOENT/);
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/tools/offline-resource-assistant.ps1'), 'utf8'), 'offline helper: offline-resource-assistant.ps1', 'failed staging must preserve the previous complete helper');
    write(assistant, '');
    assert.throws(() => stageResources({ root, stage, logger: () => {} }), /offline resource assistant/);
    assert.equal(fs.readFileSync(path.join(stage, 'gateway/huiyu-runtime.exe'), 'utf8'), 'binary');
    write(assistant, 'offline helper: offline-resource-assistant.ps1');
    assert.equal(fs.readFileSync(path.join(stage,'gateway/tools/interrogate/pixai_worker.py'),'utf8'),'# model worker');
    assert.equal(fs.existsSync(path.join(stage,'gateway/tools/interrogate/pixai-manifest.json')),true);
    assert.equal(fs.existsSync(path.join(stage,'gateway/tools/interrogate/test_pixai_worker.py')),false);
    for (const name of ['worker.py', 'masked_anima.py','clipseg_mask.py','anima_conversion.py','anima_conversion_profile.py','ANIMA_CONVERSION_LICENSE.txt','teacache_anima.py','teacache_profile.py','teacache_calibration.py','TEACACHE_LICENSE.txt', 'requirements.txt', 'runtime-manifest.json']) assert.equal(fs.readFileSync(path.join(stage, 'gateway/tools/inference', name), 'utf8'), 'native inference fixture');
    assert.equal(fs.existsSync(path.join(stage, 'gateway/tools/inference/test_worker.py')), false);
    assert.equal(fs.existsSync(path.join(stage, 'stale.txt')), false);
    const { assertNativeReleaseIntegrity }: typeof import('../maintenance/desktop-rust-inputs') = require('../maintenance/desktop-rust-inputs');
    assert.doesNotThrow(() => assertNativeReleaseIntegrity(path.join(stage,'gateway')));
    const manifestPath = path.join(root,'runtime-rs/native-dependencies.windows-x64.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    manifest.status = 'redistribution-verified'; manifest.redistribution.pending = [];
    Object.assign(manifest.licenseEvidence, { publicRedistributionApproved:true, completeLinkedLicenseClosure:true });
    write(manifestPath,JSON.stringify(manifest));
    assert.equal(stageResources({root,stage,logger:()=>{}}).releaseReady,true);
    assert.doesNotThrow(() => assertNativeReleaseIntegrity(path.join(stage,'gateway')));
  } finally { remove(root); }
});
test('stale Rust source or tampered DLL leaves previous complete stage untouched', () => {
  const root = createFixture(), stage = path.join(root, 'resources');
  try {
    write(path.join(stage, 'old/marker.txt'), 'old');
    write(path.join(root, 'fixture-native/libvips-42.dll'), 'tampered');
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
  try{const supplied={AICS_VIPS_DYLIB_PATH:'explicit-vips.dll'};const env=developmentNativeEnvironment(root,supplied);
    assert.equal(env.AICS_VIPS_DYLIB_PATH,'explicit-vips.dll');assert.deepEqual(supplied,{AICS_VIPS_DYLIB_PATH:'explicit-vips.dll'});
    assert.equal(developmentNativeEnvironment(root,{}).AICS_VIPS_DYLIB_PATH,path.join(root,'fixture-native/libvips-42.dll'));
    write(path.join(root,'fixture-native/libvips-42.dll'),'tampered');assert.throws(()=>developmentNativeEnvironment(root,{}),/bytes mismatch/);
  }finally{remove(root);}
});
test('non-Windows development does not read the Windows native manifest',{skip:process.platform==='win32'},()=>{
  const {developmentNativeEnvironment}:typeof import('../maintenance/desktop-rust-inputs')=require('../maintenance/desktop-rust-inputs');
  const supplied:NodeJS.ProcessEnv={AICS_VIPS_DYLIB_PATH:'/explicit/libvips.so',PATH:'/fixture/bin'};
  const result=developmentNativeEnvironment('/missing-fixture-root',supplied);
  assert.deepEqual(result,supplied);assert.notEqual(result,supplied);
});
test('Windows launcher opens only on Rust readiness and preserves startup failures', { skip:process.platform!=='win32' }, () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aics-launcher-fixture-'));
  const driver=path.join(root,'probe.ps1'), eventsFile=path.join(root,'events.txt');
  try {
    fs.copyFileSync(path.resolve(__dirname,'../../start.ps1'),path.join(root,'start.ps1'));
    write(path.join(root,'node_modules/fixture'),'isolated');write(path.join(root,'dist/index.html'),'fixture');
    write(path.join(root,'native-stderr.cjs'), "process.stderr.write('   Compiling isolated-fixture v0.0.0\\nisolated runtime diagnostic\\n');\n");
    write(driver,String.raw`param($Scenario,$Origin)
$global:opened=0
$nativeNode=(Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$env:PORT='43111'
function Trace($event) { Add-Content -LiteralPath (Join-Path $PSScriptRoot 'events.txt') -Value $event -Encoding UTF8 }
function npm {
  if (($args -join ' ') -ne 'run build:runtime') { throw 'Unexpected npm invocation' }
  Trace 'build-runtime'
  Write-Output 'npm fixture detail'
  if($Scenario -eq 'build-failed'){Write-Output 'isolated preparation diagnostic'}
  $global:LASTEXITCODE=if($Scenario -eq 'build-failed'){17}else{0}
}
function Get-NetTCPConnection {
  param($LocalPort,$State)
  Trace "port:$LocalPort"
  if($Scenario -eq 'occupied'){[pscustomobject]@{OwningProcess=123}}
}
function Start-Process {
  [CmdletBinding()]param($FilePath)
  $global:opened++
  Trace "open:$FilePath"
}
function cmd { throw 'Unexpected command-shell invocation' }
function Stop-Process { throw 'Unexpected process termination' }
function Read-Host { param($Prompt) Trace "prompt:$Prompt" }
function node {
  if($args[0] -eq '--version'){'v22.18.0';return}
  if($args[0] -eq 'scripts/maintenance/git-bundle-backup.js'){
    Trace 'backup';Write-Output 'backup fixture detail'
    $global:LASTEXITCODE=if($Scenario -eq 'ready-backup-failed'){42}else{0};return
  }
  if(($args -join ' ') -ne 'scripts/maintenance/run-rust-runtime.js start'){throw 'Unexpected node invocation'}
  Trace 'runtime'
  Write-Output 'Compiling isolated Rust fixture'
  & $nativeNode (Join-Path $PSScriptRoot 'native-stderr.cjs')
  Write-Output '{ invalid json'
  Write-Output '{"event":"ready","runtime":"node","origin":"http://127.0.0.1:43210"}'
  Write-Output '{"event":"ready","runtime":"rust","origin":"https://example.test:43210"}'
  if($global:opened -ne 0){throw 'Browser opened before Rust readiness'}
  Trace 'before-ready'
  if($Scenario.StartsWith('ready')){
    Write-Output ('{"event":"ready","runtime":"rust","origin":"'+$Origin+'"}')
    if($global:opened -ne 1){throw 'Browser did not open while ready output was processed'}
    Trace 'after-ready'
    Write-Output ('{"event":"ready","runtime":"rust","origin":"'+$Origin+'"}')
  }
  $global:LASTEXITCODE=23
}
. (Join-Path $PSScriptRoot 'start.ps1')
exit $LASTEXITCODE
`);
    for(const [scenario,origin,control,status] of [
      ['ready4','http://127.0.0.1:43210','http://127.0.0.1:43210/control',23],
      ['ready6','http://[::]:43212','http://[::1]:43212/control',23],
      ['ready-backup-failed','http://127.0.0.1:43210','http://127.0.0.1:43210/control',23],
      ['failed','','',23],['build-failed','','',1],['occupied','','',1],
    ] as const){
      fs.rmSync(eventsFile,{force:true});
      const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',driver,scenario,origin],
        {encoding:'utf8',windowsHide:true,timeout:15000});
      assert.ifError(result.error);assert.equal(result.status,status,result.stdout+result.stderr);
      const events=fs.readFileSync(eventsFile,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/);
      assert.deepEqual(events.filter(event=>event.startsWith('open:')),control?[`open:${control}`]:[],scenario);
      assert.equal(events.filter(event=>event.startsWith('prompt:')).length,1,scenario);
      if(control){
        assert.ok(events.indexOf('before-ready')<events.indexOf(`open:${control}`));
        assert.ok(events.indexOf(`open:${control}`)<events.indexOf('after-ready'));
      }
      const logName=fs.readdirSync(path.join(root,'runtime/logs')).find(file=>file.startsWith('startup-')&&file.endsWith(`-${result.pid}.log`));
      assert.ok(logName,'the launcher must keep a per-process startup log');
      const log=fs.readFileSync(path.join(root,'runtime/logs',logName),'utf8');
      assert.match(log,/npm fixture detail/);
      assert.doesNotMatch(result.stdout,/"event":"ready"|backup fixture detail|Compiling isolated Rust fixture/);
      assert.doesNotMatch(result.stdout,/Compiling isolated-fixture v0\.0\.0/);
      if(scenario!=='build-failed')assert.doesNotMatch(result.stdout,/npm fixture detail/);
      if(control)assert.equal(result.stdout.split(`Control panel ready: ${control}`).length-1,1,scenario);
      if(scenario==='ready-backup-failed')assert.match(result.stdout,/backup was not completed/);
      if(status===23){
        assert.match(log,/Compiling isolated Rust fixture/);assert.match(log,/Compiling isolated-fixture v0\.0\.0/);assert.match(log,/backup fixture detail/);
        assert.match(result.stdout,/isolated runtime diagnostic/);assert.match(result.stdout,/Server exited with code 23/);
      }
      else {
        assert.equal(events.includes('runtime'),false,scenario);
        assert.match(result.stdout,scenario==='occupied'?/Port 43111 is occupied/:/Development command build failed/);
        if(scenario==='build-failed')assert.match(result.stdout,/isolated preparation diagnostic/);
      }
      if(scenario!=='build-failed')assert.ok(events.includes('port:43111'));
    }
  } finally { remove(root); }
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
    runCommand: (command: any, args: any, options: any) => {
      if (args[0] === '-e') {
        assert.equal(options.env.AICS_DATA_ROOT, 'fixture-root');
        assert.equal(options.env.AICS_APP_ROOT, 'fixture-root');
        events.push('refresh-data');
        return 0;
      }
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
    'refresh-data',
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
  const { hashInstallerFile, verifyUpdaterSignature }: typeof import('../maintenance/build-modern-installer') = require('../maintenance/build-modern-installer');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-updater-signature-'));
  try {
    const file = path.join(root, 'fixture.exe');
    const content = Buffer.alloc(128 * 1024 + 17, 0x5a);
    fs.writeFileSync(file, content);
    assert.equal(hashInstallerFile(file, 'sha256').toString('hex'), crypto.createHash('sha256').update(content).digest('hex'));
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const id = Buffer.from('12345678');
    const key = Buffer.concat([Buffer.from('Ed'), id, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]);
    for (const algorithm of ['ED', 'Ed']) {
      const raw = crypto.sign(null, algorithm === 'ED' ? crypto.createHash('blake2b512').update(content).digest() : content, privateKey);
      const packet = Buffer.concat([Buffer.from(algorithm), id, raw]);
      const comment = 'timestamp:1';
      const global = crypto.sign(null, Buffer.concat([raw, Buffer.from(comment)]), privateKey);
      const signature = Buffer.from(['untrusted comment: fixture', packet.toString('base64'), 'trusted comment: ' + comment, global.toString('base64')].join('\n')).toString('base64');
      const pub = Buffer.from('untrusted comment: fixture\n' + key.toString('base64')).toString('base64');
      assert.equal(verifyUpdaterSignature(file, signature, pub), true);
      fs.appendFileSync(file, 'tampered');
      assert.throws(() => verifyUpdaterSignature(file, signature, pub), /signature verification failed/);
      fs.writeFileSync(file, content);
    }
  } finally { remove(root); }
});
