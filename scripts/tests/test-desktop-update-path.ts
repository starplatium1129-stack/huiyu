'use strict';

/**
 * 桌面端「数据更新到达路径」回归：
 * ① desktop:content-sync 覆盖前备份，不删除目标文件，私有状态不参与同步（隔离夹具）；
 * ② 缓存清理只删 WebView2 的三个缓存目录；
 * ③ 部署脚本仍登记着仓库已删除的旧场景单文件（它们回流会让维护接口拒绝服务）。
 */
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const zlib: typeof import('node:zlib') = require('node:zlib');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { test }: typeof import('node:test') = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'maintenance', 'sync-desktop-content.js');
const DEPLOY = path.join(ROOT, 'scripts', 'maintenance', 'deploy-desktop-quick.ps1');

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, AICS_DESKTOP_CONFIG_ROOT: '', AICS_DESKTOP_WEBVIEW_DATA_DIR: '', AICS_DESKTOP_NAMESPACE: '', ...env } });
}
function fixture(execute: (f: { root: string; source: string; target: string; webview: string }) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-desktop-content-'));
  const source = path.join(root, 'data');
  const target = path.join(root, 'content', 'data');
  const webview = path.join(root, 'EBWebView', 'Default');
  fs.mkdirSync(path.join(source, 'references'), { recursive: true });
  fs.mkdirSync(path.join(target, 'references'), { recursive: true });
  fs.writeFileSync(path.join(source, 'character-reference-view.json'), '{"characters":[1]}\n');
  fs.writeFileSync(path.join(source, 'references', 'nene.json'), 'v2\n');
  fs.writeFileSync(path.join(target, 'references', 'nene.json'), 'v1\n');
  fs.writeFileSync(path.join(target, 'references', 'legacy.json'), 'legacy\n');
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
    assert.equal(fs.readFileSync(path.join(f.target, 'references', 'nene.json'), 'utf8'), 'v1\n', 'preview must not write');
    assert.match(preview.stdout, /legacy\.json/);
    assert.match(preview.stdout, /pipeline-run-state\.json/);
    assert.equal(fs.existsSync(path.join(path.dirname(f.target), 'content-sync-backups')), false, 'preview must not create backups');

    const applied = run([`--source=${f.source}`, `--content-root=${f.target}`, '--apply']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /已复制 2 个文件/);
    assert.equal(fs.readFileSync(path.join(f.target, 'references', 'nene.json'), 'utf8'), 'v2\n');
    assert.equal(fs.readFileSync(path.join(f.target, 'references', 'legacy.json'), 'utf8'), 'legacy\n', 'target-only files must survive');
    assert.equal(fs.readFileSync(path.join(f.target, 'pipeline-run-state.json'), 'utf8'), 'user-state\n', 'user state must survive');
    const backups = path.join(path.dirname(f.target), 'content-sync-backups');
    const [saved] = fs.readdirSync(backups);
    const backup = path.join(backups, saved!);
    assert.equal(fs.readFileSync(path.join(backup, 'references', 'nene.json'), 'utf8'), 'v1\n', 'overwritten bytes must remain recoverable');
    assert.equal(fs.existsSync(path.join(backup, 'character-reference-view.json')), false, 'new files have no previous bytes');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup, 'sync-manifest.json'), 'utf8')), { target: f.target, added: ['character-reference-view.json'], updated: ['references/nene.json'] });
    assert.match(applied.stdout, /覆盖前原字节备份/);

    const second = run([`--source=${f.source}`, `--content-root=${f.target}`, '--apply']);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /已复制 0 个文件/, 'idempotent second run');
    assert.deepEqual(fs.readdirSync(backups), [saved], 'unchanged reruns do not accumulate backups');
  });
});

test('desktop content sync skips catalog records without reading, copying, deleting or reporting them', t => {
  fixture(f => {
    const { main }: typeof import('../maintenance/sync-desktop-content') = require('../maintenance/sync-desktop-content');
    const io: typeof import('../lib/maintenance-recovery-fs') = require('../lib/maintenance-recovery-fs');
    const folders = ['catalog', 'popular', 'scenes', 'blueprints'];
    const records = ['characters.json', 'popular-characters.json', 'scene-blueprints.json', 'scenes.json',
      'scenes-nene.json', 'scenes-natsume.json', 'scenes-shared.json', 'scenes-core.json', 'scenes-index.json'];
    for (const folder of folders) {
      fs.mkdirSync(path.join(f.source, folder)); fs.mkdirSync(path.join(f.target, folder));
      fs.writeFileSync(path.join(f.source, folder, 'not-for-sync.json'), 'source-record');
      fs.writeFileSync(path.join(f.target, folder, 'personal-only.json'), 'personal-record');
    }
    for (const file of records) {
      fs.writeFileSync(path.join(f.source, file), 'source-record');
      fs.writeFileSync(path.join(f.target, file), 'personal-record');
    }
    // Ignored record projections must not even be decompressed or added to the target.
    fs.writeFileSync(path.join(f.source, 'scenes.json.br'), 'invalid brotli');
    fs.writeFileSync(path.join(f.source, 'characters.json.GZ'), 'invalid gzip');
    const retained = ['tags/manifest.json', 'tags.json', 'loras.json', 'prompt-pinned-scenes.json'];
    for (const file of retained) {
      fs.mkdirSync(path.dirname(path.join(f.source, file)), { recursive: true });
      fs.writeFileSync(path.join(f.source, file), 'file-backed-metadata');
    }
    const isRecord = (file: unknown) => [f.source, f.target].some(root => {
      const relative = path.relative(root, path.resolve(String(file))).replaceAll('\\', '/');
      return folders.some(folder => relative === folder || relative.startsWith(`${folder}/`))
        || records.includes(relative.replace(/\.(br|gz)$/i, ''));
    });
    const read = io.readBytes, readdir = fs.readdirSync, lines: string[] = [];
    t.mock.method(io, 'readBytes', (file: string, allowMissing?: boolean) => {
      assert.equal(isRecord(file), false, `record bytes must not be read: ${file}`);
      return read(file, allowMissing);
    });
    t.mock.method(fs, 'readdirSync', (file: any, ...options: any[]) => {
      assert.equal(isRecord(file), false, `record directories must not be traversed: ${file}`);
      return Reflect.apply(readdir, fs, [file, ...options]);
    });
    t.mock.method(console, 'log', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try { main([`--source=${f.source}`, `--content-root=${f.target}`, '--apply']); }
    finally { t.mock.restoreAll(); }
    const report = lines.join('\n');
    assert.match(report, /新增 5；更新 1；目标多余 2/);
    assert.match(report, /已跳过人物\/服装\/场景\/蓝图/);
    assert.ok(!report.includes('personal-only.json') && !records.some(file => report.includes(file)));
    for (const folder of folders) {
      assert.equal(fs.readFileSync(path.join(f.target, folder, 'personal-only.json'), 'utf8'), 'personal-record');
      assert.equal(fs.existsSync(path.join(f.target, folder, 'not-for-sync.json')), false);
    }
    for (const file of records) assert.equal(fs.readFileSync(path.join(f.target, file), 'utf8'), 'personal-record');
    for (const file of ['scenes.json.br', 'characters.json.GZ']) assert.equal(fs.existsSync(path.join(f.target, file)), false);
    for (const file of retained) assert.equal(fs.readFileSync(path.join(f.target, file), 'utf8'), 'file-backed-metadata');
  });
});

test('desktop content sync clears only the WebView2 cache directories', () => {
  fixture(f => {
    const result = run([`--source=${f.source}`, `--content-root=${f.target}`, `--webview-root=${f.webview}`, '--clear-webview-cache']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /已清理 3 个 WebView2 缓存目录/);
    for (const name of ['Cache', 'Code Cache', 'GPUCache']) assert.equal(fs.existsSync(path.join(f.webview, name)), false, name + ' must be removed');
    assert.equal(fs.existsSync(path.join(f.webview, 'Local Storage')), true, 'unrelated webview data must survive');
    assert.equal(fs.readFileSync(path.join(f.target, 'references', 'nene.json'), 'utf8'), 'v1\n', 'cache clearing alone must not copy data');
  });
});

test('desktop content sync excludes repository-local private state even when target names match', () => {
  fixture(f => {
    for (const file of ['pipeline-run-state.json', 'history.json', 'projects.json', 'prompts.json', 'live2d-candidates.json']) {
      fs.writeFileSync(path.join(f.source, file), 'repository-private\n');
      fs.writeFileSync(path.join(f.target, file), 'personal-private\n');
    }
    const result = run([`--source=${f.source}`, `--content-root=${f.target}`, '--apply']);
    assert.equal(result.status, 0, result.stderr);
    for (const file of ['pipeline-run-state.json', 'history.json', 'projects.json', 'prompts.json', 'live2d-candidates.json']) {
      assert.equal(fs.readFileSync(path.join(f.target, file), 'utf8'), 'personal-private\n', file + ' must not be replaced');
    }
  });
});

test('desktop content sync rejects linked destinations before copying or clearing caches', () => {
  fixture(f => {
    const outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'nene.json'), 'outside-personal\n');
    fs.rmSync(path.join(f.target, 'references'), { recursive: true });
    fs.symlinkSync(outside, path.join(f.target, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = run([`--source=${f.source}`, `--content-root=${f.target}`, `--webview-root=${f.webview}`, '--apply', '--clear-webview-cache']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink|junction|符号链接/);
    assert.equal(fs.readFileSync(path.join(outside, 'nene.json'), 'utf8'), 'outside-personal\n');
    assert.equal(fs.existsSync(path.join(f.target, 'character-reference-view.json')), false, 'preflight must prevent partial writes');
    assert.equal(fs.existsSync(path.join(f.webview, 'Cache')), true, 'preflight must prevent cache deletion');
  });
});

test('desktop content sync rejects a linked cache ancestor before any data write', () => {
  fixture(f => {
    const alias = path.join(f.root, 'linked-profile');
    fs.symlinkSync(f.webview, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const result = run([`--source=${f.source}`, `--content-root=${f.target}`, `--webview-root=${alias}`, '--apply', '--clear-webview-cache']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /symlink|junction|符号链接/);
      assert.equal(fs.existsSync(path.join(f.target, 'character-reference-view.json')), false);
      assert.equal(fs.existsSync(path.join(f.webview, 'Cache')), true);
    } finally {
      // Remove the junction before its target; Windows cannot unlink a dangling one.
      fs.unlinkSync(alias);
    }
  });
});

test('desktop content sync rejects stale compressed sources and accepts matching gzip and brotli', () => {
  fixture(f => {
    const raw = fs.readFileSync(path.join(f.source, 'character-reference-view.json'));
    fs.writeFileSync(path.join(f.source, 'character-reference-view.json.gz'), zlib.gzipSync('stale source'));
    const rejected = run([`--source=${f.source}`, `--content-root=${f.target}`, '--apply']);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /预压内容与源不一致/);
    assert.equal(fs.existsSync(path.join(f.target, 'character-reference-view.json')), false);
    fs.writeFileSync(path.join(f.source, 'character-reference-view.json.gz'), zlib.gzipSync(raw));
    fs.renameSync(path.join(f.source, 'character-reference-view.json.gz'), path.join(f.source, 'character-reference-view.json.GZ'));
    fs.writeFileSync(path.join(f.source, 'character-reference-view.json.br'), zlib.brotliCompressSync(raw));
    const accepted = run([`--source=${f.source}`, `--content-root=${f.target}`, '--apply']);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(f.target, 'character-reference-view.json.GZ'))), raw);
    assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(path.join(f.target, 'character-reference-view.json.br'))), raw);
  });
});

test('desktop content sync uses the actual host configuration and WebView profile overrides', () => {
  fixture(f => {
    const config = path.join(f.root, 'config');
    const managed = path.join(config, 'gateway', 'content', 'data');
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.renameSync(f.target, managed);
    const result = run([`--source=${f.source}`, '--apply', '--clear-webview-cache'], {
      AICS_DESKTOP_CONFIG_ROOT: config, AICS_DESKTOP_WEBVIEW_DATA_DIR: f.root,
      APPDATA: path.join(f.root, 'unrelated-appdata'), LOCALAPPDATA: path.join(f.root, 'unrelated-localdata'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(managed, 'references', 'nene.json'), 'utf8'), 'v2\n');
    assert.equal(fs.existsSync(path.join(f.webview, 'Cache')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'unrelated-appdata')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'unrelated-localdata')), false);
  });
});

test('desktop content sync refuses a live host and pending content maintenance without stopping them', () => {
  fixture(f => {
    const config = path.join(f.root, 'config');
    const managed = path.join(config, 'gateway', 'content', 'data');
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.renameSync(f.target, managed);
    fs.writeFileSync(path.join(config, 'desktop-maintenance.json'), JSON.stringify({ hostPid: process.pid }));
    const live = run([`--source=${f.source}`, `--content-root=${managed}`, `--webview-root=${f.webview}`, '--apply', '--clear-webview-cache']);
    assert.equal(live.status, 1);
    assert.match(live.stderr, /DESKTOP_RUNNING/);
    assert.equal(fs.existsSync(path.join(managed, 'character-reference-view.json')), false);
    assert.equal(fs.existsSync(path.join(f.webview, 'Cache')), true);
    if (process.platform === 'win32') {
      const upper = path.join(config, 'GATEWAY', 'CONTENT', 'data');
      const alias = run([`--source=${f.source}`, `--content-root=${upper}`, `--webview-root=${f.webview}`, '--apply', '--clear-webview-cache']);
      assert.equal(alias.status, 1);
      assert.match(alias.stderr, /DESKTOP_RUNNING/, 'Windows path casing must not bypass the live host guard');
      assert.equal(fs.existsSync(path.join(managed, 'character-reference-view.json')), false);
      assert.equal(fs.existsSync(path.join(f.webview, 'Cache')), true);
    }
    fs.unlinkSync(path.join(config, 'desktop-maintenance.json'));
    const lease = path.join(path.dirname(managed), 'runtime', 'maintenance-transactions', 'lease');
    fs.mkdirSync(lease, { recursive: true });
    const pending = run([`--source=${f.source}`, `--content-root=${managed}`, '--apply']);
    assert.equal(pending.status, 1);
    assert.match(pending.stderr, /CONTENT_BUSY/);
    assert.equal(fs.existsSync(lease), true, 'pending maintenance must not be erased');
    assert.equal(fs.readFileSync(path.join(managed, 'references', 'nene.json'), 'utf8'), 'v1\n');
  });
});

test('desktop content sync rejects changes made after its backup without overwriting the new personal bytes', t => {
  fixture(f => {
    const { main }: typeof import('../maintenance/sync-desktop-content') = require('../maintenance/sync-desktop-content');
    const io: typeof import('../lib/maintenance-recovery-fs') = require('../lib/maintenance-recovery-fs');
    const originalWrite = io.atomicWrite;
    const target = path.join(f.target, 'references', 'nene.json');
    t.mock.method(io, 'atomicWrite', (file: string, bytes: Buffer, createParents?: boolean) => {
      originalWrite(file, bytes, createParents);
      if (file.includes('content-sync-backups') && file.endsWith(path.join('references', 'nene.json'))) fs.writeFileSync(target, 'concurrent-personal-edit\n');
    });
    assert.throws(() => main([`--source=${f.source}`, `--content-root=${f.target}`, '--apply']), /CONTENT_CHANGED/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'concurrent-personal-edit\n');
    assert.equal(fs.existsSync(path.join(f.target, 'character-reference-view.json')), false);
  });
});

test('deploy script keeps UTF-8 BOM for Windows PowerShell 5.1', () => {
  assert.equal(fs.readFileSync(DEPLOY).subarray(0, 3).toString('hex'), 'efbbbf');
});

test('Windows PowerShell 5.1 parses the deployment entry without executing it', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:AICS_TEST_DEPLOY_PARSE_FILE, [ref]$tokens, [ref]$errors); if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }'], {
    env: { ...process.env, AICS_TEST_DEPLOY_PARSE_FILE: DEPLOY }, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
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
