import { onActivated, onDeactivated, onUnmounted, ref, watch } from 'vue'
import { desktopRuntimeFetch, getDesktopRuntime, onDesktopRuntime } from '@/platform/desktop/runtime'
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'
import { resolveRuntimeResult, isRuntimeResultPath } from '@/api/runtimeTasks'
import { assertWorkspaceMediaAuthority } from '@/platform/desktop/workspaceMediaSource'

/** Native media elements receive a short-lived, one-object capability, never the session token. */
export function useTaskMediaSource(source: () => string) {
  const url = ref(''), error = ref('')
  let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0, disposed = false, active = true
  // A new workspace cannot take over the same logical task path. Reconnecting
  // the original workspace may renew its capability under the new session.
  let sourceOwner: string | null = null
  const owner = () => {
    const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace
    return workspace?.workspaceId && workspace.principalId ? JSON.stringify([workspace.workspaceId, workspace.principalId]) : null
  }
  function stopRenewal() { revision++; controller?.abort(); clearTimeout(timer); timer = undefined }
  function checkOwner(): boolean {
    sourceOwner ??= owner()
    if (sourceOwner && sourceOwner === owner()) return true
    stopRenewal(); url.value = ''
    error.value = sourceOwner ? '结果所属工作区已变化，请回到原工作区读取' : '结果工作区尚未连接，请恢复原连接'
    return false
  }
  async function refresh() {
    if (disposed || !active) return
    const path = source()
    if (isRuntimeResultPath(path) && !checkOwner()) return
    const current = ++revision
    controller?.abort(); const request = new AbortController(); controller = request; clearTimeout(timer)
    if (!isRuntimeResultPath(path)) { url.value = resolveRuntimeUrl(path); error.value = ''; return }
    const deadline = AbortSignal.timeout(30_000)
    const signal = AbortSignal.any([request.signal, deadline])
    try {
      const result = await resolveRuntimeResult(path, signal), media = result.media
      if (disposed || current !== revision || request.signal.aborted) return
      if (!checkOwner()) return
      assertWorkspaceMediaAuthority(result.authority)
      const response = await desktopRuntimeFetch('/api/workspace/media-capabilities', { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: media.alias }) })
      if (!response.ok) throw new Error('播放授权暂时无法续期')
      const capability: unknown = await response.json()
      if (disposed || current !== revision || request.signal.aborted) return
      if (!checkOwner()) return
      assertWorkspaceMediaAuthority(result.authority)
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
  watch(source, () => { sourceOwner = isRuntimeResultPath(source()) ? owner() : null; url.value = ''; error.value = ''; void refresh() }, { immediate: true, flush: 'sync' })
  // The source watcher owns the first lookup; the subscription renews on later identity changes.
  let runtimeIdentity: string | undefined
  const unsubscribe = onDesktopRuntime(state => {
    const runtime = state.bootstrap?.runtime, workspace = runtime?.workspace
    const identity = JSON.stringify([state.connection, runtime?.origin, runtime?.runtimeEpoch,
      workspace?.workspaceId, workspace?.principalId, workspace?.runtimeEpoch, workspace?.generation])
    const previous = runtimeIdentity
    runtimeIdentity = identity
    if (!isRuntimeResultPath(source())) return
    if (!checkOwner()) return
    if (state.connection !== 'ready') { stopRenewal(); return }
    if (previous !== undefined && identity !== previous) void refresh()
  })
  // KeepAlive preserves the clip and playback position, not background renewal.
  onDeactivated(() => { active = false; stopRenewal() })
  onActivated(() => { if (!active) { active = true; void refresh() } })
  onUnmounted(() => { disposed = true; stopRenewal(); unsubscribe() })
  return { url, error, refresh, stopRenewal }
}
