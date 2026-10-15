import { onScopeDispose, ref, shallowRef } from 'vue'
import type { CompanionChatImage } from '@/types/companionDrawing'
import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { fetchRuntimeResult, isRuntimeResultPath } from '@/api/runtimeTasks'
import { blobThumbDataUrl } from '@/utils/imageThumb'
import { getDesktopRuntime, onDesktopRuntime } from '@/platform/desktop/runtime'

export const companionImageKey = (image: CompanionChatImage) => image.imageId || image.path
const mediaId = (image: CompanionChatImage) => image.imageId || (/^(?:image-|img_|task-)/.test(image.path) ? image.path : '')
function mediaSession() {
  const state = getDesktopRuntime(), runtime = state.bootstrap?.runtime, workspace = runtime?.workspace
  return JSON.stringify([state.connection, state.bootstrap?.sourceProfileId, runtime?.origin, runtime?.runtimeEpoch,
    workspace?.workspaceId, workspace?.principalId, workspace?.runtimeEpoch, workspace?.generation])
}

/** Message cards retain only derived previews; an open dialog owns one original. */
export function useCompanionImageMedia(isActive: () => boolean, onSessionChange: (ready: boolean) => void) {
  const sources = shallowRef<Record<string, string>>({})
  const failures = shallowRef<Record<string, boolean>>({})
  const thumbnailsLoading = ref(false)
  const originalUrl = ref(''), originalLoading = ref(false), originalError = ref('')
  const rejectedThumbnails = new Set<string>()
  let thumbnails: AbortController | null = null, original: AbortController | null = null
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
  }
  async function loadThumbnails(images: readonly CompanionChatImage[]): Promise<void> {
    releaseThumbnails()
    if (disposed || !isActive()) return
    const request = new AbortController(), repository = artworkRepository, session = mediaSession()
    thumbnails = request; thumbnailsLoading.value = true
    const current = () => !disposed && isActive() && thumbnails === request && !request.signal.aborted
      && repository === artworkRepository && session === mediaSession()
    try {
      // Serial fallback decoding avoids requesting every full attachment in a message at once.
      for (const image of images.map(item => ({ ...item }))) {
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
          if (thumbnail?.startsWith('data:image/')) sources.value = { ...sources.value, [key]: thumbnail }
          else failures.value = { ...failures.value, [key]: true }
        } catch {
          if (current()) failures.value = { ...failures.value, [key]: true }
        }
      }
    } finally {
      if (thumbnails === request) {
        thumbnails = null; thumbnailsLoading.value = false
        // The first ready publication can precede platform adapter activation.
        // Discard its old response, then read through the newly selected authority.
        if (!disposed && isActive() && !request.signal.aborted
          && repository !== artworkRepository && session === mediaSession()) await loadThumbnails(images)
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

  function releaseOriginal() {
    original?.abort(); original = null
    if (originalUrl.value) URL.revokeObjectURL(originalUrl.value)
    originalUrl.value = ''; originalLoading.value = false; originalError.value = ''
  }
  async function loadOriginal(image: CompanionChatImage) {
    releaseOriginal()
    if (disposed || !isActive()) return
    const request = new AbortController(), repository = artworkRepository, session = mediaSession()
    original = request; originalLoading.value = true
    const current = () => !disposed && isActive() && original === request && !request.signal.aborted
      && repository === artworkRepository && session === mediaSession()
    try {
      const blob = await readOriginal({ ...image }, request.signal, repository)
      if (current()) originalUrl.value = URL.createObjectURL(blob)
    } catch {
      if (current()) originalError.value = '原图暂时无法读取，请重试。'
    } finally {
      if (original === request) { original = null; originalLoading.value = false }
    }
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
