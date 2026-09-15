'use strict';

const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');

test("Control operation tests passed: serialization, progress, stale guards, and failures", () => {
const { createOperationManager }: typeof import('../../services/control-operation') = require('../../services/control-operation');

const state = { operation:null };
const manager = createOperationManager(state);
const first = manager.begin('mode', '切换绘图模式', ['释放模型', '启动服务']);

assert(first && first.status === 'running', 'begin must create a running operation');
assert.strictEqual(first.message, '释放模型', 'begin must expose the first stage');
assert.strictEqual(manager.begin('service', '启动语音', []), null, 'running operations must serialize later work');
assert.strictEqual(manager.update(first, 1), true, 'current operation must accept progress updates');
assert.strictEqual(first.message, '启动服务', 'progress must use the current stage label');

let responseCode = 0;
let responseBody: any = null;
const response = {
  status(code: number) { responseCode = code; return this; },
  json(body: unknown) { responseBody = body; return this; }
};
assert.strictEqual(manager.rejectConflict(response), true, 'running operation must reject conflicting work');
assert.strictEqual(responseCode, 409, 'conflict response must use HTTP 409');
assert.strictEqual(responseBody.operation.id, first.id, 'conflict response must expose active progress');

assert.strictEqual(manager.finish(first, null), true, 'current operation must finish');
assert.strictEqual(first.status, 'completed', 'successful operation must become completed');
assert(first.finishedAt >= first.startedAt, 'completed operation must record finish time');
assert.strictEqual(manager.rejectConflict(response), false, 'completed operation must not block later work');

const second = manager.begin('service', '启动语音', ['检测']);
assert(second && second.id !== first.id, 'a later operation must receive a unique id');
assert.strictEqual(manager.finish(first, new Error('stale')), false, 'stale callbacks must not overwrite a newer operation');
manager.finish(second, new Error('离线'));
assert.strictEqual(second.status, 'failed', 'errors must produce a failed operation');
assert(second.error.includes('离线'), 'failed operation must preserve its reason');

});
