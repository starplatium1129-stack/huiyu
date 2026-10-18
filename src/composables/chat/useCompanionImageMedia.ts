import { onScopeDispose, ref, shallowRef } from 'vue'
import type { CompanionChatImage } from '@/types/companionDrawing'
import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { fetchRuntimeResult, isRuntimeResultPath } from '@/api/runtimeTasks'
import { blobThumbDataUrl } from '@/utils/imageThumb'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { useOriginalImage } from '../useOriginalImage'
import { imageMediaSession as mediaSession } from '@/platform/imageMediaSession'

export const companionImageKey = (image: CompanionChatImage) => JSON.stringify([image.imageId || '', image.path])
const mediaId = (image: CompanionChatImage) => image.imageId || (/^(?:image-|img_|task-)/.test(image.path) ? image.path : '')
/** Message cards retain only derived previews; an open dialog owns one original. */
export function useCompanionImageMedia(isActive: () => boolean, onSessionChange: (ready: boolean) => void) {
  const sources = shallowRef<Record<string, string>>({})
  const failures = shallowRef<Record<string, boolean>>({})
  const thumbnailsLoading = ref(false)
  const original = useOriginalImage()
  const { url: originalUrl, loading: originalLoading, error: originalError, release: releaseOriginal } = original
  const rejectedThumbnails = new Set<string>()
  let thumbnails: AbortController | null = null
  let previewRepository = artworkRepository
  let thumbnailImages: CompanionChatImage[] = [], thumbnailKeys = new Set<string>()
  let disposed = false

  async function readOriginal(image: CompanionChatImage, signal: AbortSignal, repository: ArtworkRepository) {
    signal.throwIfAborted()
    const id = mediaId(image)
    let blob = id ? await repository.getImage(id, signal) : null
    signal.throwIfAborted()
    // A generated task can still own its result after the optional album alias is gone.
    if (!blob && isRuntimeResultPath(image.path)) blob = await fetchRuntimeResult(image.path, signal)
    signal.throwIfAborted()
    if (!blob?.size || !blob.type.startsWith('image/')) throw new Error('图片暂时无法读取')
    return blob
  }

  function releaseThumbnails() {
    thumbnails?.abort(); thumbnails = null
    sources.value = {}; failures.value = {}; thumbnailsLoading.value = false
    thumbnailImages = []; thumbnailKeys.clear()
  }
  async function loadThumbnails(images: readonly CompanionChatImage[], retry = false): Promise<void> {
    if (disposed || !isActive()) return
    if (previewRepository !== artworkRepository) { releaseThumbnails(); rejectedThumbnails.clear(); previewRepository = artworkRepository }
    const list = [...new Map(images.map(image => [companionImageKey(image), { ...image }])).values()]
    const keys = new Set(list.map(companionImageKey))
    thumbnailImages = list
    sources.value = Object.fromEntries(Object.entries(sources.value).filter(([key]) => keys.has(key)))
    failures.value = Object.fromEntries(Object.entries(failures.value).filter(([key]) => keys.has(key)))
    for (const key of rejectedThumbnails) if (!keys.has(key)) rejectedThumbnails.delete(key)
    const appendOnly = [...thumbnailKeys].every(key => keys.has(key))
    thumbnailKeys = keys
    if (!retry && thumbnails && appendOnly) return
    thumbnails?.abort(); thumbnails = null; thumbnailsLoading.value = false
    const pending = list.filter(image => !sources.value[companionImageKey(image)] && (retry || !failures.value[companionImageKey(image)]))
    if (!pending.length) return
    const request = new AbortController(), repository = artworkRepository, session = mediaSession()
    thumbnails = request; thumbnailsLoading.value = true
    const current = () => !disposed && isActive() && thumbnails === request && !request.signal.aborted
      && repository === artworkRepository && session === mediaSession()
    try {
      // Serial fallback decoding avoids requesting every full attachment in a message at once.
      for (const image of pending) {
        if (!current()) return
        const key = companionImageKey(image), id = mediaId(image)
        try {
          let thumbnail = id && !rejectedThumbnails.has(key) ? await repository.getThumbnail(id).catch(() => null) : null
          if (!current()) return
          if (!thumbnail?.startsWith('data:image/')) {
            const blob = await readOriginal(image, request.signal, repository)
            if (!current()) return
            thumbnail = await blobThumbDataUrl(blob)
            if (!current()) return
          }
          if (thumbnail?.startsWith('data:image/')) {
            sources.value = { ...sources.value, [key]: thumbnail }
            const remaining = { ...failures.value }; delete remaining[key]; failures.value = remaining
          }
          else failures.value = { ...failures.value, [key]: true }
        } catch {
          if (current()) failures.value = { ...failures.value, [key]: true }
        }
      }
    } finally {
      if (thumbnails === request) {
        thumbnails = null; thumbnailsLoading.value = false
        // Appended images wait for the current serial reader; successful entries stay
        // visible. A replacement authority clears its own old previews on entry.
        if (!disposed && isActive() && !request.signal.aborted
          && session === mediaSession()) await loadThumbnails(thumbnailImages)
      }
    }
  }

  function rejectThumbnail(image: CompanionChatImage) {
    const key = companionImageKey(image), next = { ...sources.value }
    // A syntactically valid cached data URL can still fail decoding. An explicit
    // retry must rebuild this preview instead of reading that same broken value.
    rejectedThumbnails.add(key)
    delete next[key]; sources.value = next
    failures.value = { ...failures.value, [key]: true }
  }

  function loadOriginal(image: CompanionChatImage) {
    const selection = { ...image }
    return original.load({ current: () => !disposed && isActive(), read: (signal, repository) => readOriginal(selection, signal, repository) })
  }
  function originalFailed() {
    if (!originalUrl.value) return
    releaseOriginal()
    originalError.value = '原图暂时无法显示，请重新读取。'
  }
  function release() { releaseThumbnails(); releaseOriginal(); rejectedThumbnails.clear() }
  let session = mediaSession()
  const stopRuntime = onDesktopRuntime(state => {
    const next = mediaSession()
    if (next === session) return
    session = next
    release(); onSessionChange(state.connection === 'ready')
  })
  onScopeDispose(() => { disposed = true; stopRuntime(); release() })
  return { sources, failures, thumbnailsLoading, originalUrl, originalLoading, originalError,
    loadThumbnails, rejectThumbnail, loadOriginal, releaseOriginal, originalFailed, release }
}
