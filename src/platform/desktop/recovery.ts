import { hostApi, invokeHost } from './hostApi.ts'

const recoveryPhases = ['starting', 'ready', 'reconnecting', 'failed'] as const
export interface GatewayRecovery {
  revision: number
  phase: typeof recoveryPhases[number]
  reason: string
}

export function getDesktopRecovery() {
  const host = hostApi()
  if (!host || host.window.getCurrentWindow().label !== 'atelier') return null
  return {
    retryGateway: () => invokeHost<void>('desktop_gateway_retry'),
    exportDiagnostics: () => invokeHost<boolean>('desktop_export_diagnostics'),
    getRendererIsolation: () => invokeHost<boolean>('desktop_live2d_isolation'),
    setRendererIsolation: (enabled: boolean) => invokeHost<void>('desktop_set_live2d_isolation', { enabled }),
    getClipboardAwareness: () => invokeHost<boolean>('desktop_get_clipboard_awareness'),
    setClipboardAwareness: (enabled: boolean) => invokeHost<void>('desktop_set_clipboard_awareness', { enabled }),
    observeGateway(listener: (state: GatewayRecovery) => void) {
      let current = -1, disposed = false
      const accept = (raw: unknown) => {
        const value = raw as Partial<GatewayRecovery> | undefined
        if (disposed || !value || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)
          || value.revision <= current || !value.phase || !recoveryPhases.includes(value.phase) || typeof value.reason !== 'string') return
        current = value.revision
        listener({ revision: value.revision, phase: value.phase, reason: value.reason })
      }
      let unlisten: (() => void) | undefined
      const ready = host.event.listen<unknown>('aics:gateway-recovery', event => accept(event.payload), { target: 'atelier' }).then(async remove => {
        if (disposed) { remove(); return }
        unlisten = remove
        accept(await invokeHost<unknown>('desktop_gateway_recovery'))
      })
      return { ready, dispose() { disposed = true; unlisten?.() } }
    },
  }
}
