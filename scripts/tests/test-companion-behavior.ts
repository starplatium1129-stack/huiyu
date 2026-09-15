const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');
const {
  createCompanionBehavior,
  normalizeCompanionConfig,
  isInQuietHours,
  DEFAULT_COMPANION_CONFIG,
}: typeof import('../../src/utils/companionBehavior.ts') = require('../../src/utils/companionBehavior.ts');
const { resolveCompanionPresence }: typeof import('../../src/utils/companionPresence.ts') = require('../../src/utils/companionPresence.ts');

function minutesAgo(minutes: number, from = Date.now()) {
  return from - minutes * 60_000;
}

// 固定"白天非安静时段"基准，避免用例在 23:00-8:00 运行时被安静时段抑制
// （测试不得依赖真实时钟）。
const NOON = new Date(2026, 7, 3, 12, 0, 0).getTime();

test('配置归一化：非法值回退默认，合法值钳制到范围', () => {
  const normalized = normalizeCompanionConfig({ idleMinutes: 'x', cooldownMinutes: 9999, quietStartHour: -5, quietEndHour: 30, queueLimit: 0 });
  assert.equal(normalized.idleMinutes, DEFAULT_COMPANION_CONFIG.idleMinutes);
  assert.equal(normalized.cooldownMinutes, 24 * 60);
  assert.equal(normalized.quietStartHour, 0);
  assert.equal(normalized.quietEndHour, 23);
  assert.equal(normalized.queueLimit, 1);
  assert.deepEqual(normalizeCompanionConfig(null), DEFAULT_COMPANION_CONFIG);
});

test('安静时段判断：同一天内与跨天两种形态', () => {
  const day = new Date(2026, 7, 3, 10, 0, 0).getTime();
  assert.equal(isInQuietHours(day, 23, 8), false, '10 点不在 23-8 安静段');
  assert.equal(isInQuietHours(day, 8, 23), true, '10 点在 8-23 安静段');
  const night = new Date(2026, 7, 3, 23, 30, 0).getTime();
  assert.equal(isInQuietHours(night, 23, 8), true, '23:30 在 23-8 安静段');
  const dawn = new Date(2026, 7, 4, 3, 0, 0).getTime();
  assert.equal(isInQuietHours(dawn, 23, 8), true, '凌晨 3 点在 23-8 安静段');
  assert.equal(isInQuietHours(day, 23, 23), false, '起止相同视为未配置安静段');
});

test('idle 提醒：未到阈值不触发，超过阈值触发，冷却期内不重复', () => {
  const behavior = createCompanionBehavior({ idleMinutes: 30, cooldownMinutes: 20 });
  const base = new Date(2026, 7, 3, 10, 0, 0).getTime();
  behavior.noteActivity(base - 10 * 60_000);
  assert.equal(behavior.tick(base), null, '10 分钟无操作不应触发');
  behavior.noteActivity(base - 31 * 60_000);
  const reminder = behavior.tick(base);
  assert.ok(reminder, '31 分钟无操作应触发 idle 提醒');
  assert.equal(reminder.kind, 'idle');
  assert.equal(behavior.pending().length, 1);
  behavior.noteActivity(base - 10 * 60_000);
  behavior.noteActivity(base - 35 * 60_000);
  assert.equal(behavior.tick(base + 60_000), null, '冷却期内不应重复提醒');
  behavior.noteActivity(base - 60 * 60_000);
  assert.ok(behavior.tick(base + 21 * 60_000), '冷却结束后可再次提醒');
});

test('idleMinutes=0 关闭提醒', () => {
  const behavior = createCompanionBehavior({ idleMinutes: 0 });
  const base = new Date(2026, 7, 3, 10, 0, 0).getTime();
  behavior.noteActivity(base - 120 * 60_000);
  assert.equal(behavior.tick(base), null);
});

test('安静时段抑制 idle 提醒', () => {
  const quiet = new Date(2026, 7, 3, 23, 30, 0).getTime();
  const behavior = createCompanionBehavior({ idleMinutes: 5, quietStartHour: 23, quietEndHour: 8 });
  behavior.noteActivity(quiet - 10 * 60_000);
  assert.equal(behavior.tick(quiet), null, '安静时段不得产出提醒');
  assert.equal(behavior.pending().length, 0);
  const busy = new Date(2026, 7, 3, 10, 0, 0).getTime();
  behavior.noteActivity(busy - 10 * 60_000);
  assert.ok(behavior.tick(busy), '非安静时段正常产出');
});

test('勿扰：不产出新提醒，队列保留，关闭后继续出队', () => {
  const behavior = createCompanionBehavior({ idleMinutes: 1, cooldownMinutes: 0 });
  behavior.noteActivity(minutesAgo(5, NOON));
  const reminder = behavior.tick(NOON);
  assert.ok(reminder);
  behavior.setConfig({ dnd: true });
  assert.equal(behavior.isDnd(), true);
  assert.equal(behavior.tick(NOON), null, '勿扰中不再产出');
  assert.equal(behavior.pending().length, 1, '已有队列保留');
  assert.equal(behavior.dequeue(NOON), null, '勿扰中不得出队');
  behavior.setConfig({ dnd: false });
  const popped = behavior.dequeue(NOON);
  assert.equal(popped?.id, reminder.id, '关闭勿扰后按 FIFO 出队');
  assert.equal(behavior.pending().length, 0);
});

test('return 提醒：不受 idle/冷却约束，但受勿扰约束', () => {
  const behavior = createCompanionBehavior({ idleMinutes: 120, cooldownMinutes: 1000 });
  const reminder = behavior.noteReturn('欢迎回来。', NOON);
  assert.ok(reminder);
  assert.equal(reminder.kind, 'return');
  assert.equal(reminder.line, '欢迎回来。');
  behavior.setConfig({ dnd: true });
  assert.equal(behavior.noteReturn('回来啦。', NOON), null, '勿扰中 return 不产出');
});

test('队列容量上限：超限裁剪最早入队项', () => {
  const behavior = createCompanionBehavior({ idleMinutes: 1, cooldownMinutes: 0, queueLimit: 2 });
  behavior.noteReturn('a', NOON);
  behavior.noteReturn('b', NOON);
  behavior.noteReturn('c', NOON);
  const pending = behavior.pending();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].line, 'b', '队列裁剪应丢弃最早项');
  assert.equal(pending[1].line, 'c');
});

test('dismiss 移除指定提醒；clear 清空队列', () => {
  const behavior = createCompanionBehavior({ queueLimit: 5 });
  const first = behavior.noteReturn('one', NOON);
  const second = behavior.noteReturn('two', NOON);
  behavior.dismiss(first.id);
  assert.equal(behavior.pending().length, 1);
  assert.equal(behavior.pending()[0].id, second.id);
  behavior.clear();
  assert.equal(behavior.pending().length, 0);
});

test('cooldownRemainingMs：正数表示仍在冷却，负数表示可再次提醒', () => {
  const behavior = createCompanionBehavior({ cooldownMinutes: 10 });
  behavior.noteReturn('x', NOON);
  assert(behavior.cooldownRemainingMs(NOON) > 0, '提醒后应立即处于冷却');
  const later = behavior.cooldownRemainingMs(NOON + 11 * 60_000);
  assert(later < 0, '11 分钟后应过冷却');
});

test('enabled=false 时全部主动行为停摆', () => {
  const behavior = createCompanionBehavior({ enabled: false, idleMinutes: 1 });
  behavior.noteActivity(minutesAgo(5, NOON));
  assert.equal(behavior.tick(NOON), null);
  assert.equal(behavior.noteReturn('hi', NOON), null);
  assert.equal(behavior.pending().length, 0);
});

test('台词选取：无台词角色回退默认，负偏移安全取模', () => {
  const { pickCompanionLine }: typeof import('../../src/config/characters.ts') = require('../../src/config/characters.ts');
  assert.match(pickCompanionLine('nene', 'idle', 0), /。/);
  assert.match(pickCompanionLine('natsume', 'return', 1), /。/);
  assert.equal(pickCompanionLine('unknown', 'idle', 0), '……我在这里哦。');
  assert.equal(pickCompanionLine('nene', 'idle', -2), pickCompanionLine('nene', 'idle', 2));
  assert.match(pickCompanionLine('nene', 'event', 0, 'sd-done'), /图/);
  assert.match(pickCompanionLine('natsume', 'event', 0, 'service-back'), /。/);
  assert.equal(pickCompanionLine('unknown', 'event', 0, 'sd-done'), '有件事想告诉你……');
});

test('事件播报：入队 kind=event 且带 eventKind，不受 idle 冷却约束', () => {
  const behavior = createCompanionBehavior({ idleMinutes: 120, cooldownMinutes: 1000 });
  behavior.noteReturn('welcome', NOON);
  const reminder = behavior.noteEvent('sd-done', '新图做好啦！', NOON);
  assert.ok(reminder, '事件应入队');
  assert.equal(reminder.kind, 'event');
  assert.equal(reminder.eventKind, 'sd-done');
  assert.equal(behavior.pending().length, 2, '事件与 return 共存');
  behavior.noteReturn('welcome-again', NOON);
  assert.equal(behavior.pending().length, 3, '事件不消耗 idle 冷却（return 仍可入队）');
});

test('事件播报：同类事件按 eventCooldownMinutes 节流，不同类互不阻塞', () => {
  const base = new Date(2026, 7, 3, 10, 0, 0).getTime();
  const behavior = createCompanionBehavior({ eventCooldownMinutes: 10 });
  assert.ok(behavior.noteEvent('sd-done', 'a', base), '首次事件直接入队');
  assert.equal(behavior.noteEvent('sd-done', 'b', base + 60_000), null, '1 分钟后同类仍节流');
  assert.ok(behavior.noteEvent('service-back', 'c', base + 60_000), '不同类事件不受阻塞');
  assert.ok(behavior.noteEvent('sd-done', 'd', base + 11 * 60_000), '11 分钟后同类放行');
});

test('事件播报：安静时段与勿扰抑制，勿扰关闭后事件仍可入队', () => {
  const quiet = new Date(2026, 7, 3, 23, 30, 0).getTime();
  const behavior = createCompanionBehavior({ quietStartHour: 23, quietEndHour: 8 });
  assert.equal(behavior.noteEvent('sd-done', 'a', quiet), null, '安静时段不播报');
  behavior.setConfig({ dnd: true });
  const busy = new Date(2026, 7, 3, 10, 0, 0).getTime();
  assert.equal(behavior.noteEvent('sd-done', 'b', busy), null, '勿扰中不播报');
  behavior.setConfig({ dnd: false });
  assert.ok(behavior.noteEvent('sd-done', 'c', busy), '关闭勿扰后事件正常');
});

test('陪伴状态：安静优先，语音与会话状态按用户感知排序', () => {
  const base = {
    visible: true,
    dnd: false,
    quietHours: false,
    speaking: false,
    listening: false,
    thinking: false,
    composing: false,
    hasReminder: false,
  };
  assert.equal(resolveCompanionPresence(base).kind, 'available');
  assert.equal(resolveCompanionPresence({ ...base, hasReminder: true }).kind, 'reaching-out');
  assert.equal(resolveCompanionPresence({ ...base, composing: true, hasReminder: true }).kind, 'attentive');
  assert.equal(resolveCompanionPresence({ ...base, thinking: true, composing: true }).kind, 'thinking');
  assert.equal(resolveCompanionPresence({ ...base, listening: true, thinking: true }).kind, 'listening');
  assert.equal(resolveCompanionPresence({ ...base, speaking: true, listening: true }).kind, 'speaking');
  assert.equal(resolveCompanionPresence({ ...base, visible: false, speaking: true }).kind, 'quiet');
  assert.equal(resolveCompanionPresence({ ...base, dnd: true, speaking: true }).kind, 'quiet');
});
