import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
/**
 * 语音输入（ASR）配置：load/save/normalize，localStorage 持久化。
 *
 * 端点协议目前支持 OpenAI 兼容 /audio/transcriptions（whisper.cpp、
 * faster-whisper、OpenAI 等均兼容）；端点未配置时语音输入入口隐藏。
 *
 * 注意：SPEECH_INPUT_KEY 与 src/utils/storageKeys.ts 双源登记，
 * 由 test-vad-segmenter.js 断言两者一致；storageKeys 保持零依赖供
 * node:test 直测，不得反向 import 本模块。
 */

/** localStorage 键（storageKeys.ts 同步登记，测试校验一致性）。 */
export const SPEECH_INPUT_KEY = 'aics_speech_input_v1'

export type SpeechInputKind = 'openai'

export interface SpeechInputConfig {
  /** 语音输入总开关 */
  enabled: boolean
  /** 端点协议种类 */
  kind: SpeechInputKind
  /** 服务商基础地址（如 http://127.0.0.1:8000） */
  endpoint: string
  /** 模型名（OpenAI 兼容端点默认 whisper-1；本地服务按实际模型名配置） */
  model: string
  /** API Key（本地服务可留空） */
  apiKey: string
  /** 识别语种提示（如 ja；留空交给服务端自动判断） */
  language: string
  /** 识别结果是否直接发送（false 时填入输入框由用户确认） */
  autoSend: boolean
  /** 自动监听（唤醒词连续对话）：开启后空闲时持续监听，命中唤醒词激活会话 */
  wakeEnabled: boolean
  /** 唤醒词表（空时调用方按角色名兜底） */
  wakeWords: string[]
  /** 结束词表（会话内命中即退出连续对话） */
  endWords: string[]
}

export const DEFAULT_SPEECH_INPUT_CONFIG: SpeechInputConfig = {
  enabled: false,
  kind: 'openai',
  endpoint: '',
  model: 'whisper-1',
  apiKey: '',
  language: '',
  autoSend: false,
  wakeEnabled: false,
  wakeWords: [],
  endWords: ['结束对话'],
}

/** 从 raw（localStorage JSON 或未知对象）归一化为合法配置。 */
export function normalizeSpeechInputConfig(raw: unknown): SpeechInputConfig {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const base = { ...DEFAULT_SPEECH_INPUT_CONFIG }
  const wordList = (candidate: unknown): string[] => {
    if (!Array.isArray(candidate)) return []
    const words = candidate.filter((word): word is string => typeof word === 'string' && word.trim().length > 0)
      .map(word => word.trim())
    return [...new Set(words)]
  }
  const endWords = wordList(value.endWords)
  return {
    enabled: value.enabled === true,
    kind: value.kind === 'openai' ? 'openai' : base.kind,
    endpoint: typeof value.endpoint === 'string' ? value.endpoint.trim() : base.endpoint,
    model: typeof value.model === 'string' && value.model.trim()
      ? value.model.trim()
      : base.model,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : base.apiKey,
    language: typeof value.language === 'string' ? value.language.trim() : base.language,
    autoSend: value.autoSend === true,
    wakeEnabled: value.wakeEnabled === true,
    wakeWords: wordList(value.wakeWords),
    endWords: endWords.length > 0 ? endWords : base.endWords,
  }
}

/** 判断端点是否已配置且可用（决定语音按钮显隐）。 */
export function isSpeechInputReady(config: SpeechInputConfig): boolean {
  return config.enabled && /^https?:\/\//i.test(config.endpoint)
}

export interface KeyedStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultStorage(): KeyedStorage | null {
  return typeof globalThis.localStorage !== 'undefined' ? localStorage : null
}

/** 读取并归一化语音输入配置（无参数时读浏览器 localStorage，测试可注入 storage）。 */
export function loadSpeechInputConfig(storage?: KeyedStorage): SpeechInputConfig {
  const store = storage ?? defaultStorage()
  if (!store) return { ...DEFAULT_SPEECH_INPUT_CONFIG }
  const raw = store.getItem(SPEECH_INPUT_KEY)
  if (!raw) return { ...DEFAULT_SPEECH_INPUT_CONFIG }
  try {
    return normalizeSpeechInputConfig(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SPEECH_INPUT_CONFIG }
  }
}

export function saveSpeechInputConfig(config: SpeechInputConfig, storage?: KeyedStorage): void {
  const store = storage ?? defaultStorage()
  if (!store) return
  store.setItem(SPEECH_INPUT_KEY, JSON.stringify(normalizeSpeechInputConfig(config)))
}
