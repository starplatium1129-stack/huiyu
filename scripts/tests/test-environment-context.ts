const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');
const {
  timeSlotOf,
  isWeekend,
  pickEnvironmentGreeting,
}: typeof import('../../src/utils/environmentContext.ts') = require('../../src/utils/environmentContext.ts');

function at(hour: number|undefined, minute: any = 0, day: any = 3) {
  // 2026-08-05 是周三（weekday），2026-08-08 是周六（weekend）
  return new Date(2026, 7, day, hour, minute, 0, 0);
}

test('时间片划分覆盖全天', () => {
  assert.equal(timeSlotOf(at(2)), 'late-night');
  assert.equal(timeSlotOf(at(4, 59)), 'late-night');
  assert.equal(timeSlotOf(at(5)), 'early-morning');
  assert.equal(timeSlotOf(at(8, 59)), 'early-morning');
  assert.equal(timeSlotOf(at(9)), 'morning');
  assert.equal(timeSlotOf(at(11, 59)), 'morning');
  assert.equal(timeSlotOf(at(12)), 'noon');
  assert.equal(timeSlotOf(at(13, 59)), 'noon');
  assert.equal(timeSlotOf(at(14)), 'afternoon');
  assert.equal(timeSlotOf(at(17, 59)), 'afternoon');
  assert.equal(timeSlotOf(at(18)), 'evening');
  assert.equal(timeSlotOf(at(20, 59)), 'evening');
  assert.equal(timeSlotOf(at(21)), 'night');
  assert.equal(timeSlotOf(at(23, 59)), 'night');
});

test('周末判断：周三非周末，周六是周末', () => {
  assert.equal(isWeekend(at(10, 0, 5)), false, '2026-08-05 周三');
  assert.equal(isWeekend(at(10, 0, 8)), true, '2026-08-08 周六');
  assert.equal(isWeekend(at(10, 0, 9)), true, '2026-08-09 周日');
});

test('台词轮转：同一时间片不同 offset 不重复', () => {
  const a = pickEnvironmentGreeting('nene', at(15), 0).line;
  const b = pickEnvironmentGreeting('nene', at(15), 1).line;
  assert.notEqual(a, b, '宁宁下午应有至少两句台词');
});

test('未知角色回退默认台词', () => {
  const greeting = pickEnvironmentGreeting('unknown', at(10));
  assert.equal(greeting.slot, 'morning');
  assert.match(greeting.line, /上午好/);
});
