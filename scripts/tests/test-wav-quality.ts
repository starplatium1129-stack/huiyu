'use strict';

import assert = require('node:assert/strict');
const quality: typeof import('../lib/wav-quality') = require('../lib/wav-quality');

const { test }: typeof import('node:test') = require('node:test');

interface WavOptions {
  sampleRate?: number;
  seconds?: number;
  amplitude?: number;
  dc?: number;
}

function makeWav({ sampleRate = 24000, seconds = 1, amplitude = .25, dc = 0 }: WavOptions): Buffer {
  const frames = Math.round(sampleRate * seconds);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.max(-1, Math.min(1, Math.sin(i / sampleRate * Math.PI * 2 * 220) * amplitude + dc));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buffer;
}

test("WAV quality tests passed: format, duration, loudness, silence edges, clipping, DC and baseline compare", () => {
const healthy = quality.analyzeWav(makeWav({}));
assert.strictEqual(healthy.durationMs, 1000, 'duration must be derived from sample rate and frames');
assert(healthy.rms > .15 && healthy.rms < .2, 'RMS must describe signal loudness');
assert.strictEqual(healthy.leadingSilenceMs, 0, 'pure tone must not report leading silence');
assert.strictEqual(quality.assertVoiceQuality(healthy, {}).length, 0, 'healthy voice audio must pass');

const silent = quality.analyzeWav(makeWav({ amplitude:0 }));
assert(quality.assertVoiceQuality(silent, {}).includes('audio is effectively silent'), 'silence must fail the quality gate');
const biased = quality.analyzeWav(makeWav({ amplitude:.05, dc:.2 }));
assert(quality.assertVoiceQuality(biased, {}).includes('audio has excessive DC offset'), 'large DC offset must fail');
assert.throws(() => quality.analyzeWav(Buffer.from('not wav')), /invalid RIFF/, 'invalid audio must be rejected');

function makeLeadingSilenceWav(): Buffer {
  const sampleRate = 24000;
  const silenceFrames = Math.round(sampleRate * 1.2);
  const toneFrames = Math.round(sampleRate * 0.5);
  const frames = silenceFrames + toneFrames;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    const value = i < silenceFrames ? 0 : Math.sin((i - silenceFrames) / sampleRate * Math.PI * 2 * 220) * 0.25;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buffer;
}

const padded = quality.analyzeWav(makeLeadingSilenceWav());
assert(padded.leadingSilenceMs >= 1000, 'leading silence must be measured from the start');
assert(
  quality.assertVoiceQuality(padded, { maxLeadingSilenceMs: 500 }).includes('audio has excessive leading silence'),
  'optional leading silence gate must fail long pads'
);
assert.strictEqual(
  quality.compareToBaseline(healthy, { durationMs: healthy.durationMs, rms: healthy.rms, clippingRatio: 0 }, {}).length,
  0,
  'matching baseline must pass'
);
assert(
  quality.compareToBaseline(healthy, { durationMs: healthy.durationMs, rms: healthy.rms * 3, clippingRatio: 0 }, {})
    .includes('rms drifted from baseline'),
  'large RMS drift must fail baseline compare'
);

});
