import { onScopeDispose, ref } from 'vue'
import { CHAT_SCENE_STATE_KEY } from '@/utils/storageKeys'
import {
  extractStatusUpdate,
  loadChatSceneStates,
  normalizeChatSceneState,
  saveChatSceneStates,
  type ChatSceneState,
  type ChatSceneStateStore,
} from '@/utils/chatSceneState'

export function useChatSceneState() {
  const store = ref<ChatSceneStateStore>(loadChatSceneStates())

  function onStorage(event: StorageEvent) {
    if (event.key === null || event.key === CHAT_SCENE_STATE_KEY) {
      store.value = loadChatSceneStates()
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
    onScopeDispose(() => window.removeEventListener('storage', onStorage))
  }

  function getSceneState(characterId: string): ChatSceneState {
    return store.value[characterId] || { location: '', outfit: '', mood: '', updatedAt: 0 }
  }

  function updateSceneState(characterId: string, patch: Partial<ChatSceneState>) {
    if (!characterId) return
    const current = getSceneState(characterId)
    const next = normalizeChatSceneState({ ...current, ...patch, updatedAt: Date.now() })
    const nextStore = { ...store.value }
    if (!next.location && !next.outfit && !next.mood) {
      delete nextStore[characterId]
    } else {
      nextStore[characterId] = next
    }
    store.value = nextStore
    saveChatSceneStates(nextStore)
  }

  function clearSceneState(characterId: string) {
    if (!store.value[characterId]) return
    const nextStore = { ...store.value }
    delete nextStore[characterId]
    store.value = nextStore
    saveChatSceneStates(nextStore)
  }

  return {
    sceneStates: store,
    getSceneState,
    updateSceneState,
    clearSceneState,
    extractStatusUpdate,
  }
}
