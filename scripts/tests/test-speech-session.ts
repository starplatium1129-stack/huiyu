const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');
const { createSpeechSession }: typeof import('../../src/utils/speechSession.ts') = require('../../src/utils/speechSession.ts');
const {
  normalizeSpeechInputConfig,
  DEFAULT_SPEECH_INPUT_CONFIG,
}: typeof import('../../src/utils/speechInputConfig.ts') = require('../../src/utils/speechInputConfig.ts');

const READY = {
  ...DEFAULT_SPEECH_INPUT_CONFIG,
  enabled: true,
  endpoint: 'http://127.0.0.1:8000/v1',
  wakeEnabled: true,
  wakeWords: ['宁宁'],
  endWords: ['结束对话'],
};

test('初始：未启用配置时 disabled，不监听', () => {
  const session = createSpeechSession();
  session.applyConfig({ ...DEFAULT_SPEECH_INPUT_CONFIG, enabled: false });
  assert.equal(session.state(), 'disabled');
  assert.equal(session.shouldAutoListen(), false);
});

test('启用唤醒：进入 waitingForWake 并自动监听', () => {
  const session = createSpeechSession();
  session.applyConfig(READY);
  assert.equal(session.state(), 'waitingForWake');
  assert.equal(session.shouldAutoListen(), true);
  assert.equal(session.isSessionActive(), false);
});

test('命中唤醒词激活连续会话，未命中保持等待', () => {
  const session = createSpeechSession();
  session.applyConfig(READY);
  assert.equal(session.onWakeText('你好呀'), false);
  assert.equal(session.state(), 'waitingForWake');
  assert.equal(session.onWakeText('宁宁在吗'), true);
  assert.equal(session.state(), 'continuousReady');
  assert.equal(session.isSessionActive(), true);
});

test('唤醒词空表时按角色名兜底', () => {
  const session = createSpeechSession();
  session.applyConfig({ ...READY, wakeWords: [] }, '夏目');
  assert.equal(session.onWakeText('夏目，说话'), true);
});

test('会话内：普通文本提交，结束词退出，空文本忽略', () => {
  const session = createSpeechSession();
  session.applyConfig(READY);
  session.onWakeText('宁宁');
  assert.equal(session.onSessionText('  '), 'ignore');
  assert.equal(session.onSessionText('今天天气真好'), 'submit');
  assert.equal(session.state(), 'waitingForReply');

  // 回复完成后回到 continuousReady
  session.markReplyIdle();
  assert.equal(session.state(), 'continuousReady');
  assert.equal(session.onSessionText('结束对话'), 'end');
  assert.equal(session.state(), 'ending');

  // 最后一轮回复完成后回到等待唤醒
  session.markReplyIdle();
  assert.equal(session.state(), 'waitingForWake');
  assert.equal(session.isSessionActive(), false);

});

test('endSession 立即退出会话', () => {
  const session = createSpeechSession();
  session.applyConfig(READY);
  session.onWakeText('宁宁');
  assert.equal(session.isSessionActive(), true);
  session.endSession();
  assert.equal(session.state(), 'waitingForWake');
  assert.equal(session.isSessionActive(), false);
});

test('waitingForReply 期间不接收重复提交', () => {
  const session = createSpeechSession();
  session.applyConfig(READY);
  session.onWakeText('宁宁');
  session.onSessionText('说点什么');
  assert.equal(session.state(), 'waitingForReply');
  assert.equal(session.onSessionText('插话'), 'ignore');
});

test('未开启唤醒时手动长按可用但不自动监听', () => {
  const session = createSpeechSession();
  session.applyConfig({ ...READY, wakeEnabled: false });
  assert.equal(session.state(), 'disabled');
  assert.equal(session.shouldAutoListen(), false);
  assert.equal(session.onSessionText('手动说的话'), 'submit');
});

test('等待回复期间不自动监听，完成后回 continuousReady', () => {
  const session = createSpeechSession();
  session.applyConfig(READY);
  session.onWakeText('宁宁');
  session.onSessionText('讲个故事');
  assert.equal(session.shouldAutoListen(), false);
  assert.equal(session.state(), 'waitingForReply');
  session.markReplyIdle();
  assert.equal(session.state(), 'continuousReady');
  assert.equal(session.shouldAutoListen(), true);
});

test('endWords 非法时回退默认“结束对话”', () => {
  const session = createSpeechSession();
  session.applyConfig({ ...READY, endWords: [] });
  session.onWakeText('宁宁');
  assert.equal(session.onSessionText('结束对话'), 'end');
});

test('切换配置重置当前会话', () => {
  const session = createSpeechSession();
  session.applyConfig(READY);
  session.onWakeText('宁宁');
  session.onSessionText('你好');
  session.applyConfig({ ...READY, wakeWords: ['夏目'] });
  assert.equal(session.state(), 'waitingForWake');
  assert.equal(session.isSessionActive(), false);
  assert.equal(session.onWakeText('宁宁'), false);
  assert.equal(session.onWakeText('夏目'), true);
});

test('配置归一化：唤醒/结束词去重去空，endWords 空则默认', () => {
  const config = normalizeSpeechInputConfig({
    ...READY,
    wakeWords: ['宁宁', ' 宁宁 ', '', '小宁'],
    endWords: [],
  });
  assert.deepEqual(config.wakeWords, ['宁宁', '小宁']);
  assert.deepEqual(config.endWords, ['结束对话']);
  assert.equal(config.wakeEnabled, true);
});
