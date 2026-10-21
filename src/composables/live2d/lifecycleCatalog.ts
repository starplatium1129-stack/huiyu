import { mediaStatusApi } from '@/api/mediaStatusApi'
import { getDesktopRuntime, onDesktopRuntime } from '@/platform/desktop/runtime'
import { readLive2DCatalog } from './catalog'
import type { Live2DCtx } from './context'
import { errorMessage } from './lifecycleUtils'
import { resolveCompanionAvatar } from '@/utils/companionRegistry'

/** The catalog belongs to one runtime, independently of a rendered model session. */
export function createLifecycleCatalog(ctx: Live2DCtx, recover: () => Promise<void>, failed: (detail: string) => void,
  releaseRuntime: () => void) {
  let pending: Promise<boolean> | null = null
  let request: AbortController | null = null
  let unsubscribe: (() => void) | undefined
  let revision = 0
  function invalidate() {
    revision++
    ctx.catalog = null
    request?.abort(); request = null; pending = null
  }
  function load(): Promise<boolean> {
    if (ctx.catalog) return Promise.resolve(true)
    if (pending) return pending
    const controller = new AbortController()
    request = controller
    pending = (async () => {
      try {
        const catalog = readLive2DCatalog(await mediaStatusApi.getLive2DStatus({ signal: controller.signal }))
        if (ctx.destroyed.value || controller.signal.aborted || request !== controller) return false
        ctx.catalog = catalog
        return true
      } catch (error) {
        if (!ctx.destroyed.value && !controller.signal.aborted) failed(errorMessage(error))
        return false
      } finally { if (request === controller) { request = null; pending = null } }
    })()
    return pending
  }
  function listen() {
    if (unsubscribe) return
    const identity = (state: ReturnType<typeof getDesktopRuntime>) => {
      const runtime = state.bootstrap?.runtime
      return `${runtime?.origin || ''}:${runtime?.runtimeEpoch || ''}`
    }
    let previous = getDesktopRuntime()
    unsubscribe = onDesktopRuntime(state => {
      const changed = identity(state) !== identity(previous)
        || previous.connection === 'ready' && state.connection !== 'ready'
      const reconnected = state.connection === 'ready' && previous.connection !== 'ready'
      previous = state
      if (ctx.destroyed.value) return
      if (changed) {
        invalidate(); releaseRuntime()
        failed('服务连接已变化；连接恢复后可重新检查模型资源。')
      }
      if (state.connection !== 'ready' || !changed && !reconnected || ctx.catalog) return
      const current = revision
      // A ready event may race the failed initial request. Settle that request
      // first, then recover once; periodic bootstrap refreshes do not retry it.
      void (pending ?? Promise.resolve()).then(() => {
        if (current === revision && getDesktopRuntime().connection === 'ready' && !ctx.catalog) return recover()
      })
    })
  }
  function destroy() { invalidate(); unsubscribe?.(); unsubscribe = undefined }
  function modelInfo(char: string) {
    const info = ctx.catalog?.models?.[char]
    const registered = resolveCompanionAvatar(char)
    return info && registered ? { ...info, modelUrl: registered.avatar.modelPath } : null
  }
  return { load, invalidate, listen, destroy, modelInfo }
}
