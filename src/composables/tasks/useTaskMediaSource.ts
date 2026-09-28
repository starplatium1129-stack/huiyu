import { onUnmounted, ref, watch } from 'vue'
import { desktopRuntimeFetch, onDesktopRuntime } from '@/platform/desktop/runtime'
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'
import { getRuntimeTask, isRuntimeResultPath } from '@/api/runtimeTasks'

/** Native media elements receive a short-lived, one-object capability, never the session token. */
export function useTaskMediaSource(source: () => string) {
  const url = ref(''), error = ref('')
  let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0, disposed = false
  async function refresh() {
    const path = source(); const current = ++revision
    controller?.abort(); const request = new AbortController(); controller = request; clearTimeout(timer)
    if (!isRuntimeResultPath(path)) { url.value = resolveRuntimeUrl(path); error.value = ''; return }
    try {
      const parts = path.split('/'); const task = await getRuntimeTask(parts[4], request.signal)
      if (disposed || current !== revision || request.signal.aborted) return
      const media = task.resultRefs.find(ref => ref.index === Number(parts[6]))
      if (!media) throw new Error('任务结果尚未就绪')
      const response = await desktopRuntimeFetch('/api/workspace/media-capabilities', { method: 'POST', signal: request.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: media.alias }) })
      if (!response.ok) throw new Error('播放授权暂时无法续期')
      const capability = await response.json() as { url: string; expiresAt: number }
      if (disposed || current !== revision) return
      url.value = resolveRuntimeUrl(capability.url); error.value = ''
      timer = setTimeout(() => { void refresh() }, Math.max(1000, capability.expiresAt - Date.now() - 15000))
    } catch (cause) { if (!disposed && current === revision && !request.signal.aborted) error.value = cause instanceof Error ? cause.message : '媒体暂时无法读取' }
  }
  watch(source, () => { url.value = ''; void refresh() }, { immediate: true })
  let runtimeIdentity = ''
  const unsubscribe = onDesktopRuntime(state => {
    const identity = `${state.connection}:${state.bootstrap?.runtime?.workspace?.runtimeEpoch || ''}`
    if (identity === runtimeIdentity) return
    runtimeIdentity = identity
    if (state.connection === 'ready' && isRuntimeResultPath(source())) void refresh()
  })
  onUnmounted(() => { disposed = true; controller?.abort(); clearTimeout(timer); unsubscribe() })
  return { url, error, refresh }
}
