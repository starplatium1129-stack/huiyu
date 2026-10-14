import { onActivated, onDeactivated, onUnmounted, ref, watch } from 'vue'
import { desktopRuntimeFetch, onDesktopRuntime } from '@/platform/desktop/runtime'
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'
import { getRuntimeTask, isRuntimeResultPath } from '@/api/runtimeTasks'

/** Native media elements receive a short-lived, one-object capability, never the session token. */
export function useTaskMediaSource(source: () => string) {
  const url = ref(''), error = ref('')
  let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0, disposed = false, active = true
  function stopRenewal() { revision++; controller?.abort(); clearTimeout(timer); timer = undefined }
  async function refresh() {
    if (disposed || !active) return
    const path = source(); const current = ++revision
    controller?.abort(); const request = new AbortController(); controller = request; clearTimeout(timer)
    if (!isRuntimeResultPath(path)) { url.value = resolveRuntimeUrl(path); error.value = ''; return }
    const deadline = AbortSignal.timeout(30_000)
    const signal = AbortSignal.any([request.signal, deadline])
    try {
      const parts = path.split('/'); const task = await getRuntimeTask(parts[4], signal)
      if (disposed || current !== revision || request.signal.aborted) return
      const media = task.resultRefs.find(ref => ref.index === Number(parts[6]))
      if (!media) throw new Error('任务结果尚未就绪')
      const response = await desktopRuntimeFetch('/api/workspace/media-capabilities', { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: media.alias }) })
      if (!response.ok) throw new Error('播放授权暂时无法续期')
      const capability: unknown = await response.json()
      if (disposed || current !== revision || request.signal.aborted) return
      if (!capability || typeof capability !== 'object' || !('url' in capability)
        || typeof capability.url !== 'string' || !('expiresAt' in capability)
        || typeof capability.expiresAt !== 'number' || !Number.isSafeInteger(capability.expiresAt)
        || capability.expiresAt <= Date.now()) throw new Error('播放授权响应无效，请重新读取')
      const resolved = resolveRuntimeUrl(capability.url)
      if (!resolved || new URL(resolved, window.location.href).pathname !== `/api/workspace/media-content/${encodeURIComponent(media.alias)}`)
        throw new Error('播放授权响应无效，请重新读取')
      url.value = resolved; error.value = ''
      timer = setTimeout(() => { void refresh() }, Math.max(1000, capability.expiresAt - Date.now() - 15000))
    } catch (cause) { if (!disposed && current === revision && !request.signal.aborted) error.value = deadline.aborted ? '播放授权续期超时，请重试' : cause instanceof Error ? cause.message : '媒体暂时无法读取' }
  }
  watch(source, () => { url.value = ''; error.value = ''; void refresh() }, { immediate: true })
  // The source watcher owns the first lookup; the subscription renews on later identity changes.
  let runtimeIdentity: string | undefined
  const unsubscribe = onDesktopRuntime(state => {
    const identity = `${state.connection}:${state.bootstrap?.runtime?.workspace?.runtimeEpoch || ''}`
    const previous = runtimeIdentity
    runtimeIdentity = identity
    if (previous !== undefined && identity !== previous && state.connection === 'ready' && isRuntimeResultPath(source())) void refresh()
  })
  // KeepAlive preserves the clip and playback position, not background renewal.
  onDeactivated(() => { active = false; stopRenewal() })
  onActivated(() => { if (!active) { active = true; void refresh() } })
  onUnmounted(() => { disposed = true; stopRenewal(); unsubscribe() })
  return { url, error, refresh, stopRenewal }
}
