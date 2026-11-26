import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { fetchRuntimeResult, isRuntimeResultPath } from '@/api/runtimeTasks'
import { CHAT_ROOM_BG_KEY } from '@/utils/storageKeys'
import {
  clearChatRoomBackground,
  loadChatRoomBackgrounds,
  setChatRoomBackground,
  updateChatRoomBackground,
  type ChatRoomBackgroundEntry,
  type ChatRoomBackgroundStore,
} from '@/utils/chatRoomBackgrounds'
import type { CompanionChatImage } from '@/types/companionDrawing'

export function useChatRoomBackground(activeChar: Ref<string>) {
  const store = ref<ChatRoomBackgroundStore>(loadChatRoomBackgrounds())
  const imageUrl = ref('')
  let activeObjectUrl = ''
  let resolverController: AbortController | null = null
  let disposed = false

  const entry = computed<ChatRoomBackgroundEntry | null>(() => store.value[activeChar.value] || null)

  function releaseUrl() {
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl)
      activeObjectUrl = ''
    }
    imageUrl.value = ''
  }

  async function resolveCurrentUrl() {
    resolverController?.abort()
    const current = entry.value
    if (!current || !current.enabled) {
      releaseUrl()
      return
    }
    const controller = new AbortController()
    resolverController = controller
    const image = current.image
    try {
      const id = image.imageId || (/^(?:image-|img_|task-)/.test(image.path) ? image.path : '')
      let blob = id ? await artworkRepository.getImage(id, controller.signal).catch(() => null) : null
      if (controller.signal.aborted || disposed) return
      if (!blob && isRuntimeResultPath(image.path)) {
        blob = await fetchRuntimeResult(image.path, controller.signal).catch(() => null)
      }
      if (controller.signal.aborted || disposed) return
      if (blob && blob.size && blob.type.startsWith('image/')) {
        const nextUrl = URL.createObjectURL(blob)
        releaseUrl()
        activeObjectUrl = nextUrl
        imageUrl.value = nextUrl
        return
      }
      const thumb = id ? await artworkRepository.getThumbnail(id).catch(() => null) : null
      if (controller.signal.aborted || disposed) return
      releaseUrl()
      imageUrl.value = thumb?.startsWith('data:image/') ? thumb : ''
    } catch {
      if (!controller.signal.aborted && !disposed) releaseUrl()
    }
  }

  watch(
    [activeChar, () => entry.value?.enabled, () => entry.value?.image?.imageId, () => entry.value?.image?.path],
    () => { void resolveCurrentUrl() },
    { immediate: true },
  )

  function onStorage(event: StorageEvent) {
    if (event.key === null || event.key === CHAT_ROOM_BG_KEY) {
      store.value = loadChatRoomBackgrounds()
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
  }

  onScopeDispose(() => {
    disposed = true
    resolverController?.abort()
    releaseUrl()
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  })

  function setBackground(image: CompanionChatImage, characterId = activeChar.value) {
    setChatRoomBackground(characterId, image)
    store.value = loadChatRoomBackgrounds()
  }

  function setOpacity(opacity: number, characterId = activeChar.value) {
    updateChatRoomBackground(characterId, { opacity })
    store.value = loadChatRoomBackgrounds()
  }

  function setEnabled(enabled: boolean, characterId = activeChar.value) {
    updateChatRoomBackground(characterId, { enabled })
    store.value = loadChatRoomBackgrounds()
  }

  function clearBackground(characterId = activeChar.value) {
    clearChatRoomBackground(characterId)
    store.value = loadChatRoomBackgrounds()
  }

  return {
    entry,
    imageUrl,
    setBackground,
    setOpacity,
    setEnabled,
    clearBackground,
  }
}
