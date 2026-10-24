import { profileLocalStorage as localStorage, profileRuntimeActive, writeProfileChatHistory, ensureProfileChatHistory } from '../../platform/web/profileStorage.ts'
import { reactive, ref, getCurrentScope, onScopeDispose } from 'vue'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { useChatArchiveStorage } from './useChatArchiveStorage'
import { createChatCredentials } from '@/utils/chatCredentials'
import { assertChatVersion } from '@/utils/chatVersion'
import { assertStoredChatVersion } from '@/storage/chatVersionStorage'
import { chatResetRevision } from '@/utils/chatReset'
import { CHAT_ARCHIVE_CHANGED_KEY, CHAT_DRAFT_PREFIX, CHAT_VOLUME_KEY, CHAT_MEMORY_KEY, CHAT_PREFERENCES_KEY } from '@/utils/storageKeys'
import { preserveRetiredCompanionChat } from '@/utils/retiredCompanionChat'
import { STORAGE_KEY, STORAGE_VERSION, MAX_LOCAL_MESSAGES } from '@/config/characters'
import { listCompanionCharacterIds } from '@/utils/companionRegistry'
import {
  normalizeChatStorage, sameChatApiBinding, serializeChatStorage, type PersistedChatState,
} from '@/utils/chatStorageCore'
import {
  CHAT_ARCHIVE_KEY,
  archiveCounts,
  forkChatArchiveMessages,
  serializeChatArchive,
} from '@/utils/chatArchive'
import { captureChatConversations, chatBranchArchiveKey, emptyChatConversation, mergeChatConversationStates, rememberChatConversations } from '@/utils/chatConversationStorage'
import { useChatBranches } from './useChatBranches'
import { createChatPreferences, readChatPreferences, type ChatPreferences } from '@/storage/chatPreferences'
import { chatHistorySnapshot } from './chatHistorySnapshot'
import { createChatNormalizeOptions, createChatStorageState } from './chatStorageState'
import { createChatPreferenceSetters } from './chatPreferenceSetters'
import type { ChatMessage, ChatState } from './chatStorageTypes'
export type { ChatMessage, ChatState } from './chatStorageTypes'

/**
 * 2026-08-16 审计：多窗口并发聊天时单键 last-writer-wins 会静默丢消息。
 * 方案：按 mid 去重合并，保留本地正在修改的对象与数组引用；独有消息追尾，
 * 极端交错时顺序近似。storage 事件被动同步 + 保存前合并远端。settings 仍 last-writer-wins
 * （可接受）；clear() 不合并（清除意图优先，跨窗口清除为已知边界）。
 */
let chatStorageSyncInstalled = false
let chatStorageSyncHandler: ((key?: string | null) => void) | null = null

export function useChatStorage(onError: (msg: string) => void = () => {}) {
  let resetRevision = ''
  try { resetRevision = chatResetRevision() } catch { /* load reports inaccessible storage */ }
  const credentials = createChatCredentials()
  let pendingLegacyKey = ''
  let credentialRevision = 0, credentialWrites = 0, connectionReloadPending = false
  let connectionSnapshot = '', disposed = false, credentialLoad = 0
  const credentialsLoading = ref(false)
  if (getCurrentScope()) onScopeDispose(() => { disposed = true; credentialsLoading.value = false })
  const characterIds = listCompanionCharacterIds()
  const state = reactive<ChatState>(createChatStorageState(characterIds))
  const normalizeOptions = createChatNormalizeOptions(characterIds)
  const preferences = createChatPreferences(state, normalizeOptions, message => { if (!disposed) onError(message) })

  /** 用户从未配置过 API（当前是开箱即用兜底值）；站主配置优先于此标记 */
  const neverConfigured = ref(true)
  const writeBlocked = ref(false)
  function canWrite() {
    try {
      if (resetRevision !== chatResetRevision()) {
        resetRevision = chatResetRevision()
        pendingPreferences.clear()
        archiveStorage.reset()
        for (const char of characterIds) { state.histories[char] = []; state.conversations[char] = emptyChatConversation(); state.settings.drafts[char] = '' }
        onError('另一窗口已清空聊天内容；旧操作已停止，请重新输入。')
        return false
      }
      readChatPreferences()
      assertStoredChatVersion(STORAGE_KEY, STORAGE_VERSION)
      assertStoredChatVersion(CHAT_ARCHIVE_KEY, 1)
      assertStoredChatVersion(CHAT_MEMORY_KEY, 1)
      writeBlocked.value = false
      return true
    } catch {
      writeBlocked.value = true
      onError('聊天数据版本不兼容或已损坏，原件已保留；请升级或恢复兼容数据后再发送、清空或保存。')
      return false
    }
  }
  const archiveStorage = useChatArchiveStorage(characterIds, canWrite, onError)
  const { archive } = archiveStorage
  const pendingPreferences = new Map<string, string>()
  let saveFailed = false
  if (getCurrentScope()) onScopeDispose(registerMaintenanceParticipant(async () => {
    await ensureProfileChatHistory()
    if (!canWrite()) throw new Error('CHAT_WRITE_BLOCKED')
    await preferences.confirm()
    for (const [key, value] of pendingPreferences) savePreference(key, value)
    if (pendingPreferences.size || saveFailed && !save(true, false) || !await saveArchive()) throw new Error('CHAT_SAVE_FAILED')
  }))
  const messageSnapshots = new Map<string, string>()
  let synchronizedText: string | null | undefined
  function rememberMessages(characters?: string[]) { rememberChatConversations(state, messageSnapshots, characters) }
  function writeHistory(characters?: string[]) {
    const text = serializeChatStorage(chatHistorySnapshot(state, localStorage.getItem(STORAGE_KEY), normalizeOptions, characters))
    writeProfileChatHistory(text, characters)
    synchronizedText = text
  }

  /** 把 localStorage 中其他窗口更新的历史合并进内存（按 mid 去重，零丢失）。 */
  function mergeRemoteIntoState(): boolean {
    if (!canWrite()) return false
    try {
      const text = localStorage.getItem(STORAGE_KEY)
      if (text === synchronizedText) return true
      const raw = JSON.parse(text || 'null')
      assertChatVersion(raw, STORAGE_VERSION)
      if (!raw || typeof raw !== 'object') return true
      preserveRetiredCompanionChat(raw)
      const remote = normalizeChatStorage(raw, '', { ...normalizeOptions, maxMessages: Number.MAX_SAFE_INTEGER }).state
      mergeChatConversationStates(state, remote, messageSnapshots)
      synchronizedText = text
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
      if (event.key !== STORAGE_KEY && event.key !== CHAT_ARCHIVE_KEY && event.key !== CHAT_ARCHIVE_CHANGED_KEY && event.key !== CHAT_PREFERENCES_KEY) return
      chatStorageSyncHandler?.(event.key)
    })
  }
  const syncStorage = (key?: string | null) => {
    if (disposed) return
    // Connection sync belongs to useChatProvider; display switches keep their visit-local state.
    if (key === CHAT_PREFERENCES_KEY) return
    mergeRemoteIntoState()
    void archiveStorage.refresh().catch(() => {
      if (!disposed) onError('无法同步另一窗口的聊天归档，现有内容已保留，请稍后重试。')
    })
  }
  chatStorageSyncHandler = syncStorage
  if (getCurrentScope()) onScopeDispose(() => {
    if (chatStorageSyncHandler === syncStorage) chatStorageSyncHandler = null
  })

  const pendingTrims = new Map<string, { history: ChatMessage[]; ids: Set<string> }>()
  async function saveArchive() {
    const trims = new Map(pendingTrims)
    const saved = await archiveStorage.save()
    if (!saved || !trims.size) return saved
    if (!mergeRemoteIntoState()) { pendingTrims.clear(); return false }
    for (const [char, trim] of trims) {
      if (state.histories[char] !== trim.history) continue
      for (let index = trim.history.length - 1; index >= 0; index--) {
        if (trim.ids.has(trim.history[index].mid)) trim.history.splice(index, 1)
      }
    }
    for (const [char, trim] of trims) if (pendingTrims.get(char) === trim) pendingTrims.delete(char)
    // Publish the smaller history only after its archive is durable.
    if (!save(false, false, [...trims.keys()])) {
      for (const [char, trim] of trims) if (!pendingTrims.has(char)) pendingTrims.set(char, trim)
      return false
    }
    return true
  }

  /** 把超限消息转入归档，而不是直接丢弃。 */
  function archiveOverflow(char: string, messages: ChatMessage[], limit: number) {
    if (messages.length <= limit) return
    const removed = messages.slice(0, messages.length - limit)
    archiveStorage.add(currentArchiveKey(char), removed)
    const pending = pendingTrims.get(char)
    pendingTrims.set(char, { history: messages, ids: new Set([...(pending?.ids || []), ...removed.map(message => message.mid)]) })
    void saveArchive()
  }

  function applyPersisted(persisted: PersistedChatState) {
    state.historiesRevision = persisted.historiesRevision
    state.historiesRevisions = { ...persisted.historiesRevisions }
    state.conversations = persisted.conversations
    state.active = persisted.active
    for (const char of characterIds) {
      state.histories[char] = persisted.histories[char] || []
      state.settings.drafts[char] = persisted.settings.drafts[char] || ''
    }
    const { drafts: _drafts, apiConfiguredByUser: _configured, apiSettingsRevision: _revision, ...settings } = persisted.settings
    Object.assign(state.settings, settings)
  }

  const readConnection = () => preferences.connection(() => JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'))
  function savePreferences(patch: Partial<ChatPreferences>) {
    if (writeBlocked.value || resetRevision !== chatResetRevision() && !canWrite()) return null
    try { return preferences.save(patch, !neverConfigured.value, JSON.parse(connectionSnapshot || '{}').apiSettingsRevision || '') }
    catch (error) { onError(error instanceof Error ? error.message : '聊天偏好尚未保存'); return null }
  }

  async function load() {
    try { await ensureProfileChatHistory() }
    catch (error) { if (!disposed) onError(error instanceof Error ? error.message : '聊天记录尚未加载，请重试。'); return }
    if (disposed || !canWrite()) return
    const revision = ++credentialRevision
    let stored = '', raw: unknown
    try {
      stored = localStorage.getItem(STORAGE_KEY) || ''
    } catch {
      onError('无法读取本地聊天记录，请检查浏览器存储权限。')
      return
    }
    try {
      raw = stored ? JSON.parse(stored) : {}
    } catch {
      writeBlocked.value = true
      onError('本地聊天记录损坏，原件已保留，无法安全修改。')
      return
    }
    const loading = ++credentialLoad; credentialsLoading.value = true
    try {
      assertChatVersion(raw, STORAGE_VERSION)
      preserveRetiredCompanionChat(raw)
      const normalized = normalizeChatStorage(
        preferences.overlay(raw),
        localStorage.getItem('aics_chat_model') || '',
        normalizeOptions,
      )
      connectionSnapshot = JSON.stringify(readConnection())
      applyPersisted(normalized.state)
      synchronizedText = stored || null
      loadFrequentPreferences()
      neverConfigured.value = normalized.neverConfigured

      const legacy = raw as { settings?: { apiKey?: unknown }; apiKey?: unknown; api?: { apiKey?: unknown } } | null
      const legacyValue = legacy?.settings?.apiKey || legacy?.apiKey || legacy?.api?.apiKey
      pendingLegacyKey = normalized.state.settings.apiKey && typeof legacyValue === 'string' ? legacyValue.trim().slice(0, 1000) : ''
      rememberMessages()

      // Rewriting existing records through the allowlist removes unsupported
      // authorization headers, tokens and unknown fields from localStorage.
      const rawHistoryLists = (raw as { histories?: Record<string, unknown> })?.histories
      const hasOverflow = characterIds.some(char => Array.isArray(rawHistoryLists?.[char]) && (rawHistoryLists[char] as unknown[]).length > MAX_LOCAL_MESSAGES)
      if (stored && !hasOverflow) writeHistory()
      try {
        await archiveStorage.ready
      // 先把持久化里的超限消息归档，再走白名单归一化，保证旧消息不丢。
      const rawHistories = raw && typeof raw === 'object' && (raw as Record<string, unknown>).histories
      if (rawHistories && typeof rawHistories === 'object') {
        for (const char of characterIds) {
          const list = (rawHistories as Record<string, unknown>)[char]
          if (Array.isArray(list) && list.length > MAX_LOCAL_MESSAGES) {
            const overflow = list.slice(0, list.length - MAX_LOCAL_MESSAGES)
            archiveStorage.add(currentArchiveKey(char), overflow as ChatMessage[])
          }
        }
      }
        if (!await saveArchive()) throw new Error('Archive commit failed')
        if (stored && hasOverflow) writeHistory()
      } catch { onError('无法读取聊天归档，请检查浏览器存储权限。') }
      const endpoint = state.settings.apiBaseUrl
      try {
        await credentials.load(endpoint, pendingLegacyKey, {
          isCurrent: () => {
            if (!canWrite()) return false
            if (revision !== credentialRevision) return false
            const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
            return current?.settings?.apiBaseUrl === endpoint && current?.settings?.apiKey === pendingLegacyKey
          },
          commit: secret => {
            if (!canWrite()) return
            if (revision !== credentialRevision) return
            state.settings.apiKey = secret || (normalized.neverConfigured ? normalized.state.settings.apiKey : '')
            // Touch only the matching migration source, never other windows' histories.
            const currentText = localStorage.getItem(STORAGE_KEY)
            if (currentText) {
              const current = JSON.parse(currentText)
              assertChatVersion(current, STORAGE_VERSION)
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
    } finally { if (loading === credentialLoad) credentialsLoading.value = false }
  }

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
    // Independent preferences never rewrite the versioned record. The load /
    // storage-event guard blocks editing when incompatibility is known.
    if (writeBlocked.value) return
    if (resetRevision !== chatResetRevision() && !canWrite()) return
    pendingPreferences.set(key, value)
    try {
      localStorage.setItem(key, value)
      pendingPreferences.delete(key)
    } catch {
      onError('浏览器存储空间不足，聊天草稿或偏好暂时无法保存。')
    }
  }

  function save(mergeRemote = true, flushArchive = true, characters?: string[]) {
    if (!canWrite()) { saveFailed = true; return false }
    for (const [key, value] of pendingPreferences) savePreference(key, value)
    try {
      // 2026-08-16 审计：写盘前先合并其他窗口的更新，避免单键 last-writer-wins
      // 覆盖掉另一窗口的新消息。clear() 传 false 跳过（清除意图优先）。
      if (mergeRemote && !mergeRemoteIntoState()) return false
      writeHistory(characters)
      rememberMessages(characters)
      if (flushArchive) void saveArchive()
      saveFailed = false; return true
    } catch {
      saveFailed = true
      onError('浏览器存储空间不足，本轮聊天可能无法长期保存。')
      return false
    }
  }

  const branchStorage = useChatBranches(state, canWrite, mergeRemoteIntoState, (merge, char) => save(merge, true, [char]), (source, target, forkMessageId, followingMessageIds) => {
    archiveStorage.add(target, forkChatArchiveMessages(archive.value.archived[source] || [], forkMessageId, followingMessageIds))
    void saveArchive()
  })
  const currentArchiveKey = (char: string) => chatBranchArchiveKey(char, branchStorage.branchId(char))

  function messages(char = state.active): ChatMessage[] {
    return state.histories[char] || []
  }

  const { setActive, setModel, setProvider, setWebSearchEnabled, setLive2dEnabled, live2dOutfit, setLive2dOutfit, setAutoVoice, setVolume, draft, setDraft } =
    createChatPreferenceSetters(state, characterIds, savePreferences, savePreference)
  async function reloadConnectionSettings(): Promise<boolean> {
    if (credentialWrites) { connectionReloadPending = true; return false }
    if (disposed || !canWrite()) return false
    const incoming = readConnection(), snapshot = JSON.stringify(incoming)
    if (snapshot === connectionSnapshot) return false
    const revision = ++credentialRevision
    const changedCredential = incoming.apiSettingsRevision !== JSON.parse(connectionSnapshot || '{}').apiSettingsRevision || incoming.apiBaseUrl !== state.settings.apiBaseUrl
    if (!credentials.desktop && changedCredential) await credentials.save(incoming.apiBaseUrl, '')
    const secret = credentials.desktop ? await credentials.load(incoming.apiBaseUrl, '') : changedCredential ? '' : state.settings.apiKey
    if (credentialWrites) { connectionReloadPending = true; return false }
    if (disposed || revision !== credentialRevision || snapshot !== JSON.stringify(readConnection()) || !canWrite()) return false
    const { neverConfigured: unconfigured, apiSettingsRevision: _revision, ...settings } = incoming
    Object.assign(state.settings, settings, { apiKey: secret })
    neverConfigured.value = unconfigured
    connectionSnapshot = snapshot
    return true
  }
  async function setApiSettings(settings: { baseUrl: string; model: string; apiKey: string }, intent: 'user' | 'model' = 'user') {
    if (!canWrite()) throw new Error('聊天配置受版本保护，无法安全修改。')
    const endpoint = String(settings.baseUrl || '').trim().slice(0, 500)
    const secret = String(settings.apiKey || '').trim().slice(0, 1000)
    const revision = intent === 'user' ? ++credentialRevision : credentialRevision
    credentialWrites++
    if (intent === 'model') state.settings.apiModel = String(settings.model || '').trim().slice(0, 200)
    try {
      let written: ReturnType<typeof savePreferences> = null
      const commit = () => {
        if (revision !== credentialRevision) return
        if (intent === 'model' && (endpoint !== state.settings.apiBaseUrl || secret !== state.settings.apiKey
          || !sameChatApiBinding(readConnection(), JSON.parse(connectionSnapshot || '{}')))) return
        if (intent === 'user') { pendingLegacyKey = ''; state.settings.apiKey = secret; neverConfigured.value = false }
        state.settings.apiBaseUrl = endpoint
        state.settings.apiModel = String(settings.model || '').trim().slice(0, 200)
        written = savePreferences({ apiBaseUrl: endpoint, apiModel: state.settings.apiModel, apiConfiguredByUser: !neverConfigured.value,
          apiSettingsRevision: intent === 'user' ? crypto.randomUUID() : readConnection().apiSettingsRevision })
        if (!written) throw new Error('聊天配置保存失败，请重试。')
        connectionSnapshot = JSON.stringify(readConnection())
      }
      if (intent === 'model') await credentials.load(endpoint, '', { isCurrent: () => false, commit })
      else await credentials.save(endpoint, secret, commit)
      await (written as ReturnType<typeof savePreferences>)?.confirm()
    } finally {
      if (--credentialWrites === 0 && connectionReloadPending) { connectionReloadPending = false; await reloadConnectionSettings() }
    }
  }
  function trim(char = state.active) {
    if (!canWrite()) return
    const msgs = messages(char)
    archiveOverflow(char, msgs, MAX_LOCAL_MESSAGES)
  }
  function archiveCount(): Record<string, number>
  function archiveCount(char: string): number
  function archiveCount(char?: string) {
    const counts = archiveCounts(archive.value, characterIds)
    if (char) return counts[currentArchiveKey(char)] || 0
    const totals = new Map(characterIds.map(id => [id, 0]))
    for (const [key, count] of Object.entries(counts)) { const id = key.split('::')[0]; totals.set(id, (totals.get(id) || 0) + count) }
    return Object.fromEntries(totals)
  }
  async function exportArchiveJson(): Promise<string> {
    await archiveStorage.refresh(true)
    return serializeChatArchive(archive.value)
  }
  async function exportArchiveMarkdown(): Promise<string> {
    const [formatter] = await Promise.all([import('@/utils/chatArchiveMarkdown'), archiveStorage.refresh(true)])
    return formatter.exportChatArchiveMarkdown(archive.value, characterIds, branchStorage.branches)
  }
  /** 导入归档 JSON：合并去重后落盘，返回导入条数。 */
  async function importArchiveJson(textValue: string, isCurrent: () => boolean = () => true): Promise<number> {
    if (!isCurrent() || !canWrite()) throw new Error('聊天归档受版本保护，无法安全修改。')
    const revision = resetRevision, current = () => !disposed && isCurrent() && revision === chatResetRevision()
    const { importChatArchive } = await import('./restoreChatArchive')
    return importChatArchive(textValue, characterIds, state, { current, canWrite, archiveStorage, saveArchive, save })
  }
  /** 把该角色归档并回当前对话；返回并入条数。 */
  async function restoreFromArchive(char = state.active, isCurrent: () => boolean = () => true): Promise<number> {
    if (!canWrite()) throw new Error('聊天归档受版本保护，无法安全恢复。')
    if (!characterIds.includes(char)) return 0
    const branch = branchStorage.branchId(char), selection = state.conversations[char].selectionRevision
    const revision = state.historiesRevisions[char] ?? state.historiesRevision
    const key = chatBranchArchiveKey(char, branch)
    const reset = chatResetRevision(), runtime = profileRuntimeActive()
    const current = () => !disposed && isCurrent() && reset === chatResetRevision() && runtime === profileRuntimeActive()
      && branch === branchStorage.branchId(char) && selection === state.conversations[char].selectionRevision
      && revision === (state.historiesRevisions[char] ?? state.historiesRevision)
    const { restoreChatArchive } = await import('./restoreChatArchive')
    if (!current() || !canWrite()) throw new Error('当前剧情或聊天资料已变化，请重新并入归档。')
    return restoreChatArchive({
      current,
      refresh: mergeRemoteIntoState,
      readArchive: async () => { await archiveStorage.refresh(true); return archive.value.archived[key] || [] },
      history: () => messages(char), replaceHistory: history => { state.histories[char] = history }, save,
    })
  }
  async function clearArchive(char?: string, isCurrent: () => boolean = () => true) {
    if (!isCurrent() || !canWrite() || !await saveArchive() || !isCurrent() || !canWrite()) return false
    if (char) archiveStorage.clearCharacter(char); else archiveStorage.clear()
    return saveArchive()
  }
  function clear(char?: string) {
    if (!canWrite() || char && !characterIds.includes(char)) return false
    // Preserve a clear made by another tab for a different character before
    // applying this character's clear. localStorage access is synchronous, so
    // the read and the following write are one uninterrupted mutation.
    if (char && !mergeRemoteIntoState()) return false
    const previous = {
      histories: { ...state.histories },
      conversations: state.conversations,
      historiesRevision: state.historiesRevision,
      historiesRevisions: { ...state.historiesRevisions },
    }
    state.conversations = { ...state.conversations }
    for (const id of char ? [char] : characterIds) {
      const conversation = captureChatConversations(state, [id])[id]
      conversation.branches.find(branch => branch.id === conversation.activeId)!.messages = []
      state.histories[id] = []; state.conversations[id] = conversation
    }
    // Advance the tombstone before persisting. A delayed save from a tab that
    // still has the previous revision will then be rejected.
    const nextRevision = Math.max(state.historiesRevision + 1, Date.now())
    state.historiesRevision = nextRevision
    if (char) state.historiesRevisions[char] = Math.max((state.historiesRevisions[char] || 0) + 1, nextRevision)
    else for (const key of characterIds) state.historiesRevisions[key] = nextRevision
    if (save(false, true, char ? [char] : undefined)) return true
    // A failed localStorage write must not make the current tab look cleared.
    state.conversations = previous.conversations
    state.histories = previous.histories
    state.historiesRevision = previous.historiesRevision
    state.historiesRevisions = previous.historiesRevisions
    return false
  }

  return {
    ...branchStorage, refresh: mergeRemoteIntoState, state, load, save, messages, neverConfigured, canWrite, writeBlocked, credentialsLoading, flushArchive: saveArchive,
    setActive, setModel, setProvider, setApiSettings, reloadConnectionSettings, setWebSearchEnabled,
    setLive2dEnabled, live2dOutfit, setLive2dOutfit, setAutoVoice, setVolume, draft, setDraft, trim, clear,
    archiveCount, exportArchiveJson, exportArchiveMarkdown, importArchiveJson,
    restoreFromArchive, clearArchive,
  }
}
