/**
 * SD 错误分类测试 — 已迁移到 node:test。
 *
 * 迁移模式（其余 scripts/tests/*.js 照此办理）：
 * 1. 顶层断言包进 test('名称', () => {...})；
 * 2. 保持命令兼容：`node test-xxx.js` 直接可跑（node:test 默认执行本文件）；
 * 3. 失败时 node:test 给出用例名与断言位置，不再只抛一个裸 Error。
 */

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const sdError: typeof import('../../src/utils/sdError.ts') = require('../../src/utils/sdError.ts');

const source = fs.readFileSync(path.resolve(__dirname, '../../src/utils/sdError.ts'), 'utf8');
assert(!/\bany\b/.test(source), 'SD error parsing must keep unknown inputs narrowed');

function classify(error: any) { return sdError.classifySDError(error); }

test('分类：CUDA OOM -> oom + 降载重试', () => {
  assert.strictEqual(classify({ message: 'CUDA out of memory', status: 500 }).kind, 'oom');
});

test('分类：LoRA 缺失 -> 去掉 LoRA 重试', () => {
  assert.strictEqual(classify({ message: 'could not find lora ayachi_nene', status: 500 }).action!.id, 'retry_without_lora');
});

test('分类：checkpoint 缺失 -> 当前模型重试', () => {
  assert.strictEqual(classify({ detail: 'checkpoint not found', status: 500 }).action!.id, 'retry_current_model');
});

test('分类：sampler 错误 -> sampler', () => {
  assert.strictEqual(classify({ message: 'sampler not found', status: 400 }).kind, 'sampler');
});

test('分类：超时 -> 轻负载重试', () => {
  assert.strictEqual(classify({ name: 'TimeoutError', message: 'SD WebUI 请求超时' }).action!.id, 'retry_light');
});

test('分类：404 -> gateway', () => {
  assert.strictEqual(classify({ status: 404, message: 'HTTP 404' }).kind, 'gateway');
});

test('分类：网络错误 -> 重新检查连接', () => {
  assert.strictEqual(classify({ name: 'NetworkError', message: '无法连接 SD WebUI' }).action!.id, 'recheck_connection');
});

test('分类：取消 -> cancelled', () => {
  assert.strictEqual(classify({ name: 'AbortError', message: '已取消生成' }).kind, 'cancelled');
});

test('分类：参数错误 -> parameters', () => {
  assert.strictEqual(classify({ status: 400, detail: 'invalid request' }).kind, 'parameters');
});

test('分类：原始字符串也能分类', () => {
  assert.strictEqual(classify('CUDA out of memory').kind, 'oom');
});

test('分类：空值保持安全', () => {
  assert.strictEqual(classify(null).kind, 'unknown');
});
