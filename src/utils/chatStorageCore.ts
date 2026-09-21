export interface ChatStorageOptions {
  characterIds: string[]
  maxMessages: number
  version: number
  createMessageId: () => string
  normalizeOutfit?: (characterId: string, value: unknown) => string
}

export interface PersistedChatMessage {
  role: 'user' | 'assistant'
  content: string
  mid: string
  stopped: boolean
  recalledMemories?: string[]
}

export interface PersistedChatState {
  version: number
  /** Legacy global revision retained for older persisted records. */
  historiesRevision: number
  /** Per-character tombstone revisions for explicit history clears. */
  historiesRevisions: Record<string, number>
  active: string
  histories: Record<string, PersistedChatMessage[]>
  settings: {
    model: string
    provider: 'local' | 'api'
    apiBaseUrl: string
    apiModel: string
    apiKey: string
    apiConfiguredByUser?: boolean
    webSearchEnabled: boolean
    live2dEnabled: boolean
    live2dOutfit: string
    live2dOutfits: Record<string, string>
    autoVoice: boolean
    volume: number
    drafts: Record<string, string>
  }
}

const NENE_OUTFIT_IDS = new Set(['school', 'casual', 'sleepwear', 'cosplay', 'witch'])
const NATSUME_OUTFIT_IDS = new Set(['natsume-cafe'])

function legacyNormalizedOutfit(character: string, candidate: unknown): string {
  const outfit = text(candidate, 40)
  if (character === 'natsume') {
    return NATSUME_OUTFIT_IDS.has(outfit) ? outfit : 'natsume-cafe'
  }
  return NENE_OUTFIT_IDS.has(outfit) ? outfit : 'school'
}

export interface NormalizedChatStorage {
  state: PersistedChatState
  migratedApiKey: string
  /** 用户从未配置过 API（当前用的是开箱即用的兜底默认值）。
   *  此时站主托管配置应优先于兜底默认 —— 否则公网访客永远
   *  被默认值"伪装成已配置"，站主配置形同虚设。 */
  neverConfigured: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function normalizeMessages(
  value: unknown,
  maxMessages: number,
  createMessageId: () => string,
): PersistedChatMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((message): message is Record<string, unknown> =>
      isRecord(message) && (message.role === 'user' || message.role === 'assistant'))
    .map(message => {
      const recalled = Array.isArray(message.recalledMemories)
        ? message.recalledMemories.map(m => text(m, 240)).filter(Boolean).slice(0, 6)
        : undefined
      return {
        role: message.role as 'user' | 'assistant',
        content: text(message.content, 1200),
        mid: text(message.mid, 160) || text(message.id, 160) || createMessageId(),
        stopped: message.stopped === true,
        ...(recalled && recalled.length > 0 ? { recalledMemories: recalled } : {}),
      }
    })
    .filter(message => message.content)
    .slice(-maxMessages)
}

export function normalizeChatStorage(
  value: unknown,
  legacyModel: unknown,
  options: ChatStorageOptions,
): NormalizedChatStorage {
  const raw = isRecord(value) ? value : {}
  const settings = isRecord(raw.settings) ? raw.settings : {}
  const legacyApi = isRecord(raw.api) ? raw.api : {}
  const histories = isRecord(raw.histories) ? raw.histories : {}
  const drafts = isRecord(settings.drafts) ? settings.drafts : {}
  const ids = options.characterIds.length ? options.characterIds : ['nene']
  const activeCandidate = text(raw.active, 80) || text(raw.activeCharacter, 80)
  const active = ids.includes(activeCandidate) ? activeCandidate : ids[0]

  const normalizedHistories: Record<string, PersistedChatMessage[]> = {}
  const normalizedDrafts: Record<string, string> = {}
  for (const id of ids) {
    normalizedHistories[id] = normalizeMessages(
      histories[id], options.maxMessages, options.createMessageId,
    )
    normalizedDrafts[id] = text(drafts[id], 1200)
  }

  const providerCandidate = settings.provider ?? raw.provider
  const rawVolume = Number(settings.volume)
  const volume = Number.isFinite(rawVolume)
    ? Math.max(0, Math.min(100, Math.round(rawVolume)))
    : 80
  const outfitCandidate = text(settings.live2dOutfit, 40)
  const rawOutfits = isRecord(settings.live2dOutfits) ? settings.live2dOutfits : {}
  const live2dOutfits: Record<string, string> = {}
  for (const id of ids) {
    // v3 stored one outfit string. It belonged to the active room, so only
    // use it as the migration fallback for that character.
    const candidate = rawOutfits[id] ?? (id === active ? outfitCandidate : '')
    live2dOutfits[id] = options.normalizeOutfit
      ? options.normalizeOutfit(id, candidate)
      : legacyNormalizedOutfit(id, candidate)
  }

  // API 配置：逐层取用户已保存的值；只有"从未配置过"（三个字段全空）时
  // 才用本地代理（CLIProxyAPI）默认，保证开箱即用。
  // 之前是逐字段兜底：用户只要有一个字段为空（custom 模式 key 留空、
  // 旧存储缺字段等），加载时就会被覆盖成本地 Gemini，丢失 Go/DeepSeek 配置。
  const apiBaseUrl = text(settings.apiBaseUrl, 500)
    || text(settings.baseUrl, 500)
    || text(legacyApi.baseUrl, 500)
  const apiModel = text(settings.apiModel, 200)
    || text(legacyApi.model, 200)
  const apiKey = text(settings.apiKey, 1000)
    || text(raw.apiKey, 1000)
    || text(legacyApi.apiKey, 1000)
  // "从未配置"判定：三个字段全空，或恰好是开箱即用兜底默认值。
  // 早期版本 normalize 会把兜底默认（本机 CLIProxy + Gemini）持久化进
  // localStorage——这些用户从未主动配置，站主托管配置必须优先于兜底，
  // 否则公网访客（以及本机用户）永远被"看起来已配置"的兜底值拦在站主
  // 配置之外，聊天一直打本机 127.0.0.1:8317 而失败。
  const FALLBACK_BASE_URL = 'http://127.0.0.1:8317/v1'
  const FALLBACK_MODEL = 'gemini-3.6-flash-high'
  const FALLBACK_KEY = 'sk-local-proxy-key-2024'
  const equalsFallback = apiBaseUrl === FALLBACK_BASE_URL && apiModel === FALLBACK_MODEL && apiKey === FALLBACK_KEY
  const neverConfigured = typeof settings.apiConfiguredByUser === 'boolean'
    ? !settings.apiConfiguredByUser
    : (!apiBaseUrl && !apiModel && !apiKey) || equalsFallback
  const finalApiBaseUrl = apiBaseUrl || (neverConfigured ? FALLBACK_BASE_URL : '')
  const finalApiModel = apiModel || (neverConfigured ? FALLBACK_MODEL : '')
  const finalApiKey = apiKey || (neverConfigured ? FALLBACK_KEY : '')

  const rawHistoriesRevision = Number(raw.historiesRevision)
  const historiesRevision = Number.isSafeInteger(rawHistoriesRevision) && rawHistoriesRevision >= 0
    ? rawHistoriesRevision
    : 0
  const rawHistoriesRevisions = isRecord(raw.historiesRevisions) ? raw.historiesRevisions : {}
  const historiesRevisions: Record<string, number> = {}
  for (const id of ids) {
    const candidate = Number(rawHistoriesRevisions[id])
    historiesRevisions[id] = Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : historiesRevision
  }

  return {
    neverConfigured: neverConfigured,
    state: {
      version: options.version,
      historiesRevision,
      historiesRevisions,
      active,
      histories: normalizedHistories,
      settings: {
        model: text(settings.model, 200) || text(raw.model, 200) || text(legacyModel, 200),
        provider: providerCandidate === 'local' ? 'local' : 'api',
        apiBaseUrl: finalApiBaseUrl,
        apiModel: finalApiModel,
        apiKey: finalApiKey,
        apiConfiguredByUser: !neverConfigured,
        webSearchEnabled: settings.webSearchEnabled !== false,
        live2dEnabled: settings.live2dEnabled === true,
        live2dOutfit: live2dOutfits[active],
        live2dOutfits,
        autoVoice: settings.autoVoice !== false,
        volume,
        drafts: normalizedDrafts,
      },
    },
    migratedApiKey: '',
  }
}
export function serializeChatStorage(state: PersistedChatState): string {
  return JSON.stringify({
    version: state.version,
    historiesRevision: state.historiesRevision,
    historiesRevisions: state.historiesRevisions,
    active: state.active,
    histories: state.histories,
    settings: state.settings,
  })
}
