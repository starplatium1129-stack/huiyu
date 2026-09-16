'use strict';

let http: typeof import('http') = require('http');
let https: typeof import('https') = require('https');
let path: typeof import('path') = require('path');
let performance = (require('perf_hooks') as typeof import('perf_hooks')).performance;
let wavQuality: typeof import('../lib/wav-quality') = require('../lib/wav-quality');

let baseUrl = process.argv[2] || 'http://127.0.0.1:3000';
let directVoiceUrl = process.argv[3] || '';

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function timedRequest(method: string, pathname: string|URL, payload: any, origin: string|undefined) {
  return new Promise<any>(function (resolve: any, reject: any) {
    let target = new URL(pathname, origin || baseUrl);
    let body = payload == null ? null : JSON.stringify(payload);
    let transport = target.protocol === 'https:' ? https : http;
    let started = performance.now();
    let headersAt = 0;
    let firstByteAt = 0;
    let chunks: any = [];
    let bytes = 0;
    let request = transport.request(target, {
      method:method,
      headers:body === null ? {} : {
        'Content-Type':'application/json',
        'Content-Length':Buffer.byteLength(body)
      }
    }, function (response: any) {
      headersAt = performance.now();
      response.on('data', function (chunk: any) {
        if (!firstByteAt) firstByteAt = performance.now();
        bytes += chunk.length;
        chunks.push(chunk);
      });
      response.on('end', function () {
        let ended = performance.now();
        resolve({
          status:response.statusCode,
          headersMs:round(headersAt - started),
          firstByteMs:round((firstByteAt || ended) - started),
          totalMs:round(ended - started),
          bytes:bytes,
          body:Buffer.concat(chunks)
        });
      });
    });
    request.setTimeout(6 * 60 * 1000, function () {
      request.destroy(new Error('benchmark request timed out'));
    });
    request.on('error', reject);
    request.end(body === null ? undefined : body);
  });
}

async function jsonRequest(method: string, pathname: string, payload: any) {
  let result = await timedRequest(method, pathname, payload, undefined);
  let data: Record<string, any> = {};
  try { data = JSON.parse(result.body.toString('utf8') || '{}'); } catch (error) {}
  result.data = data;
  if (result.status < 200 || result.status >= 300) {
    throw new Error(pathname + ' returned ' + result.status + ': ' +
      (data.error || result.body.toString('utf8').slice(0, 300)));
  }
  return result;
}

function metric(label: string, result: any) {
  let output: any = {
    label:label,
    headers_ms:result.headersMs,
    first_audio_ms:result.firstByteMs,
    total_ms:result.totalMs,
    kib:round(result.bytes / 1024)
  };
  try {
    let audio = wavQuality.analyzeWav(result.body);
    output.duration_ms = audio.durationMs;
    output.rms = audio.rms;
    output.peak = audio.peak;
    output.silence = audio.silenceRatio;
    output.quality_issues = wavQuality.assertVoiceQuality(audio, undefined).join(', ');
  } catch (error) {}
  return output;
}

function voicePayload(voice: string, text: string, emotion: string) {
  return {
    voice:voice,
    language:'ja',
    text:text,
    emotion:emotion || 'neutral',
    speed:1
  };
}

async function main() {
  let status = await jsonRequest('GET', '/api/tts-status', undefined);
  console.log('Voice status:', JSON.stringify({
    online:status.data.online,
    voices:status.data.voices,
    translation:status.data.translation
  }));
  if (!status.data.online) throw new Error('GPT-SoVITS is not online');

  let results: any[] = [];
  let coldTranslation = await jsonRequest('POST', '/api/translate', {
    text:'今天也辛苦了。先休息一下吧。'
  });
  results.push(metric('translation cold', coldTranslation));
  let cachedTranslation = await jsonRequest('POST', '/api/translate', {
    text:'今天也辛苦了。先休息一下吧。'
  });
  results.push(metric('translation cached', cachedTranslation));
  let warmTranslation = await jsonRequest('POST', '/api/translate', {
    text:'不用着急，我会在这里陪着你。'
  });
  results.push(metric('translation warm', warmTranslation));

  let prepareNatsume = await jsonRequest('POST', '/api/voice/prepare', {
    voice:'natsume',
    translation:true
  });
  results.push(metric('prepare natsume', prepareNatsume));
  let natsume = await timedRequest('POST', '/api/tts',
    voicePayload('natsume', '今日もお疲れさま。少し休んだら？', 'gentle'), undefined);
  results.push(metric('TTS natsume prepared', natsume));

  let prepareNene = await jsonRequest('POST', '/api/voice/prepare', {
    voice:'nene',
    translation:true
  });
  results.push(metric('prepare nene switch', prepareNene));
  let neneSwitch = await timedRequest('POST', '/api/tts',
    voicePayload('nene', '今日もお疲れさまでした。少し休んでくださいね。', 'gentle'), undefined);
  results.push(metric('TTS nene prepared', neneSwitch));
  let neneWarm = await timedRequest('POST', '/api/tts',
    voicePayload('nene', '私がそばにいますから、安心してください。', 'gentle'), undefined);
  results.push(metric('TTS nene warm', neneWarm));

  if (directVoiceUrl) {
    let config = (require('../../server/config') as typeof import('../../server/config')).loadGatewayConfig(path.resolve(__dirname, '..', '..'), process.env);
    let profile: any = config.VOICE_PROFILES.nene;
    for (let mode = 0; mode <= 3; mode += 1) {
      let direct = await timedRequest('POST', '/tts', {
        text:'私がそばにいますから、安心してください。',
        text_lang:'ja',
        ref_audio_path:profile.references.gentle.refAudioPath,
        prompt_lang:profile.references.gentle.promptLang || 'ja',
        prompt_text:profile.references.gentle.promptText,
        text_split_method:'cut5',
        batch_size:1,
        split_bucket:true,
        speed_factor:1,
        media_type:'wav',
        streaming_mode:mode,
        parallel_infer:true
      }, directVoiceUrl);
      results.push(metric('direct TTS mode ' + mode, direct));
    }
    for (let minChunk of [8, 12]) {
      let lowLatency = await timedRequest('POST', '/tts', {
        text:'私がそばにいますから、安心してください。',
        text_lang:'ja',
        ref_audio_path:profile.references.gentle.refAudioPath,
        prompt_lang:profile.references.gentle.promptLang || 'ja',
        prompt_text:profile.references.gentle.promptText,
        text_split_method:'cut5',
        batch_size:1,
        split_bucket:false,
        speed_factor:1,
        fragment_interval:0.15,
        media_type:'wav',
        streaming_mode:2,
        parallel_infer:false,
        overlap_length:2,
        min_chunk_length:minChunk
      }, directVoiceUrl);
      results.push(metric('mode 2 min chunk ' + minChunk, lowLatency));
    }
  }

  let sceneStarted = performance.now();
  let sceneFirstByte = 0;
  let sceneBytes = 0;
  let sceneLines = [
    '今日は一緒に来てくれて、ありがとうございます。',
    'この景色を見ていると、不思議と落ち着きますね。',
    'もう少しだけ、ここにいてもいいですか？'
  ];
  for (let i = 0; i < sceneLines.length; i += 1) {
    let segment = await timedRequest('POST', '/api/tts',
      voicePayload('nene', sceneLines[i], i === 2 ? 'shy' : 'gentle'), undefined);
    if (!sceneFirstByte) sceneFirstByte = sceneStarted + segment.firstByteMs;
    sceneBytes += segment.bytes;
  }
  let sceneEnded = performance.now();
  results.push({
    label:'scene 3 segments sequential',
    headers_ms:'-',
    first_audio_ms:round(sceneFirstByte - sceneStarted),
    total_ms:round(sceneEnded - sceneStarted),
    kib:round(sceneBytes / 1024)
  });

  console.table(results);
}

main().catch(function (error: any) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
