import { onActivated, onDeactivated, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { getDesktopRuntime, onDesktopRuntime } from '@/platform/desktop/runtime'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { createImageReadSlot } from '@/utils/imageReadSlot'

/** Includes workspace changes within the same runtime; Web reads remain valid. */
export function imageMediaSession() {
  const state = getDesktopRuntime(), runtime = state.bootstrap?.runtime, workspace = runtime?.workspace
  return JSON.stringify([runtimeResourceIdentity(), state.connection, state.bootstrap?.sourceProfileId, runtime?.origin, runtime?.runtimeEpoch,
    workspace?.workspaceId, workspace?.principalId, workspace?.runtimeEpoch, workspace?.generation])
}

interface OriginalRead {
  read: (signal: AbortSignal, repository: ArtworkRepository) => Promise<Blob | string | null>
  current: () => boolean
  preserve?: boolean
}
/** Owns one original and one actual read, with only the latest selection queued.
 * Strings are borrowed gallery fallbacks; only URLs created from Blobs are revoked. */
export function useOriginalImage() {
  const url = shallowRef(''), error = ref(''), loading = ref(false), session = shallowRef(imageMediaSession())
  const reads = createImageReadSlot()
  let objectUrl = '', active: AbortController | null = null, attached = true, disposed = false

  function stop() {
    active?.abort(); active = null; reads.stop(); loading.value = false
  }
  function clearImage() {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = ''; url.value = ''
  }
  function release() { stop(); clearImage(); error.value = '' }
  async function load(input: OriginalRead): Promise<void> {
    stop()
    if (disposed || !attached || !input.current()) return
    if (!input.preserve) clearImage()
    error.value = ''; loading.value = true
    const controller = new AbortController(), repository = artworkRepository, mediaSession = imageMediaSession()
    active = controller
    const current = () => !disposed && attached && active === controller && !controller.signal.aborted && input.current()
      && repository === artworkRepository && mediaSession === imageMediaSession()
    const timer = setTimeout(() => {
      if (active !== controller) return
      if (current()) error.value = '原图读取超时，请重试。'
      controller.abort(new DOMException('原图读取超时', 'TimeoutError'))
      reads.stop(); active = null; loading.value = false
    }, 35_000)
    try {
      const result = await reads.read(signal => input.read(signal, repository), { signal: controller.signal, current })
      if (!current()) return
      // Legacy Web originals may have no MIME; the viewer owns actual decoding.
      // Sources with stricter transport contracts validate those in their reader.
      if (!result || result instanceof Blob && !result.size) throw new Error('原图不可用')
      const next = typeof result === 'string' ? result : URL.createObjectURL(result)
      clearImage()
      objectUrl = typeof result === 'string' ? '' : next
      url.value = next
    } catch {
      if (current()) error.value = '原图暂时无法读取，请重试。'
    } finally {
      clearTimeout(timer)
      if (active === controller) { active = null; loading.value = false }
    }
  }
  function refreshSession() {
    const next = imageMediaSession()
    if (next === session.value) return
    const hadOriginal = Boolean(url.value || loading.value)
    release(); session.value = next
    if (hadOriginal) error.value = '图片连接已变化，请重新读取原图。'
  }
  const stopRuntime = onDesktopRuntime(refreshSession)
  watch(runtimeResourceIdentity, refreshSession, { flush: 'sync' })
  onDeactivated(() => { attached = false; release() })
  onActivated(() => { attached = true })
  onScopeDispose(() => { disposed = true; stopRuntime(); release() })
  return { url, error, loading, session, load, stop, release }
}
