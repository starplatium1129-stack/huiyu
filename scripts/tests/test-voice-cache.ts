import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { once } from 'node:events';
import voice = require('../../routes/voice');

const wav = (marker: number) => {
  const bytes = Buffer.alloc(64); bytes.write('RIFF'); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(20, 40); bytes[44] = marker; return bytes;
};
const listen = (server: http.Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`)));
const close = (server: http.Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!check()) { assert.ok(Date.now() < deadline, 'voice fixture did not reach the expected request'); await new Promise<void>(resolve => setImmediate(resolve)); }
}
async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-voice-cache-'));
  const state = { payloads: [] as Array<{ ref_audio_path: string }>, hold: false,
    held: [] as Array<{ res: http.ServerResponse; audio: Buffer }>, requests: 0 };
  function backend(marker: number) {
    return http.createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        if (req.url !== '/tts') { res.end('ok'); return; }
        const payload = JSON.parse(body); state.payloads.push(payload);
        const audio = wav(marker + (payload.ref_audio_path === 'b.wav' ? 1 : 0));
        res.setHeader('Content-Type', 'audio/wav');
        if (state.hold) { state.held.push({ res, audio }); res.write(audio.subarray(0, 44)); }
        else res.end(audio);
      });
    });
  }
  const first = backend(1), second = backend(3);
  const firstUrl = await listen(first), secondUrl = await listen(second);
  const profile = (file: string) => ({ refAudioPath: file, promptText: 'fixture', gptWeightsPath: 'voice.ckpt', sovitsWeightsPath: 'voice.pth' });
  const config = { TTS_HOST: firstUrl, VOICE_PROFILES: { nene: profile('a.wav') }, TRANSLATE_URL: firstUrl, TRANSLATE_PORT: 1,
    TRANSLATION_PYTHON: path.join(root, 'unused-python'), TRANSLATION_SCRIPT: path.join(root, 'unused-script'), TRANSLATION_LOG: path.join(root, 'unused.log') };
  const router = voice.createVoiceRouter(config);
  const app = express(); app.use((req, _res, next) => { if (req.path === '/api/tts') state.requests++; next(); }); app.use(router.router);
  const server = http.createServer(app), url = await listen(server);
  t.after(async () => { router.close(); for (const item of state.held) item.res.destroy(); await close(server); await close(first); await close(second);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { state, config, profile, router, firstUrl, secondUrl, get: (text = 'fixture', signal?: AbortSignal) => fetch(url + '/api/tts?voice=nene&text=' + encodeURIComponent(text), { signal }) };
}

test('voice cache follows saved profiles and backend addresses without restarting the router', async t => {
  const f = await fixture(t);
  const first = await f.get(); assert.equal(first.headers.get('x-tts-cache'), 'miss');
  const audio = Buffer.from(await first.arrayBuffer()); assert.equal(audio.byteLength, 64); assert.equal(audio.readUInt32LE(4), 56);
  const repeat = await f.get(); assert.equal(repeat.headers.get('x-tts-cache'), 'hit'); await repeat.arrayBuffer(); assert.equal(f.state.payloads.length, 1);
  f.config.VOICE_PROFILES = { nene: f.profile('b.wav') };
  const changed = await f.get(); assert.equal(changed.headers.get('x-tts-cache'), 'miss'); assert.equal(Buffer.from(await changed.arrayBuffer())[44], 2);
  assert.equal(f.state.payloads.at(-1)!.ref_audio_path, 'b.wav');
  f.config.TTS_HOST = f.secondUrl;
  const moved = await f.get(); assert.equal(moved.headers.get('x-tts-cache'), 'miss'); assert.equal(Buffer.from(await moved.arrayBuffer())[44], 4);
});

test('shared voice generation survives one listener leaving and stops when its router closes', async t => {
  const f = await fixture(t); f.state.hold = true;
  const listener = new AbortController(); const first = f.get('shared', listener.signal).catch(error => error);
  await waitFor(() => f.state.held.length === 1);
  const second = f.get('shared'); await waitFor(() => f.state.requests === 2);
  listener.abort(); await first;
  const held = f.state.held.splice(0)[0]; held.res.end(held.audio.subarray(44));
  const response = await second; assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 64);
  assert.equal(f.state.payloads.length, 1);
  const closing = f.get('closing'); await waitFor(() => f.state.held.length === 1);
  const disconnected = once(f.state.held[0].res, 'close'); f.router.close();
  assert.equal((await closing).status, 503); await disconnected;
  assert.equal((await f.get('after-close')).status, 503);
});
