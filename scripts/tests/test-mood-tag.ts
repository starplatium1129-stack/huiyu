const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');
const { extractMoodTag, hasMoodTagOpen, MOOD_TAG_EMOTIONS }: typeof import('../../src/utils/moodTag.ts') = require('../../src/utils/moodTag.ts');
const { createEmotionRuntime, NENE_RUNTIME_CONFIG }: typeof import('../../src/utils/emotionRuntime.ts') = require('../../src/utils/emotionRuntime.ts');

test('无标签：原文不变，emotion 为 null', () => {
  const result = extractMoodTag('今天天气真好呀。');
  assert.equal(result.emotion, null);
  assert.equal(result.cleanText, '今天天气真好呀。');
});

test('行首标签：剥离标签并返回情绪', () => {
  const result = extractMoodTag('[mood=happy]今天天气真好呀！');
  assert.equal(result.emotion, 'happy');
  assert.equal(result.cleanText, '今天天气真好呀！');
});

test('冒号形式与大小写不敏感', () => {
  assert.equal(extractMoodTag('[mood:HAPPY] 你好').emotion, 'happy');
  assert.equal(extractMoodTag('[MOOD=Shy] 你好').emotion, 'shy');
});

test('标签在句中也剥离，情绪生效', () => {
  const result = extractMoodTag('先说一句 [mood=sad] 然后很难过。');
  assert.equal(result.emotion, 'sad');
  assert.equal(result.cleanText, '先说一句  然后很难过。');
});

test('多标签取最后一个合法值', () => {
  const result = extractMoodTag('[mood=happy]开头 [mood=serious]结尾');
  assert.equal(result.emotion, 'serious');
  assert.equal(result.cleanText, '开头 结尾');
});

test('非法情绪值：标签剥离但情绪不生效', () => {
  const result = extractMoodTag('[mood=excited]好兴奋！');
  assert.equal(result.emotion, null);
  assert.equal(result.cleanText, '好兴奋！', '非法标签不应泄漏到展示文本');
});

test('悬挂标签（未闭合）：剥离到末尾，情绪不生效', () => {
  const result = extractMoodTag('开头的话 [mood=hap');
  assert.equal(result.emotion, null);
  assert.equal(result.cleanText, '开头的话 ', '悬挂标签部分不应闪现');
});

test('流式增量：悬挂闭合后情绪生效且文本干净', () => {
  const first = extractMoodTag('开头的话 [mood=hap');
  assert.equal(first.emotion, null);
  const second = extractMoodTag('开头的话 [mood=happy]真高兴呀！');
  assert.equal(second.emotion, 'happy');
  assert.equal(second.cleanText, '开头的话 真高兴呀！');
});

test('标签中间有空白也识别', () => {
  const result = extractMoodTag('[mood = gentle]温柔地说');
  assert.equal(result.emotion, 'gentle');
  assert.equal(result.cleanText, '温柔地说');
});

test('mood 不是独立 token 时不误伤（如 [moodify]）', () => {
  const result = extractMoodTag('像 [moodify] 这样的词不应被剥离');
  assert.equal(result.emotion, null);
  assert.equal(result.cleanText, '像 [moodify] 这样的词不应被剥离');
});

test('MOOD_TAG_EMOTIONS 与 emotionRuntime 情绪可驱动一致', () => {
  const runtime = createEmotionRuntime(NENE_RUNTIME_CONFIG);
  for (const emotion of MOOD_TAG_EMOTIONS) {
    runtime.pushEmotion(emotion);
    runtime.update(1 / 60);
    // 只验证情绪名可被运行时接受（不会抛错）；neutral 沿用当前情绪。
    assert.equal(typeof runtime.lastEmotion(), 'string');
  }
});

test('hasMoodTagOpen：检测标签起点（含未闭合）', () => {
  assert.equal(hasMoodTagOpen('[mood=happy]'), true);
  assert.equal(hasMoodTagOpen('[mood=hap'), true);
  assert.equal(hasMoodTagOpen('普通文本 [moodify]'), false);
  assert.equal(hasMoodTagOpen('完全普通'), false);
});
