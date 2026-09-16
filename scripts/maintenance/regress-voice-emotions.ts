'use strict';

const fs: typeof import('fs') = require('fs');
const http: typeof import('http') = require('http');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const wavQuality: typeof import('../lib/wav-quality') = require('../lib/wav-quality');

const baseUrl = process.argv[2] || 'http://127.0.0.1:3000';
const emotions = ['neutral', 'gentle', 'happy', 'shy', 'serious', 'sad'];
const text = '今日もお疲れさまでした。ここで少し休んでいきませんか。';
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-voice-emotions-'));

function request(method: string, pathname: string|URL, payload: any) {
  return new Promise<any>((resolve: any, reject: any) => {
    const target = new URL(pathname, baseUrl);
    const body = payload == null ? null : JSON.stringify(payload);
    const req = http.request(target, {
      method,
      headers: body === null ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response: any) => {
      const chunks: any = [];
      response.on('data', (chunk: any) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(6 * 60 * 1000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end(body === null ? undefined : body);
  });
}

async function jsonRequest(method: string, pathname: string, payload?: any) {
  const response = await request(method, pathname, payload);
  let data: Record<string, any> = {};
  try { data = JSON.parse(response.body.toString('utf8') || '{}'); } catch {}
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${pathname} ${response.status}: ${data.error || response.body.toString('utf8').slice(0, 300)}`);
  }
  return data;
}

async function main() {
  const status = await jsonRequest('GET', '/api/tts-status', undefined);
  if (!status.online) throw new Error('GPT-SoVITS is offline');
  const results: any[] = [];

  for (const voice of ['nene', 'natsume']) {
    await jsonRequest('POST', '/api/voice/prepare', { voice, translation: false });
    for (const emotion of emotions) {
      const response = await request('POST', '/api/tts', {
        voice,
        language: 'ja',
        text,
        emotion,
        referenceEmotion: emotion,
        consistency: 'locked',
        speed: 1,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`${voice}/${emotion} TTS failed with ${response.status}`);
      }
      const file = path.join(outputDir, `${voice}-${emotion}.wav`);
      fs.writeFileSync(file, response.body);
      const audio = wavQuality.analyzeWav(response.body);
      const issues = wavQuality.assertVoiceQuality(audio, undefined);
      results.push({
        voice,
        emotion,
        file,
        durationMs: audio.durationMs,
        rms: audio.rms,
        peak: audio.peak,
        issues: issues.join('; '),
      });
      if (issues.length) throw new Error(`${voice}/${emotion}: ${issues.join('; ')}`);
    }
  }

  console.table(results);
  console.log(`Real GPT-SoVITS emotion clips written outside the repository: ${outputDir}`);
}

main().catch((error: any) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
