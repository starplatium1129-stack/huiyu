'use strict';

import type { IncomingMessage, ClientRequest } from 'http';
import SerialQueue = require('./serial-queue');
import httpClient = require('./http-client');

const VOICES = ['nene', 'natsume'] as const;
const LANGUAGES = ['ja', 'zh'] as const;
const EMOTIONS = ['neutral', 'gentle', 'happy', 'shy', 'serious', 'sad'] as const;

type VoiceId = (typeof VOICES)[number];
type VoiceEmotion = (typeof EMOTIONS)[number];
type VoiceConsistency = 'locked' | 'adaptive';

interface VoiceEmotionReference {
  refAudioPath?: string;
  promptText?: string;
  promptLang?: string;
}

interface VoiceProfile {
  refAudioPath?: string;
  promptText?: string;
  promptLang?: string;
  textLang?: string;
  gptWeightsPath?: string;
  sovitsWeightsPath?: string;
  seed?: number;
  topK?: number;
  topP?: number;
  temperature?: number;
  references?: Partial<Record<VoiceEmotion, VoiceEmotionReference>>;
}

interface VoiceTtsInput {
  voice?: string;
  text?: string;
  language?: string;
  emotion?: string;
  referenceEmotion?: string;
  consistency?: string;
  speed?: number;
}

interface TtsPayload {
  text: string;
  text_lang: string;
  ref_audio_path: string;
  prompt_lang: string;
  prompt_text: string;
  text_split_method: string;
  batch_size: number;
  split_bucket: boolean;
  speed_factor: number;
  seed: number;
  top_k: number;
  top_p: number;
  temperature: number;
  parallel_infer: boolean;
  media_type: string;
  streaming_mode: boolean;
}

interface ValidatedTtsInput {
  voice: VoiceId;
  profile: VoiceProfile;
  consistency: VoiceConsistency;
  referenceEmotion: string;
  payload: TtsPayload;
}

interface ValidationError {
  error: string;
  status: number;
  value?: undefined;
}

interface ValidationSuccess {
  error?: undefined;
  status?: undefined;
  value: ValidatedTtsInput;
}

type ValidationResult = ValidationError | ValidationSuccess;

interface StatusError extends Error {
  status: number;
}

interface StreamResponseMeta {
  response: IncomingMessage;
  request: ClientRequest;
  contentType: string;
  queueWaitMs: number;
}

interface StreamOptions {
  signal?: AbortSignal;
  onResponse?: (meta: StreamResponseMeta) => void | Promise<void>;
}

interface TtsServiceOptions {
  host: string;
  profiles?: Record<string, VoiceProfile | undefined>;
}

interface QueueWaitResult {
  queueWaitMs: number;
}

interface PrepareResult {
  voice: string;
  queueWaitMs: number;
}

interface TtsStatus {
  online: boolean;
  engine: string;
  voices: Record<string, boolean>;
  activeVoice: string;
  queue: { name: string; active: number; pending: number };
}

function normalizeSpeechText(value: unknown, language: string): string {
  let text = String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, '')
    // GPT-SoVITS' Windows-side Japanese tokenizer can fail while logging U+30FB
    // through a GBK console.  It is an emphasis separator, not spoken content.
    .replace(/\u30fb/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '。')
    .replace(/。{2,}/g, '。')
    .trim();
  if (language === 'ja') {
    text = text
      .replace(/绫地宁宁|綾地寧々|綾地寧寧/g, 'あやち ねね')
      .replace(/四季夏目|四季ナツメ/g, 'しき なつめ')
      .replace(/\.\.\.|…{2,}/g, '……');
  }
  return text;
}

function validateInput(
  input: VoiceTtsInput | null | undefined,
  profiles: Record<string, VoiceProfile | undefined>
): ValidationResult {
  const voice = String((input && input.voice) || '');
  const rawText = String((input && input.text) || '').trim();
  const language = String((input && input.language) || 'ja').toLowerCase();
  let emotion = String((input && input.emotion) || 'neutral').toLowerCase();
  let consistency = String((input && input.consistency) || 'adaptive').toLowerCase();
  let referenceEmotion = String((input && input.referenceEmotion) || emotion).toLowerCase();
  let speed = Number(input && input.speed);

  if (!(VOICES as readonly string[]).includes(voice)) {
    return { error: '不支持的角色声线', status: 400 };
  }
  if (!(LANGUAGES as readonly string[]).includes(language)) {
    return { error: '语音语言仅支持日语或中文', status: 400 };
  }
  if (!rawText || rawText.length > 2000) {
    return { error: '台词长度必须在 1—2000 字之间', status: 400 };
  }
  const profile = profiles[voice] ? structuredClone(profiles[voice]) : undefined;
  if (!profile || !profile.refAudioPath || !profile.promptText) {
    return { error: '该角色尚未在启动控制面板配置 GPT-SoVITS 参考音频', status: 409 };
  }
  if (!(EMOTIONS as readonly string[]).includes(emotion)) emotion = 'neutral';
  if (!(EMOTIONS as readonly string[]).includes(referenceEmotion)) referenceEmotion = emotion;
  if (consistency !== 'locked') consistency = 'adaptive';
  if (!Number.isFinite(speed)) speed = 1;
  speed = Math.max(0.75, Math.min(1.35, speed));

  const text = normalizeSpeechText(rawText, language);
  if (!text) return { error: '台词规范化后为空', status: 400 };

  const referenceKey = consistency === 'locked' ? referenceEmotion : emotion;
  const emotionReference =
    language === 'ja' && profile.references
      ? profile.references[referenceKey as VoiceEmotion]
      : undefined;
  const seed = Number.isFinite(Number(profile.seed))
    ? Math.max(0, Math.min(2147483647, Math.round(Number(profile.seed))))
    : 1234;
  const topK = Number.isFinite(Number(profile.topK))
    ? Math.max(1, Math.min(100, Math.round(Number(profile.topK))))
    : 15;
  const topP = Number.isFinite(Number(profile.topP))
    ? Math.max(0.1, Math.min(1, Number(profile.topP)))
    : 1;
  const temperature = Number.isFinite(Number(profile.temperature))
    ? Math.max(0.1, Math.min(2, Number(profile.temperature)))
    : 1;

  return {
    value: {
      voice: voice as VoiceId,
      profile: profile,
      consistency: consistency as VoiceConsistency,
      referenceEmotion: referenceKey,
      payload: {
        text: text,
        text_lang: language,
        ref_audio_path: (emotionReference && emotionReference.refAudioPath) || profile.refAudioPath,
        prompt_lang: (emotionReference && emotionReference.promptLang) || profile.promptLang || 'ja',
        prompt_text: (emotionReference && emotionReference.promptText) || profile.promptText,
        // cut5 is the stable Japanese sentence splitter for the installed
        // GPT-SoVITS v2Pro/v2ProPlus API; cut0 rejects ordinary Japanese text.
        text_split_method: 'cut5',
        batch_size: 1,
        split_bucket: false,
        speed_factor: speed,
        seed: seed,
        top_k: topK,
        top_p: topP,
        temperature: temperature,
        parallel_infer: false,
        media_type: 'wav',
        streaming_mode: false
      }
    }
  };
}

function statusError(message: string, status: number): StatusError {
  const error = new Error(message) as StatusError;
  error.status = status;
  return error;
}

function createTtsService(options: TtsServiceOptions) {
  const queue = new SerialQueue('gpt-sovits');
  let activeGptWeights = '';
  let activeSoVitsWeights = '';
  let activeVoice = '';
  let activeHost = '';

  function voiceMap(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const id of VOICES) {
      const profile = options.profiles?.[id] || {};
      result[id] = !!(profile.refAudioPath && profile.promptText);
    }
    return result;
  }

  async function isOnline(signal?: AbortSignal): Promise<boolean> {
    const host = options.host;
    try {
      const result = await httpClient.request(host, '/docs', {
        timeoutMs: 1500,
        totalTimeoutMs: 1500,
        timeoutMessage: 'GPT-SoVITS status request timed out',
        signal: signal
      });
      await httpClient.readBody(result.response);
      const statusCode = result.response.statusCode || 0;
      return statusCode >= 200 && statusCode < 500;
    } catch (error) {
      if (httpClient.isAbortError(error)) throw error;
      return false;
    }
  }

  async function setWeights(host: string, pathname: string, signal?: AbortSignal): Promise<void> {
    await httpClient.expectSuccess(host, pathname, {
      timeoutMs: 30000,
      signal: signal
    });
  }

  async function activate(host: string, voice: string, profile: VoiceProfile, signal?: AbortSignal): Promise<void> {
    try {
      if (profile.sovitsWeightsPath && (host !== activeHost || profile.sovitsWeightsPath !== activeSoVitsWeights)) {
        await setWeights(
          host,
          '/set_sovits_weights?weights_path=' + encodeURIComponent(profile.sovitsWeightsPath),
          signal
        );
      }
      if (profile.gptWeightsPath && (host !== activeHost || profile.gptWeightsPath !== activeGptWeights)) {
        await setWeights(
          host,
          '/set_gpt_weights?weights_path=' + encodeURIComponent(profile.gptWeightsPath),
          signal
        );
      }
    } catch (error) {
      // A partial switch invalidates the previous voice too; returning to it
      // must restore both weights instead of trusting the last successful pair.
      activeHost = ''; activeGptWeights = ''; activeSoVitsWeights = ''; activeVoice = '';
      throw error;
    }
    activeSoVitsWeights = profile.sovitsWeightsPath || '';
    activeGptWeights = profile.gptWeightsPath || '';
    activeVoice = voice;
    activeHost = host;
  }

  function prepare(voice: string, signal?: AbortSignal): Promise<PrepareResult> {
    const voiceId = String(voice || '');
    const host = options.host;
    const profile = options.profiles?.[voiceId];
    if (
      !(VOICES as readonly string[]).includes(voiceId) ||
      !profile ||
      !profile.refAudioPath ||
      !profile.promptText
    ) {
      return Promise.reject(statusError('该角色尚未配置可用声线', 409));
    }
    const frozenProfile = structuredClone(profile);
    return queue.run(async function (queueMeta) {
      if (signal && signal.aborted) throw httpClient.abortError();
      await activate(host, voiceId, frozenProfile, signal);
      return { voice: voiceId, queueWaitMs: queueMeta.waitMs };
    }, { signal: signal });
  }

  function stream(input: VoiceTtsInput, optionsForStream?: StreamOptions): Promise<QueueWaitResult> {
    const streamOpts = optionsForStream || {};
    const host = options.host;
    const validation = validateInput(input, options.profiles || {});
    if (!validation.value) {
      return Promise.reject(statusError(validation.error || 'invalid TTS input', validation.status || 400));
    }

    const validated: ValidatedTtsInput = validation.value;
    return queue.run(async function (queueMeta) {
      if (streamOpts.signal && streamOpts.signal.aborted) throw httpClient.abortError();
      await activate(host, validated.voice, validated.profile, streamOpts.signal);
      const upstream = await httpClient.request(host, '/tts', {
        method: 'POST',
        json: validated.payload,
        // 单句 44 字内正常生成 10-30s；180s 上限覆盖排队（16 项队列）
        // 也足以兜住异常。5 分钟超时会卡死整条 GPU 队列 5 分钟，
        // 缩短后挂起的引擎更快失败并释放队列（客户端会自动提示重播）。
        timeoutMs: 180 * 1000,
        totalTimeoutMs: 180 * 1000,
        timeoutMessage: 'GPT-SoVITS 生成超时',
        signal: streamOpts.signal
      });

      const statusCode = upstream.response.statusCode || 0;
      if (statusCode < 200 || statusCode >= 300) {
        const errorBody = await httpClient.readBody(upstream.response, 1024 * 1024);
        throw new httpClient.UpstreamError('GPT-SoVITS returned ' + statusCode, {
          code: 'TTS_FAILED',
          status: statusCode,
          detail: errorBody.toString('utf8').slice(0, 500)
        });
      }

      if (streamOpts.onResponse) {
        await streamOpts.onResponse({
          response: upstream.response,
          request: upstream.request,
          contentType: upstream.response.headers['content-type'] || 'audio/wav',
          queueWaitMs: queueMeta.waitMs
        });
      } else {
        for await (const chunk of upstream.response) void chunk;
      }
      return { queueWaitMs: queueMeta.waitMs };
    }, { signal: streamOpts.signal });
  }

  async function status(signal?: AbortSignal): Promise<TtsStatus> {
    return {
      online: await isOnline(signal),
      engine: 'GPT-SoVITS',
      voices: voiceMap(),
      activeVoice: activeHost === options.host ? activeVoice : '',
      queue: queue.status()
    };
  }

  return {
    status: status,
    prepare: prepare,
    stream: stream,
    validate: function (input: VoiceTtsInput) {
      return validateInput(input, options.profiles || {});
    },
    queueStatus: function (): { name: string; active: number; pending: number } {
      return queue.status();
    }
  };
}

export = {
  createTtsService: createTtsService,
  validateInput: validateInput,
  normalizeSpeechText: normalizeSpeechText,
  VOICES: VOICES,
  LANGUAGES: LANGUAGES,
  EMOTIONS: EMOTIONS
};
