'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const {
  getAffectionLevel,
  pickAffectionMotion,
}: typeof import('../../src/utils/companionAffection.ts') = require('../../src/utils/companionAffection.ts');

console.log('--- 测试 companionAffection 好感度与动作调度 ---');

// 1. 测试好感度等级区间
assert.strictEqual(getAffectionLevel(0).level, 1);
assert.strictEqual(getAffectionLevel(15).level, 1);
assert.strictEqual(getAffectionLevel(24).level, 1);
assert.strictEqual(getAffectionLevel(25).level, 2);
assert.strictEqual(getAffectionLevel(50).level, 3);
assert.strictEqual(getAffectionLevel(75).level, 4);
assert.strictEqual(getAffectionLevel(100).level, 5);
assert.strictEqual(getAffectionLevel(120).level, 5, '超范围应自动限制到 100');
console.log('✓ 1. 好感度等级划分正确');

// 2. 测试低好感度时无法触发 100 分专属动作
const lowScore = 15;
for (let i = 0; i < 50; i++) {
  const pseudoRandom = () => Math.random();
  const pickedHead = pickAffectionMotion('natsume', 'TapHead', lowScore, pseudoRandom);
  assert.ok(pickedHead, '应该选出动作');
  assert.ok(pickedHead.index >= 0 && pickedHead.index <= 3, '低好感度下绝不可选到 index=4 (萌萌Q 满分动作)');
  assert.notStrictEqual(pickedHead.entry.equalIntimacy, 100, '不应命中 100 分专属动作');

  const pickedHand = pickAffectionMotion('natsume', 'TapHand', lowScore, pseudoRandom);
  assert.ok(pickedHand, '应该选出动作');
  assert.strictEqual(pickedHand.index, 1, '低好感度下 TapHand 只能选 index=1 (普通互动)，不可选 index=0 (喝茶邀请)');
}
console.log('✓ 2. 低好感度动作门控拦截正确（无越权触发）');

// 3. 测试满好感度（100 分）时能够正常触发专属动作
let hitFullIntimacyAction = false;
for (let i = 0; i < 100; i++) {
  const pickedHead = pickAffectionMotion('natsume', 'TapHead', 100, () => Math.random());
  if (pickedHead && pickedHead.entry.equalIntimacy === 100) {
    hitFullIntimacyAction = true;
    assert.strictEqual(pickedHead.index, 4);
    assert.strictEqual(pickedHead.entry.text, '请主人和我一起来施展萌萌的魔法吧，来，跟我一起--萌萌Q');
    break;
  }
}
assert.ok(hitFullIntimacyAction, '满好感度下必须可触发满分专属动作');
console.log('✓ 3. 满好感度解锁专属高阶动作与告白台词');

// 4. 测试宁宁动作调度
const neneHead = pickAffectionMotion('nene', 'TapHead', 20, () => 0.1);
assert.ok(neneHead, '宁宁动作可正常调度');
assert.ok(neneHead.entry.bonus && neneHead.entry.bonus > 0, '宁宁摸头应带有好感度加成');
console.log('✓ 4. 宁宁专属好感度配置兼容良好');

// 无普通候选的组必须保持锁定，不能回退到首个满好感动作。
for (const [character, group] of [['natsume', 'TapFoot'], ['nene', 'TapLeftChest'], ['nene', 'TapRightChest']]) {
  assert.strictEqual(pickAffectionMotion(character, group, 15, () => 0), null);
  assert.strictEqual(pickAffectionMotion(character, group, 99, () => 0), null);
  assert.strictEqual(pickAffectionMotion!(character as any, group as any, 100, () => 0)!.entry.equalIntimacy, 100);
}
console.log('✓ 5. 整组锁定时不返回候选，达到门槛后解锁');
console.log('\nAll 5 tests passed successfully!');
