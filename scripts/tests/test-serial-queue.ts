'use strict';

import assert = require('node:assert/strict');
const SerialQueue: typeof import('../../services/serial-queue') = require('../../services/serial-queue');

const { test }: typeof import('node:test') = require('node:test');

test("Serial queue tests passed: FIFO order, wait context, failure isolation, admission control, and abort dequeue", () => {
const queue = new SerialQueue('test-queue');
assert.deepStrictEqual(queue.status(), { name: 'test-queue', active: 0, pending: 0, maxPending: 16 });

const order: string[] = [];
const first = queue.run(function (context) {
  assert.strictEqual(context.queue, 'test-queue');
  assert(context.waitMs >= 0);
  order.push('start-1');
  return new Promise(function (resolve) {
    setTimeout(function () {
      order.push('end-1');
      resolve('one');
    }, 20);
  });
});

assert.strictEqual(queue.status().pending, 1);
assert.strictEqual(queue.status().active, 0);

const second = queue.run(function () {
  order.push('start-2');
  return 'two';
});

const failed = queue.run(function () {
  order.push('start-fail');
  throw new Error('boom');
});

const third = queue.run(function () {
  order.push('start-3');
  return 'three';
});

Promise.allSettled([first, second, failed, third]).then(function (results) {
  assert.strictEqual(results[0].status, 'fulfilled');
  assert.strictEqual(results[0].value, 'one');
  assert.strictEqual(results[1].status, 'fulfilled');
  assert.strictEqual(results[1].value, 'two');
  assert.strictEqual(results[2].status, 'rejected');
  assert.strictEqual(String(results[2].reason && results[2].reason.message), 'boom');
  assert.strictEqual(results[3].status, 'fulfilled');
  assert.strictEqual(results[3].value, 'three');
  assert.deepStrictEqual(order, ['start-1', 'end-1', 'start-2', 'start-fail', 'start-3']);
  assert.deepStrictEqual(queue.status(), { name: 'test-queue', active: 0, pending: 0, maxPending: 16 });
  return checkAdmissionControl();
}).then(function () {
  console.log('Serial queue tests passed: FIFO order, wait context, failure isolation, admission control, and abort dequeue');
}).catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});

// 排队上限：无上限时一个客户端就能无限堆积 GPU 作业（实测 500 个全被接受）
function checkAdmissionControl() {
  const bounded = new SerialQueue('bounded', 3);
  assert.strictEqual(bounded.status().maxPending, 3);

  const block = function (): Promise<void> {
    return new Promise(function (resolve) { setTimeout(resolve, 30); });
  };
  const accepted = [bounded.run(block), bounded.run(block), bounded.run(block)];
  assert.strictEqual(bounded.status().pending, 3, 'three jobs must be queued');

  const rejected = bounded.run(block);
  return rejected.then(function () {
    throw new Error('queue must reject work beyond maxPending');
  }, function (error) {
    assert.strictEqual(error.code, 'QUEUE_FULL');
    assert.strictEqual(error.status, 503, 'callers need a 503-mappable status');
    return Promise.all(accepted);
  }).then(function () {
    // 队列排空后必须重新接受任务
    return bounded.run(function () { return 'ok'; });
  }).then(function (value) {
    assert.strictEqual(value, 'ok', 'queue must accept work again after draining');
    return checkCapIncludesActive();
  });
}

// 2026-08-16 审计：判满必须计入 active——此前只数 pending，队首任务转 active 后
// 会空出一个槽，实际在途可达 maxPending+1（离一超限）。
function checkCapIncludesActive() {
  const q = new SerialQueue('cap-active', 2);
  const ran: string[] = [];
  const gate = new Promise(function (resolve) { setTimeout(resolve, 20); });
  const first = q.run(function () {
    ran.push('first');
    return gate;
  });
  return gate.then(function () {
    // 20ms 后 first 一定已转 active（microtask 远早于 timer 排空）
    assert.strictEqual(q.status().active, 1, 'first task must be active once the gate resolves');
    const second = q.run(function () { ran.push('second'); return 'two'; });
    assert.strictEqual(q.status().pending, 1, 'second task queued behind the active one');
    const third = q.run(function () { ran.push('third'); return 'three'; });
    return third.then(function () {
      throw new Error('active must count toward maxPending: 1 active + 2 pending must be QUEUE_FULL');
    }, function (error) {
      assert.strictEqual(error.code, 'QUEUE_FULL');
      assert.strictEqual(error.status, 503);
      return Promise.all([first, second]);
    });
  }).then(function () {
    assert.deepStrictEqual(ran, ['first', 'second'], 'rejected task must never run');
    return checkAbortDequeue();
  });
}

// 排队期间客户端断开：任务必须直接出队，而不是等排到队首才发现
// （否则被放弃的请求照样拖慢后面的真实请求）
function checkAbortDequeue() {
  const q = new SerialQueue('abort-test');
  const ran: string[] = [];

  const head = q.run(function () {
    return new Promise(function (resolve) { setTimeout(resolve, 25); });
  });

  const controller = new AbortController();
  const abandoned = q.run(function () { ran.push('abandoned'); return 'nope'; }, { signal: controller.signal });
  const real = q.run(function () { ran.push('real'); return 'yes'; });

  assert.strictEqual(q.status().pending, 3, 'three tasks queued (head execute runs on next microtask)');
  controller.abort();  // 还在排队时客户端走了
  assert.strictEqual(q.status().pending, 2, 'abort while queued must release the pending slot immediately, not wait for FIFO front');

  // 入队时信号已中止：不占槽、直接拒绝。
  const preAborted = new AbortController();
  preAborted.abort();
  const neverQueued = q.run(function () { ran.push('never'); return 'nope'; }, { signal: preAborted.signal });
  assert.strictEqual(q.status().pending, 2, 'already-aborted signal must not consume a pending slot');

  return Promise.allSettled([head, abandoned, real, neverQueued]).then(function (results) {
    assert.strictEqual(results[1].status, 'rejected', 'aborted job must not run');
    assert.strictEqual(results[1].reason && results[1].reason.name, 'AbortError');
    assert.strictEqual(results[2].status, 'fulfilled', 'the real job must still complete');
    assert.strictEqual(results[3].status, 'rejected', 'pre-aborted job rejected');
    assert.strictEqual(results[3].reason && results[3].reason.name, 'AbortError');
    assert.deepStrictEqual(ran, ['real'], 'abandoned work must never reach the GPU');
    assert.strictEqual(q.status().active, 0, 'no leaked active count');
    assert.strictEqual(q.status().pending, 0, 'aborted job must leave the queue');
  });
}

});


test('queued abort settles before a blocked head and repeated aborts retain no backlog', async () => {
  const q = new SerialQueue('blocked', 2);
  let release: ((value?: unknown) => void) | undefined;
  const head = q.run(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  try {
    for (let i = 0; i < 100; i += 1) {
      const controller = new AbortController();
      const abandoned = q.run(() => assert.fail('cancelled task executed'), { signal: controller.signal });
      controller.abort();
      await assert.rejects(abandoned, { name: 'AbortError' });
      assert.equal(q.status().pending, 0);
      assert.equal((q as unknown as { entries: unknown[] }).entries.length, 0);
    }
  } finally { release?.(); await head; }
});
