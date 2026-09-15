'use strict';
const { test }: typeof import('node:test') = require('node:test');

/**
 * 本地存储可靠性
 *
 * 重构前这个测试针对 tools/image-store.js 与 tools/prompt-builder/history.js，
 * 用假 IndexedDB 验证「写入未提交前不得污染缓存 / UI」。
 * 那两个文件已迁为 src/composables/useKVStore.ts 与 useImageStore.ts，
 * 这里保留同样的保障目标，改测迁移后的模块：
 *   1. kvSet 失败时不得把未提交的值写进内存缓存
 *   2. kvGet 在写入进行中仍返回上一次已提交的值
 *   3. imgPut / imgGet / imgDeleteMany 的事务失败必须抛出而非静默成功
 *   4. 图片记录按 id 覆盖而不是重复堆积
 */

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const imageStoreSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/composables/useImageStore.ts'),
  'utf8',
);
assert(!/\bany\b/.test(imageStoreSource), 'image storage must keep Blob metadata explicitly typed');

function delay(ms: number|undefined) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 最小可用的假 IndexedDB。
 * transactionDelay 用来制造「事务已发起但尚未提交」的窗口。
 */
function createFakeIndexedDB(transactionDelay: number|undefined) {
  const databases = new Map();
  const api = { failNextWrite: false };

  function databaseFor(name: string) {
    if (databases.has(name)) return databases.get(name);
    const records = new Map();
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => {},
      close: () => {},
      set onversionchange(_fn: unknown) { /* 忽略 */ },
      transaction(_storeName: unknown, mode: string) {
        const operations: { (): Map<unknown,unknown>; (): boolean; (): void; }[] = [];
        const shouldFail = mode === 'readwrite' && api.failNextWrite;
        if (shouldFail) api.failNextWrite = false;
        const tx = { error: null, oncomplete: null, onerror: null, onabort: null, abort() {} };
        const store = {
          put(record: { key: unknown; id: unknown; }) { operations.push(() => records.set(record.key ?? record.id, record)); },
          delete(key: unknown) { operations.push(() => records.delete(key)); },
          clear() { operations.push(() => records.clear()); },
          get(key: unknown) {
            const request = { result: undefined, error: null, onsuccess: null, onerror: null };
            setTimeout(() => {
              request.result = records.get(key);
              if (request.onsuccess) request.onsuccess();
            }, 0);
            return request;
          },
          getAll() {
            const request = { result: undefined, error: null, onsuccess: null, onerror: null };
            setTimeout(() => {
              request.result = [...records.values()];
              if (request.onsuccess) request.onsuccess();
            }, 0);
            return request;
          },
        };
        tx.objectStore = () => store;
        setTimeout(() => {
          if (shouldFail) {
            tx.error = new Error('simulated transaction failure');
            if (tx.onerror) tx.onerror();
            return;
          }
          operations.forEach(op => op());
          if (tx.oncomplete) tx.oncomplete();
        }, transactionDelay);
        return tx;
      },
    };
    databases.set(name, db);
    return db;
  }

  api.open = function () {
    const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
    setTimeout(() => {
      request.result = databaseFor('db');
      if (request.onupgradeneeded) request.onupgradeneeded();
      if (request.onsuccess) request.onsuccess();
    }, 0);
    return request;
  };
  return api;
}

/** 装好浏览器全局后再 require 目标模块（模块在导入时读取 globalThis.indexedDB） */
function loadStores(indexedDB: IDBFactory) {
  globalThis.indexedDB = indexedDB;
  if (!globalThis.window) globalThis.window = globalThis;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('useKVStore') || key.includes('useImageStore')) delete require.cache[key];
  }
  return {
    kv: (require('../../src/composables/useKVStore.ts') as typeof import('../../src/composables/useKVStore.ts')),
    img: (require('../../src/composables/useImageStore.ts') as typeof import('../../src/composables/useImageStore.ts')),
  };
}

async function testKvCacheWaitsForCommit() {
  const indexedDB = createFakeIndexedDB(20);
  const { kv } = loadStores(indexedDB);

  await kv.kvSet('history', { version: 1 });
  assert.deepEqual(await kv.kvGet('history'), { version: 1 });

  // 写入进行中：读到的仍必须是上一次已提交的值
  const pending = kv.kvSet('history', { version: 2 });
  assert.deepEqual(
    await kv.kvGet('history'), { version: 1 },
    'cache must expose the last committed value while a write is pending',
  );
  await pending;
  assert.deepEqual(await kv.kvGet('history'), { version: 2 });

  // 事务失败不得污染缓存
  indexedDB.failNextWrite = true;
  await assert.rejects(
    kv.kvSet('history', { version: 3 }),
    'a failed transaction must reject instead of resolving silently',
  );
  assert.deepEqual(
    await kv.kvGet('history'), { version: 2 },
    'failed set must not poison the cache',
  );
}

async function testImageStoreTransactions() {
  const indexedDB = createFakeIndexedDB(5);
  const { img } = loadStores(indexedDB);

  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
  const id = await img.imgPut(blob);
  assert.ok(id && typeof id === 'string', 'imgPut must return a generated id');

  const loaded = await img.imgGet(id);
  assert.ok(loaded instanceof Blob, 'imgGet must return the stored blob');

  const namedBlob = new Blob([new Uint8Array([5])], { type: 'image/webp' });
  Object.defineProperty(namedBlob, 'name', { value: 'sample.webp' });
  const namedId = await img.imgPut(namedBlob);
  const namedRecord = (await img.imgList()).find(record => record.id === namedId);
  assert.strictEqual(namedRecord.name, 'sample.webp', 'File-compatible Blob names must be preserved');

  // 空 blob 必须被拒绝，避免写入坏记录
  await assert.rejects(() => img.imgPut(new Blob([])), /图片文件为空/);

  // 按 id 覆盖，而不是堆积重复记录
  await img.imgPutRecord({ id: 'img_fixed', blob });
  await img.imgPutRecord({ id: 'img_fixed', blob });
  const all = await img.imgList();
  assert.strictEqual(
    all.filter(r => r.id === 'img_fixed').length, 1,
    'putRecord must overwrite by id rather than duplicate',
  );

  // 事务失败必须抛出
  indexedDB.failNextWrite = true;
  await assert.rejects(
    img.imgPut(blob),
    'a failed image transaction must reject',
  );

  // 删除后读不到
  await img.imgDeleteMany(['img_fixed']);
  assert.strictEqual(await img.imgGet('img_fixed'), null, 'deleted image must not be readable');
}

/**
 * 没有 IndexedDB 时必须明确报错，而不是永久挂起。
 *
 * 必须在独立进程里跑：模块级的 dbPromise 一旦被前面的用例打开过就会被复用，
 * 同进程内无法回到「从未开库」的初始状态（require.cache 对 .ts 也清不掉）。
 */
function testMissingIndexedDb() {
  const { execFileSync }: typeof import('child_process') = require('child_process');
  const script = `
    globalThis.window = globalThis;
    globalThis.indexedDB = undefined;
    const assert = require('assert');
    const kv = require('./src/composables/useKVStore.ts');
    (async () => {
      await assert.rejects(kv.kvGet('k'), /IndexedDB|不支持/);
      await assert.rejects(kv.kvSet('k', { a: 1 }), /IndexedDB|不支持/);
    })().catch(e => { console.error(e.message); process.exit(1); });
  `;
  execFileSync(process.execPath, ['-e', script], {
    cwd: (require('path') as typeof import('path')).resolve(__dirname, '..', '..'),
    stdio: 'pipe',
  });
}

test('storage-reliability: KV commit ordering, cache integrity on failure, image transactions, and missing-IndexedDB handling', async () => {
  await testKvCacheWaitsForCommit();
  await testImageStoreTransactions();
  testMissingIndexedDb();
  await delay(0);
  console.log('Storage reliability tests passed: KV commit ordering, cache integrity on failure, image transactions, and missing-IndexedDB handling');
});
