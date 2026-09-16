'use strict';

import { TimeLike } from 'node:fs';

/**
 * server/logger.js 保留期清理契约测试（2026-08-28 补，审计 P1-11）。
 *
 * 覆盖 sweepRetention 双判据（此前只回收本 prefix 的按天日志，
 * comfyui/translate 等旁路日志与旧格式残留无限积压）：
 *   1. 本 prefix 超期按天日志 → 清；
 *   2. 其他 prefix 的超期按天日志（comfyui-YYYYMMDD.log）→ 清；
 *   3. 无日期后缀且 mtime 超期（translate.log 旧残留）→ 清；
 *   4. 新鲜按天日志与活跃旁路日志 → 保留；
 *   5. 非 .log 文件 → 保留；
 *   6. 超大无日期后缀旁路日志 → 归档为按天名（大小守卫，P1-12）。
 */

const test: typeof import('node:test') = require('node:test');
const assert: typeof import('assert/strict') = require('assert/strict');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const { createLogger }: typeof import('../../server/logger') = require('../../server/logger');
function dateKey(d: Date) { return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }

function touch(full: string, mtime: TimeLike) {
  fs.writeFileSync(full, 'x');
  if (mtime) fs.utimesSync(full, mtime, mtime);
}

test('logger sweepRetention：双判据回收 + 新鲜文件保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-logger-'));
  const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  const freshDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

  // 应被清理
  touch(path.join(dir, 'gateway-20250101.log'), oldDate); // 本 prefix 超期
  touch(path.join(dir, 'comfyui-20250101.log'), oldDate); // 旁路 prefix 超期
  touch(path.join(dir, 'gateway.log'), oldDate);          // 收口前旧格式残留
  touch(path.join(dir, 'translate.log'), oldDate);        // mtime 超期的旁路日志
  // 应保留
  touch(path.join(dir, 'gateway-' + dateKey(new Date()) + '.log'), freshDate); // 保留期内按天日志
  touch(path.join(dir, 'comfyui.stderr.log'), new Date());  // 活跃旁路日志
  touch(path.join(dir, 'notes.txt'), oldDate);              // 非 .log 不越权

  try {
    createLogger({ dir, prefix: 'gateway', retainDays: 14 });
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(
      left.filter((n) => n.endsWith('.log')).sort(),
      ['comfyui.stderr.log', 'gateway-' + dateKey(new Date()) + '.log'],
    );
    assert.ok(left.includes('notes.txt'), '非日志文件不越权清理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logger sizeGuard：超大无日期旁路日志归档为按天名，未超限不归档', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-logger-size-'));
  const d = new Date();
  const today = '' + d.getFullYear()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
  const big = path.join(dir, 'control.log');
  fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 'a')); // 9MB > 8MB 阈值
  fs.writeFileSync(path.join(dir, 'tiny.log'), 'x');
  fs.writeFileSync(path.join(dir, 'gateway-' + dateKey(new Date()) + '.log'), 'dated');

  try {
    createLogger({ dir, prefix: 'gateway', retainDays: 14, maxBytes: 8 * 1024 * 1024 });
    const left = fs.readdirSync(dir).sort();
    assert.ok(left.includes('control-' + today + '.log'), '超大旁路日志应归档为按天名');
    assert.ok(!left.includes('control.log'), '归档后原名字不再保留');
    assert.ok(left.includes('tiny.log'), '未超限文件不归档');
    assert.ok(left.includes('gateway-' + dateKey(new Date()) + '.log'), '按天日志不触发大小守卫');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
