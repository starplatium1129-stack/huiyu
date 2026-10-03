import { hostApi, invokeHost, onHostEvent, offHostEvent } from './hostApi.ts'

const phases = ['idle', 'checking', 'downloading', 'verifying', 'cancelling', 'installing', 'cancelled', 'failed'] as const
export interface DesktopUpdateState {
  revision: number
  phase: typeof phases[number]
  version: string
  statusText: string
  errorText: string
  canCancel: boolean
}

function updateState(value: unknown): DesktopUpdateState {
  const state = value as Partial<DesktopUpdateState> | null
  if (!state || !Number.isSafeInteger(state.revision) || state.revision! < 0
    || !phases.includes(state.phase!) || typeof state.version !== 'string'
    || typeof state.statusText !== 'string' || typeof state.errorText !== 'string'
    || typeof state.canCancel !== 'boolean') throw new Error('桌面更新状态无效')
  return { revision: state.revision!, phase: state.phase!, version: state.version,
    statusText: state.statusText, errorText: state.errorText, canCancel: state.canCancel }
}

export function getDesktopUpdater() {
  const host = hostApi()
  if (!host) return null
  return {
    check: () => invokeHost<string | null>('desktop_update_check'),
    install: () => invokeHost<boolean>('desktop_update_install'),
    cancel: () => invokeHost<boolean>('desktop_update_cancel'),
    onFound: (listener: (version: string) => void) => onHostEvent<unknown>('desktop-update-found', value => { if (typeof value === 'string') listener(value) }),
    off: offHostEvent,
    observe(listener: (state: DesktopUpdateState) => void) {
      let disposed = false, revision = -1
      let remove: (() => void) | undefined
      function accept(value: unknown) {
        if (disposed) return
        const state = updateState(value)
        if (state.revision <= revision) return
        revision = state.revision
        listener(state)
      }
      const refresh = async () => { accept(await invokeHost<unknown>('desktop_update_state')) }
      // Wait for native listen registration before querying. A newer event may
      // arrive while the snapshot is in flight; its revision must win.
      const ready = host.event.listen<unknown>('desktop-update-state', event => {
        try { accept(event.payload) } catch { /* Invalid broadcasts cannot replace a native snapshot. */ }
      }).then(async unsubscribe => {
        if (disposed) { unsubscribe(); return }
        remove = unsubscribe
        await refresh()
      })
      return { ready, refresh, dispose() { disposed = true; remove?.(); remove = undefined } }
    },
  }
}
