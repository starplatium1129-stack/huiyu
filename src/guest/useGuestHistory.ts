import { computed, onScopeDispose, ref } from 'vue'
import type { CatalogItem } from './useGuestCatalog'
import type { GuestResultPayload } from './useGuestGeneration'

export interface GuestArtworkMeta {
  title: string
  prompt: string
  character?: CatalogItem
  scene?: CatalogItem
}

export interface GuestHistoryItem extends GuestArtworkMeta {
  id: string
  url: string
  blob: Blob
  createdAt: number
  seed?: number
  elapsedMs: number
  width?: number
  height?: number
}

export function useGuestHistory(maxItems = 12) {
  const history = ref<GuestHistoryItem[]>([])
  const currentId = ref<string | null>(null)
  const currentArtwork = computed(
    () => history.value.find(item => item.id === currentId.value) ?? null,
  )

  onScopeDispose(() => {
    for (const item of history.value) URL.revokeObjectURL(item.url)
  })

  function recordResult(payload: GuestResultPayload, meta: GuestArtworkMeta) {
    const url = URL.createObjectURL(payload.blob)
    const item: GuestHistoryItem = {
      id: crypto.randomUUID(),
      url,
      blob: payload.blob,
      createdAt: Date.now(),
      seed: payload.seed,
      elapsedMs: payload.elapsedMs,
      title: meta.title,
      prompt: meta.prompt,
      character: meta.character,
      scene: meta.scene,
    }

    const nextHistory = [item, ...history.value]
    while (nextHistory.length > maxItems) {
      const removed = nextHistory.pop()
      if (removed) URL.revokeObjectURL(removed.url)
    }
    history.value = nextHistory
    currentId.value = item.id

    const probe = new Image()
    probe.onload = () => {
      const target = history.value.find(entry => entry.id === item.id)
      if (target && probe.naturalWidth && probe.naturalHeight) {
        target.width = probe.naturalWidth
        target.height = probe.naturalHeight
      }
    }
    probe.src = url
  }

  function selectItem(item: GuestHistoryItem) {
    currentId.value = item.id
  }

  function removeItem(item: GuestHistoryItem) {
    const index = history.value.findIndex(entry => entry.id === item.id)
    if (index < 0) return
    URL.revokeObjectURL(item.url)
    const remaining = history.value.filter(entry => entry.id !== item.id)
    history.value = remaining
    if (currentId.value === item.id) {
      currentId.value = remaining[Math.min(index, remaining.length - 1)]?.id ?? null
    }
  }

  function clearCurrent() {
    currentId.value = null
  }

  function downloadArtwork(item: GuestHistoryItem) {
    const safeTitle =
      (item.title || '绘遇画作').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || '绘遇画作'
    const suffix = typeof item.seed === 'number' ? String(item.seed) : String(item.createdAt)
    const link = document.createElement('a')
    link.href = item.url
    link.download = `绘遇-${safeTitle}-${suffix}.png`
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  return {
    history,
    currentArtwork,
    recordResult,
    selectItem,
    removeItem,
    clearCurrent,
    downloadArtwork,
  }
}
