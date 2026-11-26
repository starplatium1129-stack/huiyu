import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { confirmAction } from '@/composables/useConfirm'
import { loadChatCards, announceChatCardsChanged, onChatCardsChanged, type ChatCard } from '@/utils/chatCards'
import { downloadBlob } from '@/utils/downloadBlob'
import { useChatRoomDismissGuard } from './useChatRoomDismissGuard'
import {
  fetchChatCardExport,
  createChatCard,
  createEmptyCardDocument,
  deleteChatCard,
  fetchCatalogCharacterOptions,
  fetchChatCardDetail,
  fetchVoiceOptions,
  listChatCardSummaries,
  updateChatCard,
  type CardV2Document,
  type CardV2LoreEntry,
  type CatalogCharacterOption,
  type VoiceOption,
} from '@/utils/chatCardApi'

export interface ChatCardManagerEmit {
  (e: 'close'): void
  (e: 'select-character', id: string): void
  (e: 'cards-changed'): void
  (e: 'notice', message: string, kind?: 'info' | 'warning' | 'error'): void
}

function normalizeDraftDocument(doc: CardV2Document): CardV2Document {
  const base = createEmptyCardDocument()
  const raw = doc?.data || ({} as CardV2Document['data'])
  return {
    spec: doc?.spec === 'chara_card_v3' ? 'chara_card_v3' : 'chara_card_v2',
    spec_version: doc?.spec_version || '2.0',
    data: {
      ...base.data,
      ...raw,
      alternate_greetings: Array.isArray(raw.alternate_greetings) ? [...raw.alternate_greetings] : [],
      character_book: raw.character_book
        ? {
            ...raw.character_book,
            entries: Array.isArray(raw.character_book.entries)
              ? raw.character_book.entries.map((entry: CardV2LoreEntry) => ({
                  ...entry,
                  keys: Array.isArray(entry.keys) ? [...entry.keys] : [],
                  secondary_keys: Array.isArray(entry.secondary_keys) ? [...entry.secondary_keys] : [],
                  position: entry.position === 'before_char' || entry.position === 'at_depth' ? entry.position : 'after_char',
                  enabled: entry.enabled !== false,
                }))
              : [],
          }
        : undefined,
      extensions: {
        ...(raw.extensions || {}),
        depth_prompt: raw.extensions?.depth_prompt
          ? { prompt: raw.extensions.depth_prompt.prompt || '', depth: raw.extensions.depth_prompt.depth ?? 1 }
          : { prompt: '', depth: 1 },
        huiyu: { ...(raw.extensions?.huiyu || {}) },
      },
    },
  }
}

/** Owns SillyTavern Card v2/v3 listing, editing draft state, avatar previews, and CRUD mutations. */
export function useChatCardManager(emit: ChatCardManagerEmit, canEdit: () => boolean) {
  const mode = ref<'list' | 'edit'>('list')
  const search = ref('')
  const loading = ref(true)
  const loadError = ref('')
  const cards = ref<ChatCard[]>([])
  const catalogOptions = ref<CatalogCharacterOption[]>([])
  const voiceOptions = ref<VoiceOption[]>([])

  const openingId = ref('')
  const deletingId = ref('')
  const editingId = ref<string | null>(null)
  const draft = ref<CardV2Document>(createEmptyCardDocument())
  const saving = ref(false)
  const exporting = ref('')
  const saveError = ref('')
  let originalDraft = ''
  let refreshVersion = 0

  const avatarInputRef = ref<HTMLInputElement>()
  const pendingAvatarFile = ref<File | null>(null)
  const removeAvatarFlag = ref(false)
  const existingAvatarUrl = ref('')
  let objectAvatarUrl = ''

  const controller = new AbortController()
  onBeforeUnmount(() => {
    controller.abort()
    if (objectAvatarUrl) URL.revokeObjectURL(objectAvatarUrl)
  })

  const avatarPreviewUrl = computed(() => {
    if (removeAvatarFlag.value) return ''
    if (pendingAvatarFile.value && objectAvatarUrl) return objectAvatarUrl
    return existingAvatarUrl.value
  })

  const filteredCards = computed(() => {
    const q = search.value.trim().toLowerCase()
    if (!q) return cards.value
    return cards.value.filter(card =>
      card.name.toLowerCase().includes(q)
      || card.description.toLowerCase().includes(q)
      || (card.catalogId && card.catalogId.toLowerCase().includes(q))
      || (card.voiceId && card.voiceId.toLowerCase().includes(q)),
    )
  })

  const catalogSelectOptions = computed(() => [
    { value: '', label: '不绑定绘图素材角色' },
    ...catalogOptions.value.map(item => ({
      value: item.id,
      label: item.franchise ? `${item.name} · ${item.franchise}` : item.name,
    })),
  ])

  const voiceSelectOptions = computed(() => [
    { value: '', label: '不绑定语音音色' },
    ...voiceOptions.value.map(item => ({ value: item.id, label: `${item.label} (${item.id})` })),
  ])

  const huiyuCatalogId = computed({
    get: () => draft.value.data.extensions.huiyu?.character_id || '',
    set: (value: string) => {
      draft.value.data.extensions.huiyu ||= {}
      if (value) draft.value.data.extensions.huiyu.character_id = value
      else delete draft.value.data.extensions.huiyu.character_id
    },
  })

  const huiyuVoiceId = computed({
    get: () => draft.value.data.extensions.huiyu?.voice_id || '',
    set: (value: string) => {
      draft.value.data.extensions.huiyu ||= {}
      if (value) draft.value.data.extensions.huiyu.voice_id = value
      else delete draft.value.data.extensions.huiyu.voice_id
    },
  })

  const catalogBindingLabel = computed(() => huiyuCatalogId.value ? catalogNameOf(huiyuCatalogId.value) : '未绑定')
  const voiceBindingLabel = computed(() => huiyuVoiceId.value ? voiceNameOf(huiyuVoiceId.value) : '未绑定')

  const depthPromptText = computed({
    get: () => draft.value.data.extensions.depth_prompt?.prompt || '',
    set: (value: string) => {
      draft.value.data.extensions.depth_prompt ||= { prompt: '', depth: 1 }
      draft.value.data.extensions.depth_prompt.prompt = value
    },
  })

  const depthPromptDepth = computed({
    get: () => draft.value.data.extensions.depth_prompt?.depth ?? 1,
    set: (value: number) => {
      draft.value.data.extensions.depth_prompt ||= { prompt: '', depth: 1 }
      const clamped = Number.isFinite(value) ? Math.max(0, Math.min(16, Math.round(value))) : 1
      draft.value.data.extensions.depth_prompt.depth = clamped
    },
  })

  const cardLoreEntries = computed(() => draft.value.data.character_book?.entries || [])
  const entryKeys = new WeakMap<CardV2LoreEntry, number>()
  let nextEntryKey = 0
  function cardLoreKey(entry: CardV2LoreEntry) {
    let key = entryKeys.get(entry)
    if (key === undefined) {
      key = ++nextEntryKey
      entryKeys.set(entry, key)
    }
    return key
  }

  function catalogNameOf(id: string): string {
    return catalogOptions.value.find(item => item.id === id)?.name || id
  }

  function voiceNameOf(id: string): string {
    return voiceOptions.value.find(item => item.id === id)?.label || id
  }

  function addCardLore() {
    draft.value.data.character_book ||= { entries: [] }
    draft.value.data.character_book.entries.push({
      comment: '',
      keys: [],
      secondary_keys: [],
      content: '',
      enabled: true,
      position: 'after_char',
      insertion_order: 100,
      depth: 4,
    })
  }

  function removeCardLore(index: number) {
    draft.value.data.character_book?.entries.splice(index, 1)
  }

  function resetAvatarDraft(initialUrl = '') {
    if (objectAvatarUrl) {
      URL.revokeObjectURL(objectAvatarUrl)
      objectAvatarUrl = ''
    }
    pendingAvatarFile.value = null
    removeAvatarFlag.value = false
    existingAvatarUrl.value = initialUrl
  }

  function onPickAvatar(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (objectAvatarUrl) URL.revokeObjectURL(objectAvatarUrl)
    objectAvatarUrl = URL.createObjectURL(file)
    pendingAvatarFile.value = file
    removeAvatarFlag.value = false
  }

  function clearAvatar() {
    if (objectAvatarUrl) {
      URL.revokeObjectURL(objectAvatarUrl)
      objectAvatarUrl = ''
    }
    pendingAvatarFile.value = null
    existingAvatarUrl.value = ''
    removeAvatarFlag.value = true
  }

  async function refreshAll() {
    const version = ++refreshVersion
    loading.value = true
    loadError.value = ''
    try {
      const [cardList, catalogs, voices] = await Promise.all([
        listChatCardSummaries(controller.signal),
        fetchCatalogCharacterOptions(controller.signal),
        fetchVoiceOptions(controller.signal),
      ])
      if (controller.signal.aborted || version !== refreshVersion) return
      cards.value = cardList
      catalogOptions.value = catalogs
      voiceOptions.value = voices
    } catch (error) {
      if (!controller.signal.aborted && version === refreshVersion) {
        loadError.value = error instanceof Error ? error.message : '读取角色卡列表失败'
      }
    } finally {
      if (version === refreshVersion) loading.value = false
    }
  }

  onMounted(() => {
    onChatCardsChanged(() => { void refreshAll() }, controller.signal)
    void refreshAll()
  })

  function startCreate() {
    if (!canEdit() || openingId.value) return
    editingId.value = null
    draft.value = createEmptyCardDocument()
    originalDraft = JSON.stringify(draft.value)
    saveError.value = ''
    resetAvatarDraft('')
    mode.value = 'edit'
  }

  async function startEdit(id: string) {
    if (!canEdit() || openingId.value) return
    openingId.value = id
    saveError.value = ''
    try {
      const detail = await fetchChatCardDetail(id, controller.signal)
      if (controller.signal.aborted || !canEdit()) return
      editingId.value = detail.id
      draft.value = normalizeDraftDocument(detail.document)
      originalDraft = JSON.stringify(draft.value)
      resetAvatarDraft(detail.summary.avatarUrl || '')
      mode.value = 'edit'
    } catch (error) {
      if (!controller.signal.aborted) {
        emit('notice', error instanceof Error ? error.message : '读取角色卡详情失败', 'warning')
      }
    } finally {
      openingId.value = ''
    }
  }

  function showList() {
    mode.value = 'list'
    editingId.value = null
    saveError.value = ''
    resetAvatarDraft('')
  }

  async function canDiscardDraft() {
    if (saving.value) return false
    if (mode.value !== 'edit' || (!pendingAvatarFile.value && !removeAvatarFlag.value && originalDraft === JSON.stringify(draft.value))) return true
    return confirmAction({
      title: '放弃未保存的角色卡修改？',
      message: '返回后，这次编辑的内容和头像修改将丢失。',
      confirmLabel: '放弃修改',
      danger: true,
      signal: controller.signal,
    })
  }
  useChatRoomDismissGuard(canDiscardDraft)

  async function backToList() {
    if (await canDiscardDraft()) showList()
  }

  async function exportCard(card: ChatCard, format: 'json' | 'png') {
    if (exporting.value) return
    exporting.value = `${card.id}:${format}`
    try {
      const blob = await fetchChatCardExport(card.id, format, controller.signal)
      if (!controller.signal.aborted) downloadBlob(blob, `card-${card.id.slice(5, 17)}.${format}`)
    } catch (error) {
      if (!controller.signal.aborted) emit('notice', error instanceof Error ? error.message : '导出角色卡失败', 'warning')
    } finally {
      exporting.value = ''
    }
  }

  function selectAndClose(id: string) {
    emit('select-character', id)
    emit('close')
  }

  async function saveCard() {
    if (!canEdit() || saving.value || !draft.value.data.name.trim()) return
    saving.value = true
    saveError.value = ''
    try {
      const payload = normalizeDraftDocument(draft.value)
      payload.data.alternate_greetings = payload.data.alternate_greetings.filter(item => Boolean(item.trim()))
      if (payload.data.character_book && !payload.data.character_book.entries.length) {
        delete payload.data.character_book
      }
      const saved = editingId.value
        ? await updateChatCard(editingId.value, payload, {
            avatarFile: pendingAvatarFile.value,
            removeAvatar: removeAvatarFlag.value,
            signal: controller.signal,
          })
        : await createChatCard(payload, pendingAvatarFile.value, controller.signal)
      await loadChatCards().catch(() => {})
      announceChatCardsChanged()
      emit('cards-changed')
      emit('notice', editingId.value ? `已更新角色卡「${saved.name}」` : `已创建角色卡「${saved.name}」`, 'info')
      showList()
    } catch (error) {
      if (!controller.signal.aborted) {
        saveError.value = error instanceof Error ? error.message : '保存角色卡失败'
      }
    } finally {
      saving.value = false
    }
  }

  async function requestDelete(card: ChatCard) {
    if (!canEdit() || deletingId.value) return
    const isCatalog = card.source === 'catalog'
    const confirmed = await confirmAction({
      title: isCatalog ? `恢复「${card.name}」为默认角色卡？` : `删除角色卡「${card.name}」？`,
      message: isCatalog
        ? '将移除你对该目录卡片的本地修改与自定义头像，恢复项目默认配置。'
        : '删除后不可恢复。已有聊天记录仍保留在本地存档中，但角色卡定义将被移除。',
      confirmLabel: isCatalog ? '恢复默认' : '删除角色卡',
      danger: true,
    })
    if (!confirmed || !canEdit() || controller.signal.aborted || deletingId.value) return
    deletingId.value = card.id
    try {
      const res = await deleteChatCard(card.id, controller.signal)
      await loadChatCards().catch(() => {})
      announceChatCardsChanged()
      emit('cards-changed')
      emit('notice', res.restoredCatalog ? `已恢复「${card.name}」为默认设定` : `已删除角色卡「${card.name}」`, 'info')
    } catch (error) {
      if (!controller.signal.aborted) {
        emit('notice', error instanceof Error ? error.message : '操作失败', 'warning')
      }
    } finally {
      deletingId.value = ''
    }
  }

  return {
    mode,
    search,
    loading,
    loadError,
    openingId,
    deletingId,
    editingId,
    draft,
    saving,
    exporting,
    saveError,
    avatarInputRef,
    avatarPreviewUrl,
    filteredCards,
    catalogSelectOptions,
    voiceSelectOptions,
    huiyuCatalogId,
    huiyuVoiceId,
    catalogBindingLabel,
    voiceBindingLabel,
    depthPromptText,
    depthPromptDepth,
    cardLoreEntries,
    cardLoreKey,
    exportCard,
    catalogNameOf,
    voiceNameOf,
    addCardLore,
    removeCardLore,
    onPickAvatar,
    clearAvatar,
    startCreate,
    startEdit,
    backToList,
    selectAndClose,
    saveCard,
    requestDelete,
  }
}
