import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
/**
 * 语音输入（ASR）配置：load/save/normalize，localStorage 持久化。
 *
 * 端点协议目前支持 OpenAI 兼容 /audio/transcriptions（whisper.cpp、
 * faster-whisper、OpenAI 等均兼容）；端点未配置时语音输入入口隐藏。
 *
 * SPEECH_INPUT_KEY 与 storageKeys.ts 同步登记；持久化由 profile adapter 负责。
 */

/** profile 存储键（storageKeys.ts 同步登记）。 */
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
  return config.enabled && !speechInputEndpointError(config.endpoint)
}

export function speechInputEndpointError(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      return '请填写 HTTP(S) 服务地址，不要在地址中填写密钥、查询参数或片段。'
    }
    return ''
  } catch { return '请填写有效的语音识别服务地址，例如 http://127.0.0.1:8000/v1。' }
}

export interface KeyedStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 读取并归一化配置；读取/解析失败交由调用方展示重试，不能当作未配置。 */
export function loadSpeechInputConfig(storage?: KeyedStorage): SpeechInputConfig {
  // profile adapter 决定读取桌面权威缓存还是浏览器，避免先探测浏览器权限。
  const store = storage ?? localStorage
  const raw = store.getItem(SPEECH_INPUT_KEY)
  return normalizeSpeechInputConfig(raw === null ? null : JSON.parse(raw))
}

export function saveSpeechInputConfig(config: SpeechInputConfig, storage?: KeyedStorage): void {
  const store = storage ?? localStorage
  store.setItem(SPEECH_INPUT_KEY, JSON.stringify(normalizeSpeechInputConfig(config)))
}
