'use strict';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const {
  RELEASE_REPOSITORY,
  createManifest,
  releaseTag,
  publishRelease,
  MANUAL_MARKER,
}: typeof import('../maintenance/release-desktop-update') = require('../maintenance/release-desktop-update');

const ROOT = path.resolve(__dirname, '..', '..');

function buildBindingFixture() {
  const binding: typeof import('../lib/desktop-build-binding') = require('../lib/desktop-build-binding');
  const { execFileSync }: typeof import('node:child_process') = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-binding-'));
  const put = (name: string, value: string) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, value); };
  const git = (...args: string[]) => execFileSync('git', args, { cwd:root, stdio:'pipe', windowsHide:true });
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  put('.gitignore', 'runtime/\ndist/\ndesktop-tauri/\n'); put('package.json', '{"version":"1.0.0"}'); put('source.ts', 'A');
  git('add', '.gitignore', 'package.json', 'source.ts'); git('commit', '-m', 'A');
  put('dist/index.html', 'frontend-A'); put('desktop-tauri/src-tauri/resources/node.exe', 'node-A');
  const native = 'desktop-tauri/src-tauri/target/release/ai-cg-studio-desktop.exe'; put(native, 'native-A');
  const payload = 'desktop-tauri/src-tauri/target/release/bundle/nsis/fixture.exe'; put(payload, 'payload-A');
  return { root, put, git, binding, native, payload, remove() {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('desktop-binding-'));
    fs.rmSync(root, { recursive:true, force:true });
  } };
}

test('desktop build binding rejects same-version stale sources, tampering and missing receipts before side effects', () => {
  const fixture = buildBindingFixture();
  const { root, put, git, binding, payload } = fixture;
  let sideEffects = 0;
  try {
    const source = binding.sourceIdentity(root);
    binding.recordBuild(root, source);
    binding.verifyBuild(root, path.join(root, payload));
    put('docs/note.md', 'documentation only');
    binding.verifyBuild(root);
    put('source.ts', 'B'); git('add', 'source.ts'); git('commit', '-m', 'B');
    assert.throws(() => { binding.verifyBuild(root); sideEffects++; }, /源码与构建不匹配/);
    assert.equal(sideEffects, 0);
    const vm: typeof import('node:vm') = require('node:vm');
    const { createRequire }: typeof import('node:module') = require('node:module');
    const entry = path.join(ROOT, 'scripts/maintenance/release-desktop-update.js');
    const originalRequire = createRequire(entry);
    const guardedRequire = (name: string) => name === './build-modern-installer'
      ? { buildModernInstaller: () => { sideEffects++; throw Error('unexpected-wrapper'); } }
      : originalRequire(name);
    const sourceCode = fs.readFileSync(entry, 'utf8').replace(/^const ROOT =.*$/m, 'const ROOT = ' + JSON.stringify(root) + ';');
    assert.throws(() => vm.runInNewContext(sourceCode + '\nmain();', {
      require:guardedRequire, module:{ exports:{} }, exports:{}, __dirname:path.dirname(entry),
      process:{ ...process, argv:['node', 'fixture', '--skip-build', '--manual', '--publish'] }, console,
    }), /源码与构建不匹配/);
    assert.equal(sideEffects, 0, 'actual skip-build publish entry rejects before wrapper/sign/upload');
    put('source.ts', 'A');
    binding.verifyBuild(root); // Identical content may be committed after the build.
    put(payload, 'tampered');
    assert.throws(() => binding.verifyBuild(root), /改写/);
    put(payload, 'payload-A');
    fs.unlinkSync(path.join(root, 'desktop-tauri/src-tauri/resources/node.exe'));
    assert.throws(() => binding.verifyBuild(root), /缺失|改写/);
    fs.unlinkSync(path.join(root, binding.receiptPath));
    assert.throws(() => binding.verifyBuild(root), /缺少/);
    put(binding.receiptPath, '{}');
    assert.throws(() => binding.verifyBuild(root), /格式/);
  } finally { fixture.remove(); }
});

test('official Tauri entry detaches only the Cargo release executable before binding', async () => {
  const fixture = buildBindingFixture();
  const { root, binding, native, payload } = fixture;
  const { runTauri }: typeof import('../maintenance/run-tauri') = require('../maintenance/run-tauri');
  const target = path.join(root, native), cache = path.join(root, 'desktop-tauri/src-tauri/target/release/deps/native.exe');
  try {
    const result = await runTauri(['build', '--ci', '--no-sign'], {
      root, env:{}, npmCommand:'fixture-npm', tauriCli:'fixture-tauri',
      checkEnvironment:() => ({ ready:true, checks:[], sdkRoot:root }), runCommand:() => 0,
      prepareTauri:async () => ({ stage:root, runtimeJavaScriptFiles:[], webDir:root, sidecarPath:'fixture-node' }),
      spawnTauri:() => {
        fs.mkdirSync(path.dirname(cache), { recursive:true }); fs.renameSync(target, cache); fs.linkSync(cache, target);
        assert.equal(fs.statSync(target).nlink, 2);
        return 0;
      },
    });
    assert.equal(result, 0);
    assert.equal(fs.statSync(target).nlink, 1);
    assert.equal(fs.statSync(cache).nlink, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), 'native-A');
    binding.verifyBuild(root, path.join(root, payload));
    fs.writeFileSync(cache, 'next Cargo image');
    assert.equal(fs.readFileSync(target, 'utf8'), 'native-A', 'later Cargo cache writes cannot alter the bound image');
    binding.verifyBuild(root);
    const source = binding.sourceIdentity(root), previous = fs.readFileSync(path.join(root, binding.receiptPath));
    const resource = path.join(root, 'desktop-tauri/src-tauri/resources/node.exe');
    fs.linkSync(resource, path.join(root, 'runtime/resource-alias.exe'));
    assert.throws(() => binding.recordBuild(root, source), /桌面产物不完整.*resources\/node.exe.*硬链接/);
    assert.equal(fs.statSync(resource).nlink, 2, 'unrelated output hardlinks remain rejected, never materialized');
    assert.deepEqual(fs.readFileSync(path.join(root, binding.receiptPath)), previous);
    fs.linkSync(path.join(root, 'source.ts'), path.join(root, 'runtime/source-alias'));
    assert.throws(() => binding.sourceIdentity(root), /发行源码身份不完整.*source.ts.*硬链接/);
  } finally { fixture.remove(); }
});

test('a corrupted native copy preserves the shared EXE and prior receipt and fails the official entry', async (t) => {
  const fixture = buildBindingFixture();
  const { root, binding, native } = fixture;
  const { runTauri }: typeof import('../maintenance/run-tauri') = require('../maintenance/run-tauri');
  const target = path.join(root, native), cache = path.join(root, 'runtime/cargo-image.exe');
  try {
    binding.recordBuild(root, binding.sourceIdentity(root));
    const previous = fs.readFileSync(path.join(root, binding.receiptPath));
    fs.linkSync(target, cache);
    const copy = fs.copyFileSync;
    t.mock.method(fs, 'copyFileSync', (...[from, to, flags]: Parameters<typeof fs.copyFileSync>) => {
      copy(from, to, flags);
      if (String(from) === target) fs.writeFileSync(to, 'corrupt-copy');
    });
    await assert.rejects(runTauri(['build'], { root, env:{}, npmCommand:'fixture-npm', tauriCli:'fixture-tauri',
      checkEnvironment:() => ({ ready:true, checks:[], sdkRoot:root }), runCommand:() => 0,
      prepareTauri:async () => ({ stage:root, runtimeJavaScriptFiles:[], webDir:root, sidecarPath:'fixture-node' }), spawnTauri:() => 0,
    }), /CLI 已成功.*回执校验失败.*独立副本字节校验失败/);
    assert.equal(fs.statSync(target).nlink, 2);
    assert.equal(fs.readFileSync(target, 'utf8'), 'native-A');
    assert.equal(fs.readFileSync(cache, 'utf8'), 'native-A');
    assert.deepEqual(fs.readFileSync(path.join(root, binding.receiptPath)), previous);
    assert.equal(fs.readdirSync(path.dirname(target)).some(name => name.includes('.detach-')), false);
  } finally { fixture.remove(); }
});

test('bundle and distribution binding failures preserve the last atomic receipt', (t) => {
  const fixture = buildBindingFixture();
  const { root, put, binding, native, payload } = fixture;
  const receipt = path.join(root, binding.receiptPath), output = path.join(root, 'runtime/setup.exe');
  try {
    binding.recordBuild(root, binding.sourceIdentity(root), false);
    const base = binding.verifyBuild(root);
    binding.extendBuild(root, base);
    binding.verifyBuild(root, path.join(root, payload));
    const bundled = fs.readFileSync(receipt);
    put(native, 'changed-native');
    assert.throws(() => binding.extendBuild(root, base), /打包修改了原构建产物/);
    assert.deepEqual(fs.readFileSync(receipt), bundled);
    put(native, 'native-A');
    assert.throws(() => binding.verifyDistribution(root, output), /发行封装绑定回执/);
    put('runtime/setup.exe', 'wrapper-A');
    const rename = fs.renameSync;
    const failure = t.mock.method(fs, 'renameSync', (...[from, to]: Parameters<typeof fs.renameSync>) => {
      if (String(to) === receipt) throw Error('fixture receipt rename denied');
      return rename(from, to);
    });
    assert.throws(() => binding.bindDistribution(root, path.join(root, payload), output), /封装绑定回执写入失败.*原回执保留.*rename denied/);
    assert.deepEqual(fs.readFileSync(receipt), bundled);
    assert.equal(fs.readdirSync(path.dirname(receipt)).some(name => name.endsWith('.tmp')), false);
    failure.mock.restore();
    binding.bindDistribution(root, path.join(root, payload), output);
    binding.verifyDistribution(root, output);
    put('runtime/setup.exe', 'tampered-wrapper');
    assert.throws(() => binding.verifyDistribution(root, output), /封装产物已变化.*拒绝签名或上传/);
  } finally { fixture.remove(); }
});

test('桌面更新端点固定使用主项目 GitHub Releases', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop-tauri/src-tauri/tauri.conf.json'), 'utf8'));
  assert.deepEqual(config.plugins.updater.endpoints, [
    `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/latest.json`,
  ]);
  assert.equal(config.plugins.updater.dangerousInsecureTransportProtocol, undefined);
});

test('发布清单指向同版本公开 Release 安装包', () => {
  const manifest = createManifest('1.5.9', 'signed', 'AI-CG-Studio_1.5.9_x64-setup.exe', new Date('2026-09-08T10:00:00Z'));
  assert.equal(releaseTag(manifest.version), 'v1.5.9');
  assert.equal(manifest.pub_date, '2026-09-08T10:00:00.000Z');
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'signed');
  assert.equal(
    manifest.platforms['windows-x86_64'].url,
    'https://github.com/starplatium1129-stack/huiyu/releases/download/v1.5.9/AI-CG-Studio_1.5.9_x64-setup.exe',
  );
});

function releaseFixture(callback: any) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-release-test-'));
  try {
    const notes = path.join(directory, 'notes.md');
    fs.writeFileSync(notes, '# Release notes\nVerified changes.\n');
    const files = ['setup.exe', 'setup.exe.sha256'].map(name => {
      const file = path.join(directory, name); fs.writeFileSync(file, 'fixture'); return file;
    });
    callback({ directory, notes, files });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('手动版先上传草稿并验证资产，再公开但不晋升自动更新 latest', () => releaseFixture(({ directory, notes, files }: any) => {
  const calls: any = [];
  const run = (_command: any, args: any) => {
    calls.push(args);
    if (args[0] === 'release' && args[1] === 'view' && args.includes('isDraft,body,targetCommitish')) {
      const error: any = new Error('release not found'); error.stderr = 'release not found'; throw error;
    }
    if (args.includes('assets')) return JSON.stringify({ assets: files.map((file: any) => ({ name: path.basename(file), size: fs.statSync(file).size })) });
    return '';
  };
  publishRelease('1.6.0', 'source-head', files, { manual: true, notesFile: notes, outputDir: directory, run });
  const create = calls.find((args: any) => args[1] === 'create');
  const publish = calls.find((args: any) => args[1] === 'edit');
  assert(create.includes('--draft'));
  assert(create.includes('--notes-file'));
  assert(publish.includes('--latest=false'));
  assert(publish.includes('--draft=false'));
  assert(fs.readFileSync(path.join(directory, 'release-notes-v1.6.0.md'), 'utf8').includes(MANUAL_MARKER));
  assert(!create.some((value: any) => value.endsWith('latest.json') || value.endsWith('.sig')));
}));

test('资产未上传完整时保留草稿，不公开半成品', () => releaseFixture(({ directory, notes, files }: any) => {
  const calls: any = [];
  const run = (_command: any, args: any) => {
    calls.push(args);
    if (args.includes('isDraft,body,targetCommitish')) return JSON.stringify({ isDraft: true, targetCommitish: 'source-head', body: '' });
    if (args.includes('assets')) return JSON.stringify({ assets: [] });
    return '';
  };
  assert.throws(() => publishRelease('1.6.0', 'source-head', files, { manual: true, notesFile: notes, outputDir: directory, run }), /上传不完整/);
  assert(!calls.some((args: any) => args[1] === 'edit'));
}));

test('手动发布不能携带自动更新清单，也不能覆盖已公开的普通版本', () => releaseFixture(({ directory, notes, files }: any) => {
  assert.throws(() => publishRelease('1.6.0', 'source-head', [...files, 'latest.json'], { manual: true }), /不能发布自动更新/);
  const run = () => JSON.stringify({ isDraft: false, body: '# Signed release', targetCommitish: 'source-head' });
  assert.throws(() => publishRelease('1.6.0', 'source-head', files, { manual: true, notesFile: notes, outputDir: directory, run }), /已公开发布/);
}));

test('GitHub 返回的资产摘要不匹配时不得公开', () => releaseFixture(({ directory, notes, files }: any) => {
  const calls: any = [];
  const run = (_command: any, args: any) => {
    calls.push(args);
    if (args.includes('isDraft,body,targetCommitish')) return JSON.stringify({ isDraft: true, targetCommitish: 'source-head', body: '' });
    if (args.includes('assets')) return JSON.stringify({ assets: files.map((file: any) => ({ name: path.basename(file), size: fs.statSync(file).size, digest: 'sha256:wrong' })) });
    return '';
  };
  assert.throws(() => publishRelease('1.6.0', 'source-head', files, { manual: true, notesFile: notes, outputDir: directory, run }), /校验失败/);
  assert(!calls.some((args: any) => args[1] === 'edit'));
}));

test('补签必须显式声明且匹配原标签，然后才晋升 latest', () => releaseFixture(({ directory, notes, files }: any) => {
  const signedFiles = [...files, ...['latest.json', 'setup.exe.sig'].map(name => { const file = path.join(directory, name); fs.writeFileSync(file, 'fixture'); return file; })];
  const calls: any = [];
  const run = (command: any, args: any) => {
    calls.push(args);
    if (command === 'git') return 'source-head\n';
    if (args.includes('isDraft,body,targetCommitish')) return JSON.stringify({ isDraft: false, body: MANUAL_MARKER, targetCommitish: 'source-head' });
    if (args.includes('assets')) return JSON.stringify({ assets: signedFiles.map(file => ({ name: path.basename(file), size: fs.statSync(file).size })) });
    return '';
  };
  publishRelease('1.6.0', 'source-head', signedFiles, { manual: false, completeManual: true, notesFile: notes, outputDir: directory, run });
  assert(calls.find((args: any) => args[1] === 'edit').includes('--latest=true'));
  assert(!fs.readFileSync(path.join(directory, 'release-notes-v1.6.0.md'), 'utf8').includes(MANUAL_MARKER));
}));

test('仓库品牌更新仍保留原客户端安装身份', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop-tauri/src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(config.identifier, 'com.aics.studio');
  assert.equal(config.productName, 'AI-CG-Studio');
  assert.equal(RELEASE_REPOSITORY, 'starplatium1129-stack/huiyu');
});

test('发行版本在 npm、Tauri 与 Rust 元数据中一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop-tauri/src-tauri/tauri.conf.json'), 'utf8'));
  const cargo = fs.readFileSync(path.join(ROOT, 'desktop-tauri/src-tauri/Cargo.toml'), 'utf8');
  const cargoLock = fs.readFileSync(path.join(ROOT, 'desktop-tauri/src-tauri/Cargo.lock'), 'utf8');
  assert.equal(config.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(/\[package\][\s\S]*?\nversion = "([^"]+)"/.exec(cargo)![1], pkg.version);
  assert.equal(/name = "ai-cg-studio-desktop"\r?\nversion = "([^"]+)"/.exec(cargoLock)![1], pkg.version);
});
