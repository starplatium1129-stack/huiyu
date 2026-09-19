'use strict';

/**
 * server/logger.js 单元测试：级别写入、按天文件名、debug 门控、保留期清理。
 * appendFile 为异步落盘，等待真实完成回调，不以固定延迟推断已写入。
 */

const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert') = require('node:assert');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const { createLogger }: typeof import('../../server/logger') = require('../../server/logger');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aics-logger-'));
}

function todayKey() {
  const d = new Date();
  return '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function readLog(dir: any, prefix: any) {
  return fs.readFileSync(path.join(dir, `${prefix}-${todayKey()}.log`), 'utf8');
}

async function waitForAppends(action: () => void): Promise<number> {
  const original = fs.appendFile;
  const pending: Promise<void>[] = [];
  // Observe only the logger's four-argument call; retain the real filesystem IO.
  fs.appendFile = ((file: import('node:fs').PathOrFileDescriptor, data: string | Uint8Array,
    options: import('node:fs').WriteFileOptions, callback: import('node:fs').NoParamCallback) => {
    pending.push(new Promise<void>((resolve, reject) => {
      original(file, data, options, error => { callback(error); if (error) reject(error); else resolve(); });
    }));
  }) as typeof fs.appendFile;
  try { action(); } finally { fs.appendFile = original; }
  await Promise.all(pending);
  return pending.length;
}

test('info/warn/error write timestamped lines to the daily file', { timeout: 5000 }, async () => {
  const dir = makeTmpDir();
  const logger = createLogger({ dir, prefix: 'gw' });
  assert.equal(await waitForAppends(() => {
    logger.info('hello info');
    logger.warn('hello warn');
    logger.error('hello error', new Error('boom'));
  }), 3);

  const content = readLog(dir, 'gw');
  assert.ok(content.includes('[INFO] hello info'), 'info line present');
  assert.ok(content.includes('[WARN] hello warn'), 'warn line present');
  assert.ok(content.includes('[ERROR] hello error'), 'error line present');
  assert.match(content, /\[\d{4}-\d{2}-\d{2}T/, 'ISO timestamp present');
  assert.ok(content.includes('boom'), 'error detail (stack/message) appended');
});

test('debug() is silent unless enabled, persists to file when enabled', { timeout: 5000 }, async () => {
  const dir = makeTmpDir();
  const logger = createLogger({ dir, prefix: 'gw', debug: false });
  assert.equal(await waitForAppends(() => logger.debug('should not persist')), 0);
  if (fs.existsSync(path.join(dir, `gw-${todayKey()}.log`))) {
    assert.ok(!readLog(dir, 'gw').includes('should not persist'));
  }

  const loud = createLogger({ dir, prefix: 'gw2', debug: true });
  assert.equal(await waitForAppends(() => loud.debug('debug visible')), 1);
  assert.ok(readLog(dir, 'gw2').includes('[DEBUG] debug visible'),
    'enabled debug lines persist with DEBUG level');
});

test('retention sweep: 双判据回收——过期按天日志（含旁路 prefix）与过期旁路文件都删除，新鲜文件保留', () => {
  const dir = makeTmpDir();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const key = (d: any) => '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  fs.writeFileSync(path.join(dir, 'gateway-' + key(old) + '.log'), 'stale\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'other-' + key(old) + '.log'), 'not-mine\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'comfyui.stderr.log'), 'stale bypass\n', 'utf8');
  const staleMtime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, 'comfyui.stderr.log'), staleMtime, staleMtime);
  fs.writeFileSync(path.join(dir, 'control.log'), 'fresh bypass\n', 'utf8');

  createLogger({ dir, prefix: 'gateway', retainDays: 14 });
  assert.strictEqual(fs.existsSync(path.join(dir, 'gateway-' + key(old) + '.log')), false,
    'expired gateway log deleted synchronously at init');
  // P1-11 双判据：旁路日志不再无限积压——带日期后缀的按文件名日期判，
  // 无日期后缀的按 mtime 判；新鲜文件不受影响。
  assert.strictEqual(fs.existsSync(path.join(dir, 'other-' + key(old) + '.log')), false,
    'expired other-prefix dated log deleted by dual-criteria sweep');
  assert.strictEqual(fs.existsSync(path.join(dir, 'comfyui.stderr.log')), false,
    'stale undated bypass log deleted by mtime');
  assert.strictEqual(fs.existsSync(path.join(dir, 'control.log')), true,
    'fresh undated bypass log kept (mtime within retention)');
});

test('missing dir degrades to console-only without throwing', () => {
  const logger = createLogger({ dir: '', prefix: 'gw' });
  assert.doesNotThrow(() => {
    logger.info('no-dir ok');
    logger.error('no-dir err');
  });
});
