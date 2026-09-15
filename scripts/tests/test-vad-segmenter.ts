const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');
const { createVadSegmenter, rmsOf, normalizeVadConfig }: typeof import('../../src/utils/vadSegmenter.ts') = require('../../src/utils/vadSegmenter.ts');
const { encodeWav16k, resampleTo16k, buildAsrRequestParts }: typeof import('../../src/utils/voiceApi.ts') = require('../../src/utils/voiceApi.ts');
const {
  normalizeSpeechInputConfig,
  loadSpeechInputConfig,
  saveSpeechInputConfig,
  isSpeechInputReady,
  DEFAULT_SPEECH_INPUT_CONFIG,
  SPEECH_INPUT_KEY,
}: typeof import('../../src/utils/speechInputConfig.ts') = require('../../src/utils/speechInputConfig.ts');
const { LIVE_LOCAL_KEYS }: typeof import('../../src/utils/storageKeys.ts') = require('../../src/utils/storageKeys.ts');

const RATE = 16000;

test('useVoiceInput：取消 pending getUserMedia 不得恢复成后台采集', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'composables', 'useVoiceInput.ts'), 'utf8');
  assert.match(source, /let startToken = 0/);
  assert.match(source, /const token = \+\+startToken/);
  assert.match(source, /disposed \|\| canceled \|\| token !== startToken/);
  assert.match(source, /acquiredStream\.getTracks\(\)\).*track\.stop|for \(const track of acquiredStream\.getTracks\(\)\) track\.stop/);
  assert.match(source, /startToken \+= 1/); // 保持源码契约测试不依赖浏览器媒体设备
});

test('storageKeys 登记：语音输入键已进备份白名单', () => {
  assert(LIVE_LOCAL_KEYS.includes(SPEECH_INPUT_KEY), `aics_speech_input_v1 应登记在 LIVE_LOCAL_KEYS（实际 ${LIVE_LOCAL_KEYS.length} 个）`);
});

function makeNoise(seed: number, amplitude: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return ((s / 0xffffffff) * 2 - 1) * amplitude;
  };
}

function noiseBuffer(seconds: number, amplitude: number, seed: number) {
  const rng = makeNoise(seed, amplitude);
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = rng();
  return out;
}

function sineBuffer(seconds: number, freq = 440, amplitude = 0.3) {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / RATE) * amplitude;
  return out;
}

function concat(...buffers) {
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    out.set(buffer, offset);
    offset += buffer.length;
  }
  return out;
}

function sine() {
  return createVadSegmenter({ sampleRate: RATE });
}

test('rmsOf：纯正弦 0.3 幅度 RMS 约等于 0.3/sqrt(2)', () => {
  const samples = sineBuffer(0.1, 440, 0.3);
  const rms = rmsOf(samples, 0, samples.length);
  assert(Math.abs(rms - 0.3 / Math.SQRT2) < 0.01, `RMS 应约 0.212，实际 ${rms}`);
});

test('全静音不产出语音段', () => {
  const vad = sine();
  vad.push(new Float32Array(2 * RATE));
  assert.deepEqual(vad.takeSegments(), []);
  assert.equal(vad.inSpeech(), false);
});

test('短爆音（< minSpeechMs）被丢弃', () => {
  const vad = sine();
  vad.push(concat(noiseBuffer(0.5, 0.001, 1), sineBuffer(0.1, 440, 0.3), noiseBuffer(1.0, 0.001, 2)));
  assert.deepEqual(vad.takeSegments(), []);
});

test('单段语音产出带尾部 padding 的一段', () => {
  const vad = sine();
  vad.push(concat(noiseBuffer(1.0, 0.001, 1), sineBuffer(0.5, 440, 0.3), noiseBuffer(1.0, 0.001, 2)));
  const segments = vad.takeSegments();
  assert.equal(segments.length, 1);
  const ms = (segments[0].length / RATE) * 1000;
  // 弱起音回填约 60ms + 语音 500ms + 尾部 padding 约 200ms
  assert(ms >= 500 && ms <= 900, `段长应约 760ms，实际 ${ms}ms`);
});

test('两段语音间隔静音被切成两段', () => {
  const vad = sine();
  vad.push(concat(
    noiseBuffer(1.0, 0.001, 1),
    sineBuffer(0.3, 440, 0.3),
    noiseBuffer(0.8, 0.001, 2),
    sineBuffer(0.3, 440, 0.3),
    noiseBuffer(1.0, 0.001, 3),
  ));
  const segments = vad.takeSegments();
  assert.equal(segments.length, 2);
  for (const segment of segments) {
    assert(segment.length >= 0.25 * RATE, '每段不低于 minSpeechMs');
  }
});

test('段尾静音被裁剪（最后一段语音帧之后只留 padding）', () => {
  const vad = sine();
  const voice = sineBuffer(0.5, 440, 0.3);
  const silence = noiseBuffer(0.9, 0.001, 1);
  vad.push(concat(silence, voice, silence));
  const segments = vad.takeSegments();
  assert.equal(segments.length, 1);
  const ms = (segments[0].length / RATE) * 1000;
  assert(ms < 0.5 * 1000 + 0.9 * 1000, `段应被裁剪（不应含 900ms 尾静音），实际 ${ms}ms`);
  assert(ms >= 0.5 * 1000, `段不应短于语音本体，实际 ${ms}ms`);
});

test('超长语音按 maxSegmentMs 截断成多段', () => {
  const vad = sine();
  vad.push(sineBuffer(20, 440, 0.3));
  // 输入结束补尾静音让最后一截自然完结（与 useVoiceInput.stop 行为一致）。
  vad.push(noiseBuffer(1.0, 0.001, 5));
  const segments = vad.takeSegments();
  assert.equal(segments.length, 2);
  const firstMs = (segments[0].length / RATE) * 1000;
  assert(firstMs >= 14900 && firstMs <= 15100, `第一段应约 15s，实际 ${firstMs}ms`);
  const secondMs = (segments[1].length / RATE) * 1000;
  assert(secondMs >= 4800 && secondMs <= 5500, `第二段应约 5s，实际 ${secondMs}ms`);
});

test('reset 清空全部状态', () => {
  const vad = sine();
  vad.push(concat(noiseBuffer(0.5, 0.001, 1), sineBuffer(0.5, 440, 0.3), noiseBuffer(0.8, 0.001, 2)));
  assert(vad.inSpeech() || vad.takeSegments().length > 0);
  vad.reset();
  assert.deepEqual(vad.takeSegments(), []);
  assert.equal(vad.inSpeech(), false);
  vad.push(sineBuffer(0.5, 440, 0.3));
  assert.equal(vad.takeSegments().length, 0, 'reset 后校准应重新开始，短语音不产出');
});

test('噪声底自适应：低底噪环境下弱语音仍能检出', () => {
  const vad = createVadSegmenter({ sampleRate: RATE, threshold: 0.005 });
  // 校准期 300ms 低底噪（RMS≈0.0017），随后 0.01 幅度正弦（RMS≈0.007）应高于估计阈值。
  const floor = noiseBuffer(0.4, 0.003, 7);
  const voice = sineBuffer(0.5, 440, 0.01);
  const tail = noiseBuffer(0.8, 0.003, 8);
  vad.push(concat(floor, voice, tail));
  const segments = vad.takeSegments();
  assert.equal(segments.length, 1, `弱语音应被检出，实际 ${segments.length} 段`);
  const threshold = vad.effectiveThreshold();
  assert(threshold >= 0.005 && threshold < 0.01, `估计阈值应在 [0.005, 0.01)，实际 ${threshold}`);
});

test('开口即说话：校准被语音打断，语音不丢', () => {
  const vad = sine();
  vad.push(concat(sineBuffer(0.5, 440, 0.3), noiseBuffer(0.8, 0.001, 9)));
  const segments = vad.takeSegments();
  assert.equal(segments.length, 1, '校准期内的语音不应被当作噪声底');
  const ms = (segments[0].length / RATE) * 1000;
  assert(ms >= 0.5 * 1000, `段不应短于语音本体，实际 ${ms}ms`);
  assert.equal(vad.effectiveThreshold(), 0.02, '打断校准后阈值回到配置值');
});

test('takeSegments 消费语义：第二次取为空', () => {
  const vad = sine();
  vad.push(concat(noiseBuffer(0.5, 0.001, 1), sineBuffer(0.5, 440, 0.3), noiseBuffer(0.8, 0.001, 2)));
  assert.equal(vad.takeSegments().length, 1);
  assert.deepEqual(vad.takeSegments(), []);
});

test('不足一帧的输入安全累积，补齐后正常切分', () => {
  const vad = sine();
  vad.push(new Float32Array(50));
  assert.deepEqual(vad.takeSegments(), []);
  vad.push(concat(sineBuffer(0.5, 440, 0.3), noiseBuffer(0.8, 0.001, 1)));
  assert.equal(vad.takeSegments().length, 1);
});

test('normalizeVadConfig：非法值回退默认、合法值钳制', () => {
  const config = normalizeVadConfig({ sampleRate: 44100, threshold: 99, minSilenceMs: -1 });
  assert.equal(config.sampleRate, 44100);
  assert.equal(config.threshold, 1);
  assert.equal(config.minSilenceMs, 50);
  const fallback = normalizeVadConfig({ sampleRate: 0, frameMs: 0, maxSegmentMs: 10 });
  assert.equal(fallback.sampleRate, 8000, 'sampleRate 0 钳到下限 8000');
  assert.equal(fallback.frameMs, 5, 'frameMs 0 钳到下限 5');
  assert.equal(fallback.maxSegmentMs, 500);
});

test('encodeWav16k：WAV 头与 PCM16 采样正确', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 2, -2]);
  const wav = encodeWav16k(samples, 16000);
  assert.equal(wav.length, 44 + 5 * 2);
  const ascii = (offset: number, length: number) => {
    let text = '';
    for (let i = 0; i < length; i++) text += String.fromCharCode(wav[offset + i]);
    return text;
  };
  const view = new DataView(wav.buffer);
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint32(40, true), 10);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 16383);
  assert.equal(view.getInt16(48, true), -16384);
  assert.equal(view.getInt16(50, true), 32767, '越界钳制到正最大');
  assert.equal(view.getInt16(52, true), -32768, '越界钳制到负最大');
});

test('encodeWav16k：空数组输出 44 字节头', () => {
  const wav = encodeWav16k(new Float32Array(0), 16000);
  assert.equal(wav.length, 44);
});

test('resampleTo16k：48k 输入长度缩为 1/3 且首尾值近似', () => {
  const input = new Float32Array(48000);
  for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.3;
  const out = resampleTo16k(input, 48000);
  assert.equal(out.length, 16000);
  assert(Math.abs(out[0] - input[0]) < 0.05, `首点应近似 (${out[0]} vs ${input[0]})`);
  assert(Math.abs(out[8000] - input[24000]) < 0.05, `中点应近似 (${out[8000]} vs ${input[24000]})`);
});

test('resampleTo16k：已是 16k 时原样返回', () => {
  const input = new Float32Array(1600);
  assert.strictEqual(resampleTo16k(input, 16000), input);
});

test('buildAsrRequestParts：URL 拼接、去尾部斜杠、字段随语言配置', () => {
  const config = { ...DEFAULT_SPEECH_INPUT_CONFIG, endpoint: 'http://127.0.0.1:8000/v1/' };
  const parts = buildAsrRequestParts(config);
  assert.equal(parts.url, 'http://127.0.0.1:8000/v1/audio/transcriptions');
  assert.equal(parts.method, 'POST');
  assert.equal(parts.filename, 'speech.wav');
  assert.deepEqual(parts.formFields, [{ name: 'model', value: 'whisper-1' }]);

  const withLanguage = buildAsrRequestParts({ ...config, language: 'ja', model: 'local-model' });
  assert.deepEqual(withLanguage.formFields, [
    { name: 'model', value: 'local-model' },
    { name: 'language', value: 'ja' },
  ]);
});

test('speechInputConfig：normalize 非法值回退默认', () => {
  const config = normalizeSpeechInputConfig({ enabled: true, endpoint: '  ', kind: 'unknown', model: '', apiKey: 42, autoSend: 'yes' });
  assert.equal(config.enabled, true);
  assert.equal(config.kind, 'openai');
  assert.equal(config.endpoint, '');
  assert.equal(config.model, 'whisper-1');
  assert.equal(config.apiKey, '');
  assert.equal(config.autoSend, false);
  assert.deepEqual(normalizeSpeechInputConfig(null), DEFAULT_SPEECH_INPUT_CONFIG);
});

test('speechInputConfig：load 坏 JSON 回退默认，save 后 load 往返一致', () => {
  const storage = { map: new Map(), getItem(k: unknown) { return this.map.get(k) ?? null; }, setItem(k: unknown, v: unknown) { this.map.set(k, v); }, removeItem(k: unknown) { this.map.delete(k); } };
  storage.map.set('aics_speech_input_v1', '{broken');
  assert.deepEqual(loadSpeechInputConfig(storage), DEFAULT_SPEECH_INPUT_CONFIG);
  saveSpeechInputConfig({ ...DEFAULT_SPEECH_INPUT_CONFIG, enabled: true, endpoint: 'http://127.0.0.1:8000/v1' }, storage);
  const loaded = loadSpeechInputConfig(storage);
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.endpoint, 'http://127.0.0.1:8000/v1');
});

test('isSpeechInputReady：启用且 http 端点才算就绪', () => {
  assert.equal(isSpeechInputReady(DEFAULT_SPEECH_INPUT_CONFIG), false);
  assert.equal(isSpeechInputReady({ ...DEFAULT_SPEECH_INPUT_CONFIG, endpoint: 'http://127.0.0.1:8000' }), false, '未启用不算就绪');
  assert.equal(isSpeechInputReady({ ...DEFAULT_SPEECH_INPUT_CONFIG, enabled: true, endpoint: 'http://127.0.0.1:8000' }), true);
  assert.equal(isSpeechInputReady({ ...DEFAULT_SPEECH_INPUT_CONFIG, enabled: true, endpoint: 'ftp://x' }), false, '非 http 协议不算就绪');
});
