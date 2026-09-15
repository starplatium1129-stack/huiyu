const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');
const {
  createCompanionEventDetector,
  EVENT_ROUTE,
  EVENT_NOTIFY_TITLE,
}: typeof import('../../src/utils/companionEvents.ts') = require('../../src/utils/companionEvents.ts');

function snapshot(overrides = {}) {
  return {
    imageCount: 0,
    services: { sdOnline: true, ttsOnline: true, ollamaOnline: true },
    ...overrides,
  };
}

test('首次 ingest 只建基线，不产生事件', () => {
  const detector = createCompanionEventDetector();
  assert.deepEqual(detector.ingest(snapshot()), []);
});

test('图片计数增加 → sd-done', () => {
  const detector = createCompanionEventDetector();
  detector.ingest(snapshot({ imageCount: 3 }));
  assert.deepEqual(detector.ingest(snapshot({ imageCount: 5 })), ['sd-done']);
  assert.deepEqual(detector.ingest(snapshot({ imageCount: 5 })), [], '计数不变不重复触发');
});

test('服务状态翻转 → service-back / service-down', () => {
  const detector = createCompanionEventDetector();
  detector.ingest(snapshot({ services: { sdOnline: false, ttsOnline: true, ollamaOnline: true } }));
  assert.deepEqual(
    detector.ingest(snapshot({ services: { sdOnline: true, ttsOnline: true, ollamaOnline: true } })),
    ['service-back'],
  );
  assert.deepEqual(
    detector.ingest(snapshot({ services: { sdOnline: true, ttsOnline: false, ollamaOnline: true } })),
    ['service-down'],
  );
  assert.deepEqual(
    detector.ingest(snapshot({ services: { sdOnline: false, ttsOnline: false, ollamaOnline: true } })),
    ['service-down'],
    'sd 掉线应报 service-down（tts 保持掉线不重复报）',
  );
});

test('reset 后重新建基线，不重复播报历史事件', () => {
  const detector = createCompanionEventDetector();
  detector.ingest(snapshot({ imageCount: 1 }));
  detector.ingest(snapshot({ imageCount: 2 }));
  detector.reset();
  assert.deepEqual(detector.ingest(snapshot({ imageCount: 2 })), [], 'reset 后同计数不播报');
});

test('事件路由与通知标题完整覆盖全部事件', () => {
  for (const event of ['sd-done', 'service-back', 'service-down']) {
    assert.ok(EVENT_ROUTE[event], `${event} 应有跳转路由`);
    assert.ok(EVENT_NOTIFY_TITLE[event], `${event} 应有通知标题`);
  }
  assert.equal(EVENT_ROUTE['sd-done'], '/gallery');
  assert.equal(EVENT_ROUTE['service-down'], '/control');
});
