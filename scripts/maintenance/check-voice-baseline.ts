'use strict';

/**
 * Opt-in live voice baseline capture/compare.
 * Requires local gateway + GPT-SoVITS.
 *
 *   VOICE_BASELINE_LIVE=1 node scripts/maintenance/check-voice-baseline.js
 *   VOICE_BASELINE_LIVE=1 VOICE_BASELINE_WRITE=1 node scripts/maintenance/check-voice-baseline.js
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');
const quality: typeof import('../lib/wav-quality') = require('../lib/wav-quality');

const root = path.resolve(__dirname, '..', '..');
const baselinePath = path.join(root, 'scripts', 'fixtures', 'voice-baseline.json');
const metricsPath = path.join(root, 'scripts', 'fixtures', 'voice-baseline-metrics.json');
const outDir = path.join(root, 'scripts', 'fixtures', 'voice-live');

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const metricsDoc = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
const host = process.env.VOICE_BASELINE_HOST || '127.0.0.1';
const port = Number(process.env.VOICE_BASELINE_PORT || 3000);
const write = process.env.VOICE_BASELINE_WRITE === '1';

if (process.env.VOICE_BASELINE_LIVE !== '1') {
  console.log('Set VOICE_BASELINE_LIVE=1 to hit /api/tts. Offline checks live in npm run test:voice-baseline.');
  process.exit(0);
}

function requestTts(line: any) {
  const body = JSON.stringify({
    voice: line.voice,
    language: line.language,
    text: line.text,
    emotion: line.emotion || 'neutral',
    referenceEmotion: line.emotion || 'neutral',
    consistency: line.consistency || 'locked',
    speed: line.speed == null ? 1 : line.speed
  });
  return new Promise<any>(function (resolve: any, reject: any) {
    const started = Date.now();
    let firstByteMs = 0;
    const req = http.request({
      host: host,
      port: port,
      path: '/api/tts',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, function (res: any) {
      const chunks: any = [];
      res.on('data', function (chunk: any) {
        if (!firstByteMs) firstByteMs = Date.now() - started;
        chunks.push(chunk);
      });
      res.on('end', function () {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('TTS HTTP ' + res.statusCode + ': ' + buffer.toString('utf8').slice(0, 200)));
          return;
        }
        resolve({
          buffer: buffer,
          firstByteMs: firstByteMs || (Date.now() - started),
          totalMs: Date.now() - started
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (write && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const nextEntries = Object.assign({}, metricsDoc.entries || {});
  const failures: any[] = [];

  for (const line of baseline.lines) {
    process.stdout.write('live ' + line.id + ' ... ');
    try {
      const result = await requestTts(line);
      const metrics: any = quality.analyzeWav(result.buffer);
      metrics.firstByteMs = result.firstByteMs;
      metrics.totalMs = result.totalMs;
      const gate = quality.assertVoiceQuality(metrics, baseline.thresholds);
      const golden = metricsDoc.entries && metricsDoc.entries[line.id];
      const drift = golden ? quality.compareToBaseline(metrics, golden, baseline.thresholds) : [];
      if (result.firstByteMs > baseline.thresholds.maxFirstByteMs) drift.push('firstByteMs above threshold');
      if (result.totalMs > baseline.thresholds.maxTotalMs) drift.push('totalMs above threshold');
      if (gate.length || drift.length) {
        failures.push({ id: line.id, gate: gate, drift: drift, metrics: metrics });
        console.log('FAIL');
      } else {
        console.log('ok (' + metrics.durationMs + 'ms, rms=' + metrics.rms + ')');
      }
      if (write) {
        fs.writeFileSync(path.join(outDir, line.id + '.wav'), result.buffer);
        nextEntries[line.id] = {
          durationMs: metrics.durationMs,
          rms: metrics.rms,
          peak: metrics.peak,
          silenceRatio: metrics.silenceRatio,
          clippingRatio: metrics.clippingRatio,
          dcOffset: metrics.dcOffset,
          leadingSilenceMs: metrics.leadingSilenceMs,
          trailingSilenceMs: metrics.trailingSilenceMs,
          firstByteMs: result.firstByteMs,
          totalMs: result.totalMs
        };
      }
    } catch (error: any) {
      failures.push({ id: line.id, error: String(error && error.message || error) });
      console.log('ERROR');
    }
  }

  if (write) {
    const nextDoc = {
      version: 1,
      status: failures.length ? 'provisional' : 'captured',
      note: 'Captured via check-voice-baseline.js. Complete listenChecklist before treating as final.',
      generatedAt: new Date().toISOString(),
      entries: nextEntries
    };
    fs.writeFileSync(metricsPath, JSON.stringify(nextDoc, null, 2) + '\n');
    console.log('Wrote metrics to ' + path.relative(root, metricsPath));
  }

  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exit(1);
  }
  console.log('Live voice baseline passed for ' + baseline.lines.length + ' lines');
}

main().catch(function (error: any) {
  console.error(error);
  process.exit(1);
});
