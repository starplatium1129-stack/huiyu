'use strict';

/**
 * src/composables/useCompareSnapshots.ts 单元测试（Node 内建类型剥离直跑）。
 * 覆盖 2026-08-21 拆分时的关键回归点：双快照轮转、token 防乱序、
 * 非 blob URL 直通。blob 克隆/revoke 属浏览器 API，由 E2E 与人工验证覆盖。
 */

const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert') = require('node:assert');
// useCompareSnapshots 内部经 useFocusTrap 注册 keydown 监听——Node 无 DOM。
// @vue/runtime-dom 在模块加载期会探测/创建元素，桩必须能吸收任意调用。
const noop = () => {};
globalThis.document = new Proxy({
  addEventListener: noop,
  removeEventListener: noop,
  activeElement: null,
  body: { classList: { add: noop, remove: noop } },
  createElement: () => new Proxy({ style: {} }, {
    get: (target, prop) => (prop in target ? (target as Record<string, any>)[prop] : noop),
    set: () => true,
  }),
}, {
  get: (target, prop) => (prop in target ? (target as Record<string, any>)[prop] : noop),
});
const { useCompareSnapshots }: typeof import('../../src/composables/useCompareSnapshots.ts') = require('../../src/composables/useCompareSnapshots.ts');

function flush(ms: any = 20) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('rotate keeps prev/last rotation semantics', async () => {
  const calls = [];
  const cmp: any = useCompareSnapshots({
    build: async (url) => { await flush(5); calls.push(url); return { url, tag: url } },
  });

  cmp.rotate('first');
  await flush(40);
  assert.strictEqual(cmp.lastResult.value?.url, 'first');
  assert.strictEqual(cmp.prevResult.value, null);

  cmp.rotate('second');
  await flush(40);
  assert.strictEqual(cmp.prevResult.value?.url, 'first', 'prev ← last');
  assert.strictEqual(cmp.lastResult.value?.url, 'second');
});

test('rapid rotations drop stale snapshots via token guard', async () => {
  const built = [];
  const cmp = useCompareSnapshots({
    build: async (url) => {
      // 第一次构建故意更慢：保证它晚于第二次完成，触发过期丢弃
      const delay = url === 'slow' ? 60 : 5;
      await flush(delay);
      const snap = { url, tag: url };
      built.push(snap);
      return snap;
    },
  });

  cmp.rotate('slow');
  cmp.rotate('fast');
  await flush(120);

  assert.strictEqual(cmp.lastResult.value?.url, 'fast', 'only latest write wins');
  assert.strictEqual(built.length, 2);
});

test('non-blob URLs pass through unchanged', async () => {
  let received = '';
  const cmp = useCompareSnapshots({
    build: (url) => { received = url; return { url }; },
  });
  cmp.rotate('/api/generation/jobs/x/result');
  await flush(30);
  assert.strictEqual(received, '/api/generation/jobs/x/result');
});
