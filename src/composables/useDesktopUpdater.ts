import { computed, onScopeDispose, ref } from 'vue'
import { getDesktopUpdater, type DesktopUpdateState } from '@/platform/desktop/updater'

/** The Rust process owns update progress; each banner only subscribes to it. */
export function useDesktopUpdater() {
  const availableVersion = ref('')
  const statusText = ref('')
  const phase = ref<DesktopUpdateState['phase']>('idle')
  const canCancel = ref(false)
  const starting = ref(false), cancelPending = ref(false)
  const errorText = ref('')
  const installing = computed(() => ['checking', 'downloading', 'verifying', 'cancelling', 'installing'].includes(phase.value))
  const cancelling = computed(() => cancelPending.value || phase.value === 'cancelling')
  let disposed = false, checkRevision = 0, installCallPending = false

  const api = getDesktopUpdater()
  // Browsers lack this optional capability; automatic checks remain silent.
  const supported = api !== null
  const foundSubscription = api?.onFound(version => {
    if (!disposed && !installing.value && !starting.value) { checkRevision++; availableVersion.value = version }
  })
  const observation = api?.observe(state => {
    checkRevision++
    phase.value = state.phase
    if (state.version || state.phase === 'idle') availableVersion.value = state.version
    statusText.value = state.statusText
    errorText.value = state.errorText
    canCancel.value = state.canCancel
    starting.value = false
    cancelPending.value = false
  })
  const ready = observation?.ready ?? Promise.resolve()
  // Mounting is optional background work. Explicit actions report IPC failures.
  void ready.catch(() => {})

  async function check(silent = false): Promise<void> {
    if (!api || disposed) return
    try {
      await ready
      const preserveTerminal = silent && (phase.value === 'cancelled' || phase.value === 'failed')
      if (disposed || installing.value || starting.value
        || (silent && phase.value !== 'idle' && !(preserveTerminal && !availableVersion.value))) return
      const revision = ++checkRevision
      const current = () => !disposed && !installing.value && !starting.value && revision === checkRevision
      try {
        const version = await api.check()
        if (!current()) return
        availableVersion.value = version ?? ''
        if (!preserveTerminal) { statusText.value = ''; errorText.value = '' }
      } catch (error) {
        if (current() && !preserveTerminal) errorText.value = silent ? '' : message(error)
      }
    } catch (error) {
      if (!disposed && !silent) errorText.value = message(error)
    }
  }

  function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
  async function reconcile(error?: unknown) {
    try { await observation?.refresh() } catch { /* Preserve the last known native phase if IPC fails. */ }
    if (!disposed && error !== undefined && !installing.value && !errorText.value) errorText.value = message(error)
  }

  async function install(): Promise<void> {
    if (!api || disposed || installing.value || installCallPending) return
    installCallPending = true
    try {
      await ready
      if (disposed || installing.value) return
      checkRevision++
      starting.value = true
      errorText.value = ''
      await api.install()
      if (!disposed) await reconcile()
    } catch (error) {
      if (!disposed) await reconcile(error)
    } finally {
      installCallPending = false
      if (!disposed) starting.value = false
    }
  }

  async function cancel(): Promise<void> {
    if (!api || disposed || !canCancel.value || cancelling.value) return
    cancelPending.value = true
    try {
      await api.cancel()
      if (!disposed) await reconcile()
    } catch (error) {
      if (!disposed) await reconcile(error)
    } finally {
      if (!disposed) cancelPending.value = false
    }
  }

  onScopeDispose(() => {
    disposed = true
    checkRevision++
    observation?.dispose()
    if (foundSubscription !== undefined) api?.off(foundSubscription)
  })

  return { availableVersion, statusText, installing, cancelling, canCancel, starting, errorText, supported, check, install, cancel }
}
