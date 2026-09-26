import { mediaStatusApi } from '@/api/mediaStatusApi'
import { getDesktopRuntime, onDesktopRuntime } from '@/platform/desktop/runtime'
import { readLive2DCatalog } from './catalog'
import type { Live2DCtx } from './context'
import { errorMessage } from './lifecycleUtils'
import { resolveCompanionAvatar } from '@/utils/companionRegistry'

/** A missing startup catalog is recoverable when the desktop runtime connects. */
export function createLifecycleCatalog(ctx: Live2DCtx, recover: () => Promise<void>, failed: (detail: string) => void) {
  let pending: Promise<boolean> | null = null
  let request: AbortController | null = null
  let unsubscribe: (() => void) | undefined
  function load(): Promise<boolean> {
    if (ctx.catalog) return Promise.resolve(true)
    if (pending) return pending
    const controller = new AbortController()
    request = controller
    pending = (async () => {
      try {
        const catalog = readLive2DCatalog(await mediaStatusApi.getLive2DStatus({ signal: controller.signal }))
        if (ctx.destroyed.value || controller.signal.aborted) return false
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
    let connection = getDesktopRuntime().connection
    unsubscribe = onDesktopRuntime(state => {
      const reconnected = state.connection === 'ready' && connection !== 'ready'
      connection = state.connection
      if (!reconnected || ctx.catalog) return
      // A ready event may race the failed initial request. Settle that request
      // first, then recover once; periodic bootstrap refreshes do not retry it.
      void (pending ?? Promise.resolve()).then(() => { if (!ctx.catalog) return recover() })
    })
  }
  function destroy() { request?.abort(); unsubscribe?.(); unsubscribe = undefined }
  function modelInfo(char: string) {
    const info = ctx.catalog?.models?.[char]
    const registered = resolveCompanionAvatar(char)
    return info && registered ? { ...info, modelUrl: registered.avatar.modelPath } : null
  }
  return { load, listen, destroy, modelInfo }
}
