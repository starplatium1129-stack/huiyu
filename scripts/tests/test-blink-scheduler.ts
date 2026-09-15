const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');
const { createBlinkScheduler }: typeof import('../../src/utils/blinkScheduler.ts') = require('../../src/utils/blinkScheduler.ts');

test('初始状态：眼睛全睁，值不越界', () => {
  const blink = createBlinkScheduler();
  assert.equal(blink.value(), 1, '初始应全睁');
  blink.update(1 / 60);
  assert.equal(blink.value(), 1);
});

test('间隔到期后完成一次完整眨眼：闭眼 -> 保持闭合 -> 睁眼 -> 回到全睁', () => {
  // random() 恒 0 -> 间隔恒为 minIntervalMs = 2.5s
  const blink = createBlinkScheduler({ random: () => 0 });
  const closing = 0.09, closed = 0.06, opening = 0.16;
  const fps = 60, dt = 1 / fps;

  const samples = [];
  for (let i = 0; i < fps * 6; i++) {
    samples.push(blink.update(dt));
  }
  const closedSamples = samples.filter(v => v === 0);
  const openingSamples = samples.filter(v => v > 0 && v < 1);
  assert(closedSamples.length > 0, '应进入全闭阶段');
  assert(openingSamples.length > 0, '应经过半闭开眼阶段');
  assert.equal(blink.value(), 1, '眨眼完成后回到全睁');
  assert(samples.every(v => v >= 0 && v <= 1), '眨眼值必须在 0..1 内');

  // 首次眨眼：2.5s 间隔后开始，单次眨眼 0.31s
  const firstDip = samples.findIndex(v => v < 1);
  assert(Math.abs(firstDip * dt - 2.5) < 0.1,
    `首次眨眼应约在 2.5s，实测 ${(firstDip * dt).toFixed(2)}s`);
  const dipEnd = samples.slice(firstDip).findIndex(v => v === 1);
  assert(Math.abs(dipEnd * dt - (closing + closed + opening)) < 0.1,
    `单次眨眼时长应约 ${(closing + closed + opening).toFixed(2)}s，实测 ${(dipEnd * dt).toFixed(2)}s`);
});

test('随机间隔落在 min..max 区间内，重复眨眼', () => {
  const blink = createBlinkScheduler({ minIntervalMs: 2000, maxIntervalMs: 3000, random: () => 0.5 });
  const dips: number[] = [];
  let prev = blink.value();
  for (let i = 0; i < 60 * 30; i++) {
    const v = blink.update(1 / 60);
    if (prev === 1 && v < 1) dips.push(i / 60);
    prev = v;
  }
  assert(dips.length >= 3, `30 秒内应有多次眨眼，实测 ${dips.length} 次`);
  const gaps = dips.slice(1).map((t, i) => t - dips[i]);
  assert(gaps.every(g => g > 2.0 && g < 3.2), `间隔应在 2.0-3.2s 内，实测 ${gaps.join(',')}`);
});

test('reset：立即回到全睁并重新计时', () => {
  const blink = createBlinkScheduler({ random: () => 0 });
  for (let i = 0; i < 60 * 2; i++) blink.update(1 / 60);
  assert.equal(blink.value(), 1, '间隔期内保持全睁');
  for (let i = 0; i < 60; i++) blink.update(1 / 60); // 进入闭眼
  blink.reset();
  assert.equal(blink.value(), 1, 'reset 后必须全睁');
  for (let i = 0; i < 60 * 1.5; i++) blink.update(1 / 60);
  assert.equal(blink.value(), 1, 'reset 后重新计时，短时间内不应眨眼');
});

test('delta 超界被钳制，不会瞬间完成眨眼', () => {
  const blink = createBlinkScheduler({ random: () => 0 });
  blink.update(10);
  blink.update(10);
  blink.update(10);
  blink.update(10);
  assert(blink.value() >= 0 && blink.value() <= 1);
});
