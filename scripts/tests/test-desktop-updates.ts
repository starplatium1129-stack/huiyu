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

test('自动检查只提示，安装必须由用户点击触发', () => {
  const banner = fs.readFileSync(path.join(ROOT, 'src/components/DesktopUpdateBanner.vue'), 'utf8');
  const updater = fs.readFileSync(path.join(ROOT, 'src/composables/useDesktopUpdater.ts'), 'utf8');
  assert.match(banner, /@click="installUpdate\(\)"/);
  assert.doesNotMatch(banner, /onMounted\([^\n]*installUpdate/);
  assert.match(updater, /async function install\(\)/);
});

function releaseFixture(callback) {
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

test('手动版先上传草稿并验证资产，再公开但不晋升自动更新 latest', () => releaseFixture(({ directory, notes, files }) => {
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    if (args[0] === 'release' && args[1] === 'view' && args.includes('isDraft,body,targetCommitish')) {
      const error = new Error('release not found'); error.stderr = 'release not found'; throw error;
    }
    if (args.includes('assets')) return JSON.stringify({ assets: files.map(file => ({ name: path.basename(file), size: fs.statSync(file).size })) });
    return '';
  };
  publishRelease('1.6.0', 'source-head', files, { manual: true, notesFile: notes, outputDir: directory, run });
  const create = calls.find(args => args[1] === 'create');
  const publish = calls.find(args => args[1] === 'edit');
  assert(create.includes('--draft'));
  assert(create.includes('--notes-file'));
  assert(publish.includes('--latest=false'));
  assert(publish.includes('--draft=false'));
  assert(fs.readFileSync(path.join(directory, 'release-notes-v1.6.0.md'), 'utf8').includes(MANUAL_MARKER));
  assert(!create.some(value => value.endsWith('latest.json') || value.endsWith('.sig')));
}));

test('资产未上传完整时保留草稿，不公开半成品', () => releaseFixture(({ directory, notes, files }) => {
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    if (args.includes('isDraft,body,targetCommitish')) return JSON.stringify({ isDraft: true, targetCommitish: 'source-head', body: '' });
    if (args.includes('assets')) return JSON.stringify({ assets: [] });
    return '';
  };
  assert.throws(() => publishRelease('1.6.0', 'source-head', files, { manual: true, notesFile: notes, outputDir: directory, run }), /上传不完整/);
  assert(!calls.some(args => args[1] === 'edit'));
}));

test('手动发布不能携带自动更新清单，也不能覆盖已公开的普通版本', () => releaseFixture(({ directory, notes, files }) => {
  assert.throws(() => publishRelease('1.6.0', 'source-head', [...files, 'latest.json'], { manual: true }), /不能发布自动更新/);
  const run = () => JSON.stringify({ isDraft: false, body: '# Signed release', targetCommitish: 'source-head' });
  assert.throws(() => publishRelease('1.6.0', 'source-head', files, { manual: true, notesFile: notes, outputDir: directory, run }), /已公开发布/);
}));

test('GitHub 返回的资产摘要不匹配时不得公开', () => releaseFixture(({ directory, notes, files }) => {
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    if (args.includes('isDraft,body,targetCommitish')) return JSON.stringify({ isDraft: true, targetCommitish: 'source-head', body: '' });
    if (args.includes('assets')) return JSON.stringify({ assets: files.map(file => ({ name: path.basename(file), size: fs.statSync(file).size, digest: 'sha256:wrong' })) });
    return '';
  };
  assert.throws(() => publishRelease('1.6.0', 'source-head', files, { manual: true, notesFile: notes, outputDir: directory, run }), /校验失败/);
  assert(!calls.some(args => args[1] === 'edit'));
}));

test('补签必须显式声明且匹配原标签，然后才晋升 latest', () => releaseFixture(({ directory, notes, files }) => {
  const signedFiles = [...files, ...['latest.json', 'setup.exe.sig'].map(name => { const file = path.join(directory, name); fs.writeFileSync(file, 'fixture'); return file; })];
  const calls = [];
  const run = (command, args) => {
    calls.push(args);
    if (command === 'git') return 'source-head\n';
    if (args.includes('isDraft,body,targetCommitish')) return JSON.stringify({ isDraft: false, body: MANUAL_MARKER, targetCommitish: 'source-head' });
    if (args.includes('assets')) return JSON.stringify({ assets: signedFiles.map(file => ({ name: path.basename(file), size: fs.statSync(file).size })) });
    return '';
  };
  publishRelease('1.6.0', 'source-head', signedFiles, { manual: false, completeManual: true, notesFile: notes, outputDir: directory, run });
  assert(calls.find(args => args[1] === 'edit').includes('--latest=true'));
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
  assert.equal(/\[package\][\s\S]*?\nversion = "([^"]+)"/.exec(cargo)[1], pkg.version);
  assert.equal(/name = "ai-cg-studio-desktop"\r?\nversion = "([^"]+)"/.exec(cargoLock)[1], pkg.version);
});
