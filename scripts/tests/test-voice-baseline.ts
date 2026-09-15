'use strict';

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const quality: typeof import('../lib/wav-quality') = require('../lib/wav-quality');

const { test }: typeof import('node:test') = require('node:test');

test("VOICE_BASELINE_LIVE=1 set: offline structure checks passed; use scripts/maintenance/check-voice-baseline.js for live capture.", () => {
const root = path.resolve(__dirname, '..', '..');
const baselinePath = path.join(root, 'scripts', 'fixtures', 'voice-baseline.json');
const metricsPath = path.join(root, 'scripts', 'fixtures', 'voice-baseline-metrics.json');
const characters: typeof import('../../data/characters.json') = require('../../data/characters.json');

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const metricsDoc = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));

assert.strictEqual(baseline.version, 1, 'baseline catalog must declare version 1');
assert(Array.isArray(baseline.lines) && baseline.lines.length >= 4, 'baseline must cover at least 4 fixed lines');
assert(Array.isArray(baseline.listenChecklist) && baseline.listenChecklist.length >= 4, 'listen checklist required');
assert(baseline.thresholds && typeof baseline.thresholds === 'object', 'thresholds object required');

const requiredIds = ['nene-ja-neutral', 'nene-zh-neutral', 'natsume-ja-neutral', 'natsume-zh-neutral'];
const byId = new Map();
for (const line of baseline.lines) {
  assert(line.id && line.voice && line.language && line.emotion && line.text, 'each baseline line needs id/voice/language/emotion/text');
  assert(['nene', 'natsume'].includes(line.voice), 'voice must be nene or natsume');
  assert(['ja', 'zh'].includes(line.language), 'language must be ja or zh');
  assert(line.text.trim().length > 0, 'baseline text must be non-empty');
  assert(!byId.has(line.id), 'baseline line ids must be unique');
  byId.set(line.id, line);
}
for (const id of requiredIds) {
  assert(byId.has(id), 'missing required baseline line ' + id);
}

const nene = characters.find(function (item) { return item.id === 'nene'; });
const natsume = characters.find(function (item) { return item.id === 'natsume'; });
assert.strictEqual(byId.get('nene-ja-neutral').text, nene.voiceJa);
assert.strictEqual(byId.get('nene-zh-neutral').text, nene.voice);
assert.strictEqual(byId.get('natsume-ja-neutral').text, natsume.voiceJa);
assert.strictEqual(byId.get('natsume-zh-neutral').text, natsume.voice);

assert(metricsDoc.entries && typeof metricsDoc.entries === 'object', 'metrics entries required');
for (const id of requiredIds) {
  const entry = metricsDoc.entries[id];
  assert(entry, 'metrics missing entry for ' + id);
  assert(Number(entry.durationMs) > 0, id + ' duration must be positive');
  assert(Number(entry.rms) > 0, id + ' rms must be positive');
  assert(Number(entry.clippingRatio) >= 0, id + ' clippingRatio required');
  const gate = quality.assertVoiceQuality(entry, {
    minDurationMs: baseline.thresholds.minDurationMs,
    minRms: baseline.thresholds.minRms,
    maxClippingRatio: baseline.thresholds.maxClippingRatio,
    maxAbsDcOffset: baseline.thresholds.maxAbsDcOffset,
    maxLeadingSilenceMs: baseline.thresholds.maxLeadingSilenceMs,
    maxTrailingSilenceMs: baseline.thresholds.maxTrailingSilenceMs
  });
  assert.strictEqual(gate.length, 0, id + ' golden metrics must pass quality gate: ' + gate.join(', '));
}

function makeWav(seconds: number, amplitude: number) {
  const sampleRate = 24000;
  const frames = Math.round(sampleRate * seconds);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.sin(i / sampleRate * Math.PI * 2 * 220) * amplitude;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buffer;
}

const synthetic = quality.analyzeWav(makeWav(1, 0.25));
const compareIssues = quality.compareToBaseline(synthetic, {
  durationMs: synthetic.durationMs,
  rms: synthetic.rms,
  clippingRatio: 0
}, baseline.thresholds);
assert.strictEqual(compareIssues.length, 0, 'synthetic self-baseline compare must pass');

if (process.env.VOICE_BASELINE_LIVE === '1') {
  console.log('VOICE_BASELINE_LIVE=1 set: offline structure checks passed; use scripts/maintenance/check-voice-baseline.js for live capture.');
}

});
