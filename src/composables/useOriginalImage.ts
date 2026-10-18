import { onActivated, onDeactivated, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { getDesktopRuntime, onDesktopRuntime } from '@/platform/desktop/runtime'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

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
interface PendingRead {
  input: OriginalRead; controller: AbortController; repository: ArtworkRepository; session: string
  done: () => void; timer?: ReturnType<typeof setTimeout>
}

/** Owns one original and one actual read, with only the latest selection queued.
 * Strings are borrowed gallery fallbacks; only URLs created from Blobs are revoked. */
export function useOriginalImage() {
  const url = shallowRef(''), error = ref(''), loading = ref(false), session = shallowRef(imageMediaSession())
  let objectUrl = '', active: PendingRead | null = null, queued: PendingRead | null = null
  let reading = false, attached = true, disposed = false

  function finish(request: PendingRead) { clearTimeout(request.timer); request.done() }
  function stop() {
    if (active) { active.controller.abort(); finish(active) }
    active = null; queued = null; loading.value = false
  }
  function clearImage() {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = ''; url.value = ''
  }
  function release() { stop(); clearImage(); error.value = '' }
  function current(request: PendingRead) {
    return !disposed && attached && active === request && !request.controller.signal.aborted && request.input.current()
      && request.repository === artworkRepository && request.session === imageMediaSession()
  }
  async function pump() {
    if (reading || !queued) return
    const request = queued
    queued = null
    if (!current(request)) {
      if (active === request) { active = null; loading.value = false }
      finish(request); return
    }
    reading = true
    try {
      const result = await request.input.read(request.controller.signal, request.repository)
      if (!current(request)) return
      // Legacy Web originals may have no MIME; the viewer owns actual decoding.
      // Sources with stricter transport contracts validate those in their reader.
      if (!result || result instanceof Blob && !result.size) throw new Error('原图不可用')
      const next = typeof result === 'string' ? result : URL.createObjectURL(result)
      clearImage()
      objectUrl = typeof result === 'string' ? '' : next
      url.value = next
    } catch {
      if (current(request)) error.value = '原图暂时无法读取，请重试。'
    } finally {
      finish(request)
      if (active === request) { active = null; loading.value = false }
      // Abort/timeout can finish the UI wait before IndexedDB actually returns.
      // Keep its slot occupied until here, then admit only the latest selection.
      reading = false
      void pump()
    }
  }
  function load(input: OriginalRead): Promise<void> {
    stop()
    if (disposed || !attached || !input.current()) return Promise.resolve()
    if (!input.preserve) clearImage()
    error.value = ''; loading.value = true
    const completion = new Promise<void>(done => {
      const request: PendingRead = { input, controller: new AbortController(), repository: artworkRepository, session: imageMediaSession(), done }
      active = request; queued = request
      request.timer = setTimeout(() => {
        if (active !== request) return
        if (current(request)) error.value = '原图读取超时，请重试。'
        request.controller.abort(new DOMException('原图读取超时', 'TimeoutError'))
        if (queued === request) queued = null
        active = null; loading.value = false; finish(request)
      }, 35_000)
    })
    void pump()
    return completion
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
