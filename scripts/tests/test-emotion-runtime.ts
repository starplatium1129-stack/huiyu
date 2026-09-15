const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');
const { createEmotionRuntime, NATSUME_RUNTIME_CONFIG, NENE_RUNTIME_CONFIG }: typeof import('../../src/utils/emotionRuntime.ts') = require('../../src/utils/emotionRuntime.ts');
const { createLive2dNativeAdapter, LIVE2D_NATIVE_POLICIES }: typeof import('../../src/utils/live2dNativeAdapter.ts') = require('../../src/utils/live2dNativeAdapter.ts');

test('neutral 初始：无表情参数、零强度', () => {
  const rt = createEmotionRuntime(NENE_RUNTIME_CONFIG);
  rt.update(1 / 60);
  assert.deepEqual(rt.targets(), {});
  assert.equal(rt.intensity(), 0);
  assert.equal(rt.lastEmotion(), 'neutral');
});

test('pushEmotion(happy)：表情参数出现、强度上升、随后自然衰减回零', () => {
  const rt = createEmotionRuntime(NENE_RUNTIME_CONFIG);
  rt.pushEmotion('happy');
  rt.update(1 / 60);
  const targets = rt.targets();
  assert(targets.ParamEyeLSmile > 0, 'happy 应带微笑眼参数');
  assert(targets.ParamMouthForm > 0, 'happy 应带嘴角上扬参数');
  assert(rt.intensity() > 0.3, '强度应显著上升');
  for (let i = 0; i < 60 * 60; i++) rt.update(1 / 60);
  assert.equal(rt.intensity(), 0, '长时间衰减后强度归零');
  assert.deepEqual(rt.targets(), {}, '强度归零后无表情参数');
});

test('neutral 句子沿用当前情绪，不重置 lastEmotion', () => {
  const rt = createEmotionRuntime(NENE_RUNTIME_CONFIG);
  rt.pushEmotion('sad');
  rt.update(1 / 60);
  rt.pushEmotion('neutral');
  rt.update(1 / 60);
  assert.equal(rt.lastEmotion(), 'sad', 'neutral 不改变情绪延续');
  assert(rt.targets().ParamCheek7 > 0, '悲伤表情应保持');
});

test('回合结束 neutral：表情立即开始淡出而不是保持满强度', () => {
  const rt = createEmotionRuntime(NENE_RUNTIME_CONFIG);
  rt.pushEmotion('happy');
  rt.update(1 / 60);
  const peak = rt.intensity();
  assert.equal(peak, 1, '情绪 nudge 后强度满');
  rt.pushEmotion('neutral');
  rt.update(1 / 60);
  const afterNeutral = rt.intensity();
  assert(afterNeutral < peak, `neutral 后强度应衰减 (${peak} -> ${afterNeutral})`);
  for (let i = 0; i < 60 * 8; i++) rt.update(1 / 60);
  assert.equal(rt.intensity(), 0, '8 秒后强度归零');
});

test('speaking 时表情权重降低（让位口型）', () => {
  const rt = createEmotionRuntime(NENE_RUNTIME_CONFIG);
  rt.pushEmotion('happy');
  rt.update(1 / 60);
  const idle = rt.targets().ParamEyeLSmile;
  rt.setSpeaking(true);
  rt.update(1 / 60);
  const speaking = rt.targets().ParamEyeLSmile;
  assert(idle > 0 && speaking > 0 && speaking < idle, `说话权重应更低 (${idle} -> ${speaking})`);
  rt.setSpeaking(false);
});

test('onUserMessage 反应脉冲：期待眼珠短暂出现后消失', () => {
  const rt = createEmotionRuntime(NENE_RUNTIME_CONFIG);
  rt.onUserMessage();
  rt.update(1 / 60);
  assert(rt.targets().ParamCheek8 > 0, '用户消息后应短暂出现期待眼珠');
  for (let i = 0; i < 60 * 3; i++) rt.update(1 / 60);
  assert(!('ParamCheek8' in rt.targets()), '脉冲结束后期待眼珠消失');
});

test('情绪切换：参数表跟随最近非 neutral 情绪', () => {
  const rt = createEmotionRuntime(NENE_RUNTIME_CONFIG);
  rt.pushEmotion('shy');
  rt.update(1 / 60);
  assert(rt.targets().ParamCheek5 > 0, 'shy 应带害羞零件');
  assert(rt.targets().ParamCheek > 0, 'shy 应带脸红');
  rt.pushEmotion('serious');
  rt.update(1 / 60);
  assert.equal(rt.lastEmotion(), 'serious');
  assert(rt.targets().ParamBrowLForm < 0, 'serious 应皱眉');
  assert(!('ParamCheek5' in rt.targets()) || rt.targets().ParamCheek5 === 0, '害羞零件应收起');
});

test('reset：清空情绪与脉冲', () => {
  const rt = createEmotionRuntime(NENE_RUNTIME_CONFIG);
  rt.pushEmotion('sad');
  rt.onUserMessage();
  rt.update(1 / 60);
  rt.reset();
  rt.update(1 / 60);
  assert.equal(rt.lastEmotion(), 'neutral');
  assert.deepEqual(rt.targets(), {});
});

test('各情绪参数值不越界（-1..1）', () => {
  const rt = createEmotionRuntime(NENE_RUNTIME_CONFIG);
  for (const emotion of ['shy', 'happy', 'sad', 'serious', 'gentle']) {
    rt.pushEmotion(emotion);
    rt.update(1 / 60);
    for (const value of Object.values(rt.targets())) {
      assert(value >= -1 && value <= 1, `${emotion} 参数越界: ${value}`);
    }
    rt.reset();
  }
});

test('夏目配置：只驱动标准参数，绝不触碰口型与眨眼参数', () => {
  const rt = createEmotionRuntime(NATSUME_RUNTIME_CONFIG);
  const forbidden = ['ParamMouthOpenY', 'ParamMouthForm3', 'ParamEyeLOpen', 'ParamEyeLOpen2', 'ParamBodyAngleZ2'];
  for (const emotion of ['shy', 'happy', 'sad', 'serious', 'gentle']) {
    rt.pushEmotion(emotion);
    rt.update(1 / 60);
    for (const id of Object.keys(rt.targets())) {
      assert(!forbidden.includes(id), `${emotion} 触碰了受保护参数 ${id}`);
      assert(id.startsWith('ParamCheek') || id.startsWith('ParamBrow'), `夏目只能驱动 ParamCheek/ParamBrow，发现 ${id}`);
    }
    rt.reset();
  }
});

test('夏目配置：shy 带脸红，serious 皱眉', () => {
  const rt = createEmotionRuntime(NATSUME_RUNTIME_CONFIG);
  rt.pushEmotion('shy');
  rt.update(1 / 60);
  assert(rt.targets().ParamCheek > 0, '夏目 shy 应脸红');
  rt.reset();
  rt.pushEmotion('serious');
  rt.update(1 / 60);
  assert(rt.targets().ParamBrowLForm < 0, '夏目 serious 应皱眉');
});

test('宁宁配置：真实 Soullink engine 输出连续头身微动参数', async () => {
  const rt = createEmotionRuntime(NENE_RUNTIME_CONFIG);
  await rt.activate();
  rt.pushEmotion('happy');
  for (let i = 0; i < 30; i++) rt.update(1 / 60);
  const targets = rt.performanceTargets();
  assert('ParamAngleX' in targets, 'Soullink 应输出头部 X 参数');
  assert('ParamBodyAngleX' in targets, 'Soullink 应输出身体 X 参数');
  assert('ParamEyeBallX' in targets, 'Soullink 应输出视线参数');
});

test('夏目配置：Soullink 只输出安全的头身、视线与眉毛参数', async () => {
  const rt = createEmotionRuntime(NATSUME_RUNTIME_CONFIG);
  await rt.activate();
  rt.pushEmotion('gentle');
  for (let i = 0; i < 30; i++) rt.update(1 / 60);
  const targets = rt.performanceTargets();
  assert('ParamAngleX' in targets, '夏目 Soullink 应输出头部参数');
  assert('ParamBodyAngleX' in targets, '夏目 Soullink 应输出身体参数');
  assert('ParamEyeBallX' in targets, '夏目 Soullink 应输出视线参数');
  for (const id of Object.keys(targets)) {
    assert(!['ParamMouthForm3', 'ParamEyeLOpen', 'ParamEyeLOpen2'].includes(id), `Soullink 触碰了夏目受保护参数 ${id}`);
  }
});

test('原生动画策略：宁宁衣装与现有点击动作绝不作为情绪动画', async () => {
  assert.deepEqual(LIVE2D_NATIVE_POLICIES.nene.expressions, []);
  assert.deepEqual(LIVE2D_NATIVE_POLICIES.nene.motions, []);
  assert.deepEqual(LIVE2D_NATIVE_POLICIES.natsume.expressions, []);
  assert.deepEqual(LIVE2D_NATIVE_POLICIES.natsume.motions, []);
  const calls: any = [];
  const model = {
    expression: async (name: any) => { calls.push(['expression', name]); return true; },
    motion: async (group: any, index: any, priority: any) => { calls.push(['motion', group, index, priority]); return true; },
  };
  const adapter = createLive2dNativeAdapter();
  assert.equal(await adapter.apply({ token: 1, expression: 'expression1', motion: null, suppressParamIds: [] }, model, 'nene'), false);
  assert.equal(await adapter.apply({ token: 2, expression: null, motion: { group: 'TapHead', index: 0, priority: 'force' }, suppressParamIds: [] }, model, 'nene'), false);
  assert.deepEqual(calls, []);
});

test('原生动画 adapter：只执行角色白名单动作并转换优先级', async () => {
  const calls: any = [];
  const adapter = createLive2dNativeAdapter({
    test: {
      expressions: [],
      motions: [{ group: 'EmotionHappy', index: 1, priority: 'normal', maxDurationMs: 1000, suppressParamIds: ['ParamAngleX'] }],
    },
  });
  const model = {
    motion: async (group: any, index: any, priority: any) => { calls.push([group, index, priority]); return true; },
  };
  const started = await adapter.apply({
    token: 3,
    expression: null,
    motion: { group: 'EmotionHappy', index: 1, priority: 'normal' },
    suppressParamIds: ['ParamAngleX'],
  }, model, 'test');
  assert.equal(started, true);
  assert.deepEqual(calls, [['EmotionHappy', 1, 2]]);
  assert.deepEqual([...adapter.activeSuppressedParamIds()], ['ParamAngleX']);
  assert.equal(await adapter.apply({
    token: 3,
    expression: null,
    motion: { group: 'EmotionHappy', index: 1, priority: 'normal' },
    suppressParamIds: ['ParamAngleX'],
  }, model, 'test'), false, '同 token 不得重复启动');
  adapter.reset();
  assert.deepEqual([...adapter.activeSuppressedParamIds()], []);
});
