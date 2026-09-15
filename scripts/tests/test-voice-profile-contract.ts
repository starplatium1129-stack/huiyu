'use strict';

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const tts: typeof import('../../services/tts-service') = require('../../services/tts-service');

const { test }: typeof import('node:test') = require('node:test');

test("Voice profile contract tests passed: VoiceProfile fields, validateInput, locked emotion refs", () => {
const root = path.resolve(__dirname, '..', '..');
// 契约源头是 tts-service.ts 的类型定义（validateInput 实际消费的形态）；
// 根目录 types/ 已迁移进 src/，这里直接断言后端契约本身。
const ttsSource = fs.readFileSync(path.join(root, 'services', 'tts-service.ts'), 'utf8');

const requiredVoiceFields = [
  'refAudioPath',
  'promptText',
  'promptLang',
  'textLang',
  'gptWeightsPath',
  'sovitsWeightsPath',
  'seed',
  'topK',
  'topP',
  'temperature'
];

for (const field of requiredVoiceFields) {
  assert(
    ttsSource.includes(field + '?') || ttsSource.includes(field + ':'),
    'VoiceProfile contract must declare ' + field
  );
}

assert(ttsSource.includes("type VoiceId = (typeof VOICES)[number]"), 'VoiceId must cover nene/natsume');
assert(ttsSource.includes("type VoiceEmotion"), 'VoiceEmotion must be declared');
assert(ttsSource.includes('interface VoiceTtsInput'), 'VoiceTtsInput must be declared');

const profiles = {
  nene: {
    refAudioPath: 'E:/voice/nene.wav',
    promptText: '気にしないで下さい。',
    promptLang: 'ja',
    textLang: 'ja',
    gptWeightsPath: 'E:/weights/nene.ckpt',
    sovitsWeightsPath: 'E:/weights/nene.pth',
    seed: 1234,
    topK: 15,
    topP: 1,
    temperature: 1,
    references: {
      happy: {
        refAudioPath: 'E:/voice/nene-happy.wav',
        promptText: '嬉しいです',
        promptLang: 'ja'
      }
    }
  }
};

const valid = tts.validateInput({
  voice: 'nene',
  language: 'ja',
  text: '気にしないで下さい。自分の分を毎日作ってますから',
  emotion: 'happy',
  consistency: 'locked',
  referenceEmotion: 'happy',
  speed: 1
}, profiles);
assert(!valid.error, 'valid TTS input must pass');
assert.strictEqual(valid.value!.payload.seed, 1234);
assert.strictEqual(valid.value!.payload.top_k, 15);
assert.strictEqual(valid.value!.payload.text_split_method, 'cut5');
assert.strictEqual(valid.value!.payload.ref_audio_path, profiles.nene.references.happy.refAudioPath);
assert.strictEqual(tts.normalizeSpeechText('\u30fb\u30c6\u30b9\u30c8', 'ja'), '\u30c6\u30b9\u30c8');

const neutral = tts.validateInput({
  voice: 'nene',
  language: 'ja',
  text: '平静的测试台词。',
  emotion: 'neutral',
  referenceEmotion: 'neutral',
  consistency: 'locked'
}, profiles);
assert(!neutral.error, 'neutral TTS input must pass');
assert.strictEqual(neutral.value!.payload.ref_audio_path, profiles.nene.refAudioPath, 'neutral path must use the character main ref');
assert.strictEqual(neutral.value!.payload.prompt_text, profiles.nene.promptText, 'neutral prompt must use the character main prompt');

const badVoice = tts.validateInput({ voice: 'unknown', text: 'hi', language: 'ja' }, profiles);
assert.strictEqual(badVoice.status, 400);
assert(String(badVoice.error).includes('声线'));

const emptyText = tts.validateInput({ voice: 'nene', text: '   ', language: 'ja' }, profiles);
assert.strictEqual(emptyText.status, 400);

const missingProfile = tts.validateInput({ voice: 'natsume', text: '测试', language: 'zh' }, profiles);
assert.strictEqual(missingProfile.status, 409);

const zhLocked = tts.validateInput({
  voice: 'nene',
  language: 'zh',
  text: '等、等等！刚才的事情不准说出去……绝对不准！',
  emotion: 'happy',
  consistency: 'locked',
  referenceEmotion: 'happy'
}, profiles);
assert(!zhLocked.error, 'Chinese input must still validate');
assert.strictEqual(zhLocked.value!.payload.ref_audio_path, profiles.nene.refAudioPath, 'Chinese path must use neutral main ref');

});
