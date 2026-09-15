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
const { runTauri }: typeof import('../maintenance/run-tauri') = require('../maintenance/run-tauri');
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
  const source = fs.readFileSync(path.join(__dirname, '../../desktop-tauri/src-tauri/installer/vendor/tauri-2.11.4.nsi'), 'utf8');
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

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-stage-fixture-'));
  const dirs = ['server', 'routes', 'scripts/lib', 'data', 'dist', 'assets', 'tools'];
  dirs.forEach((directory) => fs.mkdirSync(path.join(root, directory), { recursive: true }));
  write(path.join(root, 'server.js'), 'module.exports = {}\n');
  write(path.join(root, 'docs', 'redirects.json'), '{"/docs/old":"/docs/new"}\n');
  write(path.join(root, 'server', 'config.js'), 'module.exports = {}\n');
  write(path.join(root, 'routes', 'health.js'), 'module.exports = {}\n');
  write(path.join(root, 'scripts/lib', 'runtime.js'), 'runtime\n');
  write(path.join(root, 'data', 'data.json'), '{}\n');
  write(path.join(root, 'dist', 'index.html'), '<!doctype html>\n');
  write(path.join(root, 'assets', 'asset.txt'), 'asset\n');
  write(path.join(root, 'tools', 'tool.txt'), 'tool\n');
  write(path.join(root, 'services', 'fixture.ts'), 'export const fixture = 1;\n');
  write(path.join(root, 'services', 'fixture.js'), '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.fixture = void 0;\nexports.fixture = 1;\n');
  write(path.join(root, 'services', 'fixture.d.ts'), 'export declare const fixture = 1;\n');
  write(path.join(root, 'services', 'orphan.js'), 'orphan\n');
  write(path.join(root, 'tsconfig.runtime.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'CommonJS', declaration: true, rootDir: 'services', outDir: 'services' },
    include: ['services/**/*.ts'],
    exclude: ['services/**/*.js', 'services/**/*.d.ts'],
  }, null, 2) + '\n');
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }) + '\n');
  write(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'fixture', version: '1.0.0' },
      'node_modules/compression': { version: '1.0.0' },
      'node_modules/express': { version: '1.0.0' },
      'node_modules/http-proxy-middleware': { version: '1.0.0' },
      'node_modules/onnxruntime-node': { version: '1.0.0' },
      'node_modules/sharp': { version: '1.0.0' },
      // 2026-09-06 补入 RUNTIME_DEPENDENCIES（ComfyUI 进度 WebSocket 客户端），
      // fixture 须与清单同步，否则闭包派生会因缺包抛错。
      'node_modules/ws': { version: '1.0.0' },
    },
  }, null, 2) + '\n');
  return root;
}

function remove(root: any) {
  fs.rmSync(root, { recursive: true, force: true });
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

test('production stage uses exact runtime outputs and atomic replacement', () => {
  const root = createFixture();
  const stage = path.join(root, 'desktop-tauri', 'src-tauri', 'resources');
  try {
    fs.mkdirSync(stage, { recursive: true });
    write(path.join(stage, 'stale.txt'), 'stale\n');
    let installCalls = 0;
    const result = stageResources({
      root,
      stage,
      logger: () => {},
      installDependencies: (gatewayDir) => {
        installCalls += 1;
        write(path.join(gatewayDir, 'node_modules', '.installed'), 'yes\n');
      },
    });

    assert.equal(installCalls, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, 'gateway/docs/redirects.json'))), { '/docs/old': '/docs/new' });
    assert.deepEqual(result.runtimeJavaScriptFiles, ['fixture.js']);
    assert.equal(fs.existsSync(path.join(stage, 'gateway', 'services', 'fixture.js')), true);
    assert.equal(fs.existsSync(path.join(stage, 'gateway', 'services', 'fixture.ts')), false);
    assert.equal(fs.existsSync(path.join(stage, 'gateway', 'services', 'fixture.d.ts')), false);
    assert.equal(fs.existsSync(path.join(stage, 'gateway', 'services', 'orphan.js')), false);
    assert.equal(fs.existsSync(path.join(stage, 'stale.txt')), false);

    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'gateway', 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
      'compression', 'express', 'http-proxy-middleware', 'onnxruntime-node', 'sharp', 'ws',
    ]);
  } finally {
    remove(root);
  }
});

test('failed npm ci leaves the previous complete stage untouched', () => {
  const root = createFixture();
  const stage = path.join(root, 'resources');
  try {
    write(path.join(stage, 'old', 'marker.txt'), 'old\n');
    assert.throws(() => stageResources({
      root,
      stage,
      logger: () => {},
      installDependencies: () => { throw new Error('npm ci failed'); },
    }), /npm ci failed/);
    assert.equal(fs.readFileSync(path.join(stage, 'old', 'marker.txt'), 'utf8'), 'old\n');
    assert.equal(fs.existsSync(path.join(stage, 'gateway')), false);
  } finally {
    remove(root);
  }
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
    npmCommand: 'npm',
    checkEnvironment: () => { events.push('environment'); },
    withLock: async (options, callback) => {
      events.push('lock');
      const result = await callback();
      events.push('unlock');
      return result;
    },
    runCommand: (command, args) => {
      events.push(`${command}:${args.join(' ')}`);
      return 0;
    },
    prepareTauri: async () => { events.push('prepare'); },
    tauriCli: 'tauri-cli.js',
    spawnTauri: (command, args) => {
      events.push(`${command}:${args.join(' ')}`);
      return 0;
    },
  });
  assert.deepEqual(events, [
    'lock',
    'environment',
    'npm:run build',
    'npm:run test:services-generated',
    'prepare',
    `${process.execPath}:tauri-cli.js build --no-bundle`,
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
