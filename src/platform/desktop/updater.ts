import { hostApi, invokeHost, onHostEvent, offHostEvent } from './hostApi.ts'

const phases = ['idle', 'checking', 'downloading', 'verifying', 'cancelling', 'installing', 'cancelled', 'failed'] as const
export interface DesktopUpdateState {
  revision: number
  currentVersion: string
  phase: typeof phases[number]
  version: string
  statusText: string
  errorText: string
  canCancel: boolean
  progress: number | null
}

interface UpdateCheck {
  currentVersion: string
  available: { version: string; notes: string } | null
}

function updateState(value: unknown): DesktopUpdateState {
  const state = value as Partial<DesktopUpdateState> | null
  if (!state || !Number.isSafeInteger(state.revision) || state.revision! < 0
    || !phases.includes(state.phase!) || typeof state.version !== 'string'
    || typeof state.statusText !== 'string' || typeof state.errorText !== 'string'
    || typeof state.canCancel !== 'boolean') throw new Error('桌面更新状态无效')
  return { revision: state.revision!, phase: state.phase!, version: state.version,
    currentVersion: typeof state.currentVersion === 'string' ? state.currentVersion : '',
    statusText: state.statusText, errorText: state.errorText, canCancel: state.canCancel,
    progress: typeof state.progress === 'number' && Number.isFinite(state.progress)
      && state.progress >= 0 && state.progress <= 1 ? state.progress : null }
}

function decodeUpdateCheck(value: unknown): UpdateCheck {
  if (value === null || typeof value === 'string') {
    return { currentVersion: '', available: value ? { version: value, notes: '' } : null }
  }
  const data = value as Partial<UpdateCheck> | undefined
  if (!data || typeof data.currentVersion !== 'string' || data.available !== null
    && (typeof data.available?.version !== 'string' || typeof data.available.notes !== 'string')) {
    throw new Error('桌面更新信息无效')
  }
  return { currentVersion: data.currentVersion, available: data.available ?? null }
}

export function getDesktopUpdater() {
  const host = hostApi()
  if (!host) return null
  return {
    check: async (manual: boolean) => decodeUpdateCheck(await invokeHost<unknown>('desktop_update_check', { manual })),
    current: async () => updateState(await invokeHost<unknown>('desktop_update_state')).currentVersion,
    install: () => invokeHost<boolean>('desktop_update_install'),
    cancel: () => invokeHost<boolean>('desktop_update_cancel'),
    reminder: (version: string, choice: 'later' | 'skip') => invokeHost<void>('desktop_update_reminder', { version, choice }),
    openReleasePage: () => invokeHost<void>('desktop_update_release_page'),
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
