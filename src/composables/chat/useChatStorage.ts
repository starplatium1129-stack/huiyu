import { reactive, ref } from 'vue'
import { createChatCredentials } from '@/utils/chatCredentials'
import { CHAT_DRAFT_PREFIX, CHAT_VOLUME_KEY } from '@/utils/storageKeys'
import { preserveRetiredCompanionChat } from '@/utils/retiredCompanionChat'
import {
  STORAGE_KEY, STORAGE_VERSION, MAX_LOCAL_MESSAGES, createMessageId,
} from '@/config/characters'
import {
  DEFAULT_COMPANION_CHARACTER_ID,
  getCompanionCharacter,
  getCompanionDefaultOutfit,
  listCompanionCharacterIds,
  normalizeCompanionOutfit,
} from '@/utils/companionRegistry'
import {
  CLIPROXY_BASE_URL, CLIPROXY_API_KEY, CLIPROXY_DEFAULT_MODEL,
} from '@/config/chatApi'
import {
  normalizeChatStorage, serializeChatStorage, type PersistedChatState,
} from '@/utils/chatStorageCore'
import {
  CHAT_ARCHIVE_KEY,
  archiveCounts,
  archiveMessages,
  chatArchiveToMarkdown,
  emptyChatArchive,
  mergeArchiveIntoHistory,
  mergeChatArchives,
  normalizeChatArchive,
  serializeChatArchive,
  type ChatArchive,
} from '@/utils/chatArchive'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  mid: string
  stopped: boolean
  recalledMemories?: string[]
}

export interface ChatState {
  version: number
  historiesRevision: number
  historiesRevisions: Record<string, number>
  active: string
  histories: Record<string, ChatMessage[]>
  settings: {
    model: string
    provider: 'local' | 'api'
    apiBaseUrl: string
    apiModel: string
    apiKey: string
    webSearchEnabled: boolean
    live2dEnabled: boolean
    live2dOutfit: string
    live2dOutfits: Record<string, string>
    autoVoice: boolean
    volume: number
    drafts: Record<string, string>
  }
}

/**
 * 2026-08-16 审计：多窗口并发聊天时单键 last-writer-wins 会静默丢消息。
 * 方案：按 mid 去重合并，保留本地正在修改的对象与数组引用；独有消息追尾，
 * 极端交错时顺序近似。storage 事件被动同步 + 保存前合并远端。settings 仍 last-writer-wins
 * （可接受）；clear() 不合并（清除意图优先，跨窗口清除为已知边界）。
 */
let chatStorageSyncInstalled = false
let chatStorageSyncHandler: (() => void) | null = null

/** 按 mid 去重：remote 为基（较旧），local 独有的消息追加到尾部。 */
function mergeHistories(local: ChatMessage[], remote: ChatMessage[], snapshots: Map<string, string>): ChatMessage[] {
  const localById = new Map(local.map(message => [message.mid, message]))
  const seen = new Set<string>()
  const merged: ChatMessage[] = []
  for (const message of [...remote, ...local]) {
    if (!message || typeof message.mid !== 'string' || !message.mid) continue
    if (seen.has(message.mid)) continue
    seen.add(message.mid)
    const existing = localById.get(message.mid)
    if (existing && snapshots.get(message.mid) === JSON.stringify(existing)) {
      // Only unchanged local messages may adopt remote updates. Mutate in place:
      // the streaming callback can still hold the original assistant object.
      Object.assign(existing, message)
      snapshots.set(message.mid, JSON.stringify(existing))
    } else if (!existing) snapshots.set(message.mid, JSON.stringify(message))
    merged.push(existing || message)
  }
  return merged
}

export function useChatStorage(onError: (msg: string) => void = () => {}) {
  const credentials = createChatCredentials()
  let pendingLegacyKey = ''
  let credentialRevision = 0
  const characterIds = listCompanionCharacterIds()
  const defaultCharacterId = characterIds[0] || DEFAULT_COMPANION_CHARACTER_ID
  const defaultOutfits = Object.fromEntries(characterIds.map(id => [id, getCompanionDefaultOutfit(id)]))
  const state = reactive<ChatState>({
    version: STORAGE_VERSION,
    historiesRevision: 0,
    historiesRevisions: Object.fromEntries(characterIds.map(k => [k, 0])),
    active: defaultCharacterId,
    histories: Object.fromEntries(characterIds.map(k => [k, []])),
    settings: {
      model: '',
      provider: 'api',
      apiBaseUrl: CLIPROXY_BASE_URL,
      apiModel: CLIPROXY_DEFAULT_MODEL,
      apiKey: CLIPROXY_API_KEY,
      webSearchEnabled: false,
      live2dEnabled: false,
      live2dOutfit: defaultOutfits[defaultCharacterId] || '',
      live2dOutfits: defaultOutfits,
      autoVoice: true,
      volume: 80,
      drafts: Object.fromEntries(characterIds.map(k => [k, ''])),
    },
  })

  const normalizeOptions = {
    characterIds,
    maxMessages: MAX_LOCAL_MESSAGES,
    version: STORAGE_VERSION,
    createMessageId,
    normalizeOutfit: normalizeCompanionOutfit,
  }

  /** 用户从未配置过 API（当前是开箱即用兜底值）；站主配置优先于此标记 */
  const neverConfigured = ref(true)
  const archive = ref<ChatArchive>(emptyChatArchive(characterIds))
  let archiveDirty = false
  const pendingPreferences = new Map<string, string>()
  const messageSnapshots = new Map<string, string>()
  function rememberMessages() {
    messageSnapshots.clear()
    for (const history of Object.values(state.histories)) {
      for (const message of history) messageSnapshots.set(message.mid, JSON.stringify(message))
    }
  }

  function loadArchive() {
    try {
      archive.value = normalizeChatArchive(
        JSON.parse(localStorage.getItem(CHAT_ARCHIVE_KEY) || 'null'),
        characterIds,
      )
    } catch {
      archive.value = emptyChatArchive(characterIds)
    }
  }

  /** 把 localStorage 中其他窗口更新的历史合并进内存（按 mid 去重，零丢失）。 */
  function mergeRemoteIntoState(): boolean {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
      if (!raw || typeof raw !== 'object') return true
      preserveRetiredCompanionChat(raw)
      const record = raw as Record<string, unknown>
      const parsedRevision = Number(record.historiesRevision)
      const legacyRevision = Number.isSafeInteger(parsedRevision) && parsedRevision >= 0 ? parsedRevision : 0
      const rawRevisions = record.historiesRevisions
      const remoteRevisions = rawRevisions && typeof rawRevisions === 'object'
        ? rawRevisions as Record<string, unknown>
        : {}
      const remote = record.histories
      if (!remote || typeof remote !== 'object') return true
      for (const char of characterIds) {
        const parsedCharRevision = Number(remoteRevisions[char])
        const remoteRevision = Number.isSafeInteger(parsedCharRevision) && parsedCharRevision >= 0
          ? parsedCharRevision
          : legacyRevision
        const localRevision = state.historiesRevisions[char] ?? state.historiesRevision
        const list = (remote as Record<string, unknown>)[char]
        if (!Array.isArray(list)) continue
        if (remoteRevision > localRevision) {
          state.historiesRevisions[char] = remoteRevision
          state.histories[char] = list as ChatMessage[]
          for (const message of state.histories[char]) messageSnapshots.set(message.mid, JSON.stringify(message))
        } else if (remoteRevision === localRevision) {
          const history = state.histories[char] ||= []
          const merged = mergeHistories(history, list as ChatMessage[], messageSnapshots)
          history.splice(0, history.length, ...merged)
        }
        state.historiesRevision = Math.max(state.historiesRevision, remoteRevision)
      }
      return true
    } catch {
      /* 解析失败保持现状，下次保存仍会重试. */
      return true
    }
  }

  // storage 事件只在本 tab 之外触发：其他窗口写入后被动合并，不写回（避免循环）。
  if (!chatStorageSyncInstalled) {
    chatStorageSyncInstalled = true
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return
      chatStorageSyncHandler?.()
    })
  }
  chatStorageSyncHandler = mergeRemoteIntoState

  function saveArchive() {
    if (!archiveDirty) return
    try {
      localStorage.setItem(CHAT_ARCHIVE_KEY, serializeChatArchive(archive.value))
      archiveDirty = false
    } catch {
      onError('浏览器存储空间不足，聊天归档可能无法长期保存。')
    }
  }

  /** 把超限消息转入归档，而不是直接丢弃。 */
  function archiveOverflow(char: string, messages: ChatMessage[], limit: number) {
    if (messages.length <= limit) return
    const removed = messages.splice(0, messages.length - limit)
    archive.value = archiveMessages(archive.value, char, removed)
    archiveDirty = true
    saveArchive()
  }

  function applyPersisted(persisted: PersistedChatState) {
    state.version = persisted.version
    state.historiesRevision = persisted.historiesRevision
    state.historiesRevisions = { ...persisted.historiesRevisions }
    state.active = persisted.active
    for (const char of characterIds) {
      state.histories[char] = persisted.histories[char] || []
      state.settings.drafts[char] = persisted.settings.drafts[char] || ''
    }
    state.settings.model = persisted.settings.model
    state.settings.provider = persisted.settings.provider
    state.settings.apiBaseUrl = persisted.settings.apiBaseUrl
    state.settings.apiModel = persisted.settings.apiModel
    state.settings.apiKey = persisted.settings.apiKey
    state.settings.webSearchEnabled = persisted.settings.webSearchEnabled
    state.settings.live2dEnabled = persisted.settings.live2dEnabled
    state.settings.live2dOutfit = persisted.settings.live2dOutfit
    state.settings.live2dOutfits = persisted.settings.live2dOutfits
    state.settings.autoVoice = persisted.settings.autoVoice
    state.settings.volume = persisted.settings.volume
  }

  function persistedState(scrubCredential = false): PersistedChatState {
    let existingKey = ''
    let existingEndpoint = state.settings.apiBaseUrl
    let existingModel = state.settings.apiModel
    let existingConfigured = !neverConfigured.value
    try {
      const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
      const key = current?.settings?.apiKey || current?.apiKey || current?.api?.apiKey
      const endpoint = current?.settings?.apiBaseUrl || current?.settings?.baseUrl || current?.api?.baseUrl
      const model = current?.settings?.apiModel || current?.api?.model
      existingKey = typeof key === 'string' ? key.trim().slice(0, 1000) : ''
      if (typeof endpoint === 'string') existingEndpoint = endpoint.trim().slice(0, 500)
      if (typeof model === 'string') existingModel = model.trim().slice(0, 200)
      if (typeof current?.settings?.apiConfiguredByUser === 'boolean') existingConfigured = current.settings.apiConfiguredByUser
    } catch { /* Malformed legacy records have no recoverable credential. */ }
    return {
      version: STORAGE_VERSION,
      historiesRevision: state.historiesRevision,
      historiesRevisions: state.historiesRevisions,
      active: state.active,
      histories: state.histories,
      settings: {
        model: state.settings.model,
        provider: state.settings.provider,
        apiBaseUrl: scrubCredential ? state.settings.apiBaseUrl : existingEndpoint,
        apiModel: scrubCredential ? state.settings.apiModel : existingModel,
        // Keep only an existing migration source until secure write/read succeeds.
        // New keys are never written to browser storage.
        apiKey: scrubCredential ? '' : existingKey,
        apiConfiguredByUser: scrubCredential ? !neverConfigured.value : existingConfigured,
        webSearchEnabled: state.settings.webSearchEnabled,
        live2dEnabled: state.settings.live2dEnabled,
        live2dOutfit: state.settings.live2dOutfit,
        live2dOutfits: state.settings.live2dOutfits,
        autoVoice: state.settings.autoVoice,
        volume: state.settings.volume,
        drafts: state.settings.drafts,
      },
    }
  }

  async function load() {
    let stored = ''
    let raw: unknown
    try {
      stored = localStorage.getItem(STORAGE_KEY) || ''
    } catch {
      onError('无法读取本地聊天记录，请检查浏览器存储权限。')
      return
    }
    try {
      raw = stored ? JSON.parse(stored) : {}
    } catch {
      const clean = normalizeChatStorage({}, '', normalizeOptions).state
      applyPersisted(clean)
      neverConfigured.value = true
      // Only invalid JSON may be replaced with an empty normalized record.
      // A write failure remains separate from the parsing decision.
      try {
        loadFrequentPreferences()
        localStorage.setItem(STORAGE_KEY, serializeChatStorage(persistedState()))
      } catch {}
      onError('本地聊天记录损坏，已恢复为空白会话。')
      return
    }
    try {
      preserveRetiredCompanionChat(raw)
      // 先把持久化里的超限消息归档，再走白名单归一化，保证旧消息不丢。
      const rawHistories = raw && typeof raw === 'object' && (raw as Record<string, unknown>).histories
      if (rawHistories && typeof rawHistories === 'object') {
        for (const char of characterIds) {
          const list = (rawHistories as Record<string, unknown>)[char]
          if (Array.isArray(list) && list.length > MAX_LOCAL_MESSAGES) {
            const overflow = list.slice(0, list.length - MAX_LOCAL_MESSAGES)
            archive.value = archiveMessages(archive.value, char, overflow as ChatMessage[])
            archiveDirty = true
          }
        }
      }
      const normalized = normalizeChatStorage(
        raw,
        localStorage.getItem('aics_chat_model') || '',
        normalizeOptions,
      )
      applyPersisted(normalized.state)
      loadFrequentPreferences()
      neverConfigured.value = normalized.neverConfigured

      state.settings.apiKey = String(normalized.state.settings.apiKey || normalized.migratedApiKey).trim().slice(0, 1000)
      const legacy = raw as { settings?: { apiKey?: unknown }; apiKey?: unknown; api?: { apiKey?: unknown } } | null
      const legacyValue = legacy?.settings?.apiKey || legacy?.apiKey || legacy?.api?.apiKey
      pendingLegacyKey = typeof legacyValue === 'string' ? legacyValue.trim().slice(0, 1000) : ''
      rememberMessages()

      // Rewriting existing records through the allowlist removes unsupported
      // authorization headers, tokens and unknown fields from localStorage.
      if (stored) localStorage.setItem(STORAGE_KEY, serializeChatStorage(persistedState()))
      saveArchive()
      const revision = credentialRevision
      const endpoint = state.settings.apiBaseUrl
      try {
        await credentials.load(endpoint, pendingLegacyKey, {
          isCurrent: () => {
            if (revision !== credentialRevision) return false
            const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
            return current?.settings?.apiBaseUrl === endpoint && current?.settings?.apiKey === pendingLegacyKey
          },
          commit: secret => {
            if (revision !== credentialRevision) return
            state.settings.apiKey = secret || (normalized.neverConfigured ? normalized.state.settings.apiKey : '')
            // Touch only the matching migration source, never other windows' histories.
            const currentText = localStorage.getItem(STORAGE_KEY)
            if (currentText) {
              const current = JSON.parse(currentText)
              if (current.settings?.apiBaseUrl === endpoint && current.settings?.apiKey === pendingLegacyKey) {
                current.settings.apiKey = ''
                localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
              }
            }
            pendingLegacyKey = ''
          },
        })
      } catch {
        onError('安全凭据暂不可用，原配置已保留，请稍后重新加载或保存配置。')
      }
    } catch {
      onError('浏览器存储不可用或空间不足，聊天记录保留在当前会话中，暂时无法保存。')
    }
  }

  loadArchive()

  // Separate keys remain authoritative after a legacy/full-history save from
  // another window. Per-character keys also prevent unrelated drafts clobbering.
  function loadFrequentPreferences() {
    const volume = localStorage.getItem(CHAT_VOLUME_KEY)
    if (volume !== null && volume.trim() && Number.isFinite(Number(volume))) {
      state.settings.volume = Math.max(0, Math.min(100, Math.round(Number(volume))))
    }
    for (const char of characterIds) {
      const draft = localStorage.getItem(CHAT_DRAFT_PREFIX + char)
      if (draft === null) continue
      try {
        const value: unknown = JSON.parse(draft)
        if (typeof value === 'string') state.settings.drafts[char] = value.slice(0, 1200)
      } catch { /* A malformed preference must not discard legacy history. */ }
    }
  }

  function savePreference(key: string, value: string) {
    pendingPreferences.set(key, value)
    try {
      localStorage.setItem(key, value)
      pendingPreferences.delete(key)
    } catch {
      onError('浏览器存储空间不足，聊天草稿或偏好暂时无法保存。')
    }
  }

  function save(mergeRemote = true, scrubCredential = false) {
    for (const [key, value] of pendingPreferences) savePreference(key, value)
    try {
      // 2026-08-16 审计：写盘前先合并其他窗口的更新，避免单键 last-writer-wins
      // 覆盖掉另一窗口的新消息。clear() 传 false 跳过（清除意图优先）。
      if (mergeRemote && !mergeRemoteIntoState()) return
      state.version = STORAGE_VERSION
      localStorage.setItem(STORAGE_KEY, serializeChatStorage(persistedState(scrubCredential)))
      rememberMessages()
      localStorage.setItem('aics_chat_model', state.settings.model || '')
      saveArchive()
      return true
    } catch {
      onError('浏览器存储空间不足，本轮聊天可能无法长期保存。')
      return false
    }
  }

  function messages(char = state.active): ChatMessage[] {
    return state.histories[char] || []
  }

  function setActive(char: string) {
    if (!characterIds.includes(char)) return
    state.active = char
    state.settings.live2dOutfit = state.settings.live2dOutfits[state.active] || getCompanionDefaultOutfit(char)
    save()
  }
  function setModel(model: string) { state.settings.model = String(model || ''); save() }
  function setProvider(provider: 'local' | 'api') { state.settings.provider = provider === 'api' ? 'api' : 'local'; save() }
  async function setApiSettings(settings: { baseUrl: string; model: string; apiKey: string }) {
    const endpoint = String(settings.baseUrl || '').trim().slice(0, 500)
    const secret = String(settings.apiKey || '').trim().slice(0, 1000)
    const revision = ++credentialRevision
    await credentials.save(endpoint, secret, () => {
      if (revision !== credentialRevision) return
      pendingLegacyKey = ''
      state.settings.apiBaseUrl = endpoint
      state.settings.apiModel = String(settings.model || '').trim().slice(0, 200)
      state.settings.apiKey = secret
      neverConfigured.value = false
      if (!save(true, true)) throw new Error('安全凭据已写入，但浏览器配置保存失败，请重试。')
    })
  }
  function setWebSearchEnabled(value: boolean) { state.settings.webSearchEnabled = Boolean(value); save() }
  function setLive2dEnabled(value: boolean) { state.settings.live2dEnabled = Boolean(value); save() }
  function live2dOutfit(char = state.active) {
    return state.settings.live2dOutfits[char] || getCompanionDefaultOutfit(char)
  }
  function setLive2dOutfit(char: string, value: string) {
    if (!characterIds.includes(char)) return
    const next = normalizeCompanionOutfit(char, value)
    state.settings.live2dOutfits = { ...state.settings.live2dOutfits, [char]: next }
    if (char === state.active) state.settings.live2dOutfit = next
    save()
  }
  function setAutoVoice(v: boolean) { state.settings.autoVoice = Boolean(v); save() }
  function setVolume(v: number) {
    state.settings.volume = Math.max(0, Math.min(100, Number.isFinite(Number(v)) ? Math.round(Number(v)) : 80))
    savePreference(CHAT_VOLUME_KEY, String(state.settings.volume))
  }
  function draft(char = state.active) { return state.settings.drafts[char] || '' }
  function setDraft(char: string, val: string) {
    if (!characterIds.includes(char)) return
    state.settings.drafts[char] = String(val || '').slice(0, 1200)
    savePreference(CHAT_DRAFT_PREFIX + char, JSON.stringify(state.settings.drafts[char]))
  }
  function trim(char = state.active) {
    const msgs = messages(char)
    archiveOverflow(char, msgs, MAX_LOCAL_MESSAGES)
  }
  function archiveCount(): Record<string, number>
  function archiveCount(char: string): number
  function archiveCount(char?: string) {
    const counts = archiveCounts(archive.value, characterIds)
    return char ? counts[char] || 0 : counts
  }
  function exportArchiveJson(): string {
    return serializeChatArchive(archive.value)
  }
  function exportArchiveMarkdown(): string {
    const names: Record<string, string> = {}
    for (const id of characterIds) names[id] = getCompanionCharacter(id)?.name || id
    return chatArchiveToMarkdown(archive.value, names)
  }
  /** 导入归档 JSON：合并去重后落盘，返回导入条数。 */
  function importArchiveJson(textValue: string): number {
    const incoming = normalizeChatArchive(JSON.parse(textValue), characterIds)
    const before = archiveCounts(archive.value, characterIds)
    archive.value = mergeChatArchives(archive.value, incoming)
    archiveDirty = true
    saveArchive()
    const after = archiveCounts(archive.value, characterIds)
    return Object.keys(after).reduce((sum, id) => sum + Math.max(0, after[id] - (before[id] || 0)), 0)
  }
  /** 把该角色归档并回当前对话；返回并入条数。 */
  function restoreFromArchive(char = state.active): number {
    if (!characterIds.includes(char)) return 0
    const archived = archive.value.archived[char] || []
    if (!archived.length) return 0
    const history = messages(char)
    const merged = mergeArchiveIntoHistory(history, archived)
    const added = merged.length - history.length
    if (added > 0) {
      // 完整并回（不截断）：超过 20 条的部分在下次 trim 时会再次归档，
      // 归档按 mid 去重，不会产生副本，也不会丢失。
      state.histories[char] = merged
      save()
    }
    return added
  }
  function clearArchive(char?: string) {
    if (char) archive.value.archived[char] = []
    else archive.value = emptyChatArchive(characterIds)
    archiveDirty = true
    saveArchive()
  }
  function clear(char?: string) {
    // Preserve a clear made by another tab for a different character before
    // applying this character's clear. localStorage access is synchronous, so
    // the read and the following write are one uninterrupted mutation.
    if (char) mergeRemoteIntoState()
    if (char) { state.histories[char] = [] }
    else { for (const k of characterIds) state.histories[k] = [] }
    // Advance the tombstone before persisting. A delayed save from a tab that
    // still has the previous revision will then be rejected.
    const nextRevision = Math.max(state.historiesRevision + 1, Date.now())
    state.historiesRevision = nextRevision
    if (char) state.historiesRevisions[char] = Math.max((state.historiesRevisions[char] || 0) + 1, nextRevision)
    else for (const key of characterIds) state.historiesRevisions[key] = nextRevision
    save(false)
  }

  return {
    state, load, save, messages, neverConfigured,
    setActive, setModel, setProvider, setApiSettings, setWebSearchEnabled,
    setLive2dEnabled, live2dOutfit, setLive2dOutfit, setAutoVoice, setVolume, draft, setDraft, trim, clear,
    archiveCount, exportArchiveJson, exportArchiveMarkdown, importArchiveJson,
    restoreFromArchive, clearArchive,
  }
}
