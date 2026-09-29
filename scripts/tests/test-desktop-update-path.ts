'use strict';

/**
 * 桌面端「数据更新到达路径」回归：
 * ① desktop:content-sync 只增改、不删除目标文件，陈旧项单独报告（隔离夹具）；
 * ② 缓存清理只删 WebView2 的三个缓存目录；
 * ③ 部署脚本仍登记着仓库已删除的旧场景单文件（它们回流会让维护接口拒绝服务）。
 */
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { test }: typeof import('node:test') = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'maintenance', 'sync-desktop-content.js');
const DEPLOY = path.join(ROOT, 'scripts', 'maintenance', 'deploy-desktop-quick.ps1');

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
}
function fixture(execute: (f: { root: string; source: string; target: string; webview: string }) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-desktop-content-'));
  const source = path.join(root, 'data');
  const target = path.join(root, 'content', 'data');
  const webview = path.join(root, 'EBWebView', 'Default');
  fs.mkdirSync(path.join(source, 'popular'), { recursive: true });
  fs.mkdirSync(path.join(target, 'popular'), { recursive: true });
  fs.writeFileSync(path.join(source, 'characters.json'), '{"characters":[1]}\n');
  fs.writeFileSync(path.join(source, 'popular', 'fate.json'), 'v2\n');
  fs.writeFileSync(path.join(target, 'popular', 'fate.json'), 'v1\n');
  fs.writeFileSync(path.join(target, 'popular', 'legacy.json'), 'legacy\n');
  fs.writeFileSync(path.join(target, 'pipeline-run-state.json'), 'user-state\n');
  for (const name of ['Cache', 'Code Cache', 'GPUCache', 'Local Storage']) fs.mkdirSync(path.join(webview, name), { recursive: true });
  try {
    execute({ root, source, target, webview });
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('desktop content sync previews and copies only missing or changed files', () => {
  fixture(f => {
    const preview = run([`--source=${f.source}`, `--content-root=${f.target}`]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /新增 1；更新 1；目标多余 2/);
    assert.match(preview.stdout, /preview|预览模式/);
    assert.equal(fs.readFileSync(path.join(f.target, 'popular', 'fate.json'), 'utf8'), 'v1\n', 'preview must not write');
    assert.match(preview.stdout, /legacy\.json/);
    assert.match(preview.stdout, /pipeline-run-state\.json/);

    const applied = run([`--source=${f.source}`, `--content-root=${f.target}`, '--apply']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /已复制 2 个文件/);
    assert.equal(fs.readFileSync(path.join(f.target, 'popular', 'fate.json'), 'utf8'), 'v2\n');
    assert.equal(fs.readFileSync(path.join(f.target, 'popular', 'legacy.json'), 'utf8'), 'legacy\n', 'target-only files must survive');
    assert.equal(fs.readFileSync(path.join(f.target, 'pipeline-run-state.json'), 'utf8'), 'user-state\n', 'user state must survive');

    const second = run([`--source=${f.source}`, `--content-root=${f.target}`, '--apply']);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /已复制 0 个文件/, 'idempotent second run');
  });
});

test('desktop content sync clears only the WebView2 cache directories', () => {
  fixture(f => {
    const result = run([`--source=${f.source}`, `--content-root=${f.target}`, `--webview-root=${f.webview}`, '--clear-webview-cache']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /已清理 3 个 WebView2 缓存目录/);
    for (const name of ['Cache', 'Code Cache', 'GPUCache']) assert.equal(fs.existsSync(path.join(f.webview, name)), false, name + ' must be removed');
    assert.equal(fs.existsSync(path.join(f.webview, 'Local Storage')), true, 'unrelated webview data must survive');
    assert.equal(fs.readFileSync(path.join(f.target, 'popular', 'fate.json'), 'utf8'), 'v1\n', 'cache clearing alone must not copy data');
  });
});

test('deploy script still prunes the scene shards the repository removed', () => {
  const script = fs.readFileSync(DEPLOY, 'utf8');
  const block = /\$STALE_ASSETS\s*=\s*@\(([\s\S]*?)\)/.exec(script);
  assert.ok(block, 'deploy script must declare $STALE_ASSETS');
  const declared = block![1];
  for (const relative of ['assets\\character-references',
    'data\\scenes\\nene-core.json', 'data\\scenes\\nene-core.json.br', 'data\\scenes\\nene-core.json.gz',
    'data\\scenes\\nene-after-story.json', 'data\\scenes\\nene-after-story.json.br', 'data\\scenes\\nene-after-story.json.gz',
    'data\\scenes\\natsume-core.json', 'data\\scenes\\natsume-core.json.br', 'data\\scenes\\natsume-core.json.gz']) {
    assert.ok(declared.includes(`'${relative}'`), relative + ' must stay registered as a stale install asset');
  }
  for (const relative of ['nene-core', 'nene-after-story', 'natsume-core']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'data', 'scenes', relative + '.1.json')), true,
      relative + ' must still ship as numbered batches');
    assert.equal(fs.existsSync(path.join(ROOT, 'data', 'scenes', relative + '.json')), false,
      relative + '.json must stay removed from the repository so batches are unambiguous');
  }
});
