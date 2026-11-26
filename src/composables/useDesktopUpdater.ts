import { computed, onScopeDispose, ref } from 'vue'
import { getDesktopUpdater, type DesktopUpdateState } from '@/platform/desktop/updater'

/** The Rust process owns update progress; each banner only subscribes to it. */
export function useDesktopUpdater() {
  const availableVersion = ref('')
  const currentVersion = ref('')
  const releaseNotes = ref('')
  const progress = ref<number | null>(null)
  const statusText = ref('')
  const phase = ref<DesktopUpdateState['phase']>('idle')
  const canCancel = ref(false)
  const starting = ref(false), cancelPending = ref(false), checking = ref(false)
  const reminderPending = ref(false)
  const errorText = ref('')
  const installing = computed(() => ['checking', 'downloading', 'verifying', 'cancelling', 'installing'].includes(phase.value))
  const cancelling = computed(() => cancelPending.value || phase.value === 'cancelling')
  let disposed = false, checkRevision = 0, checkRequest = 0, installCallPending = false

  const api = getDesktopUpdater()
  // Browsers lack this optional capability; automatic checks remain silent.
  const supported = api !== null
  const foundSubscription = api?.onFound(version => {
    if (!disposed && !installing.value && !starting.value && !reminderPending.value) {
      if (version !== availableVersion.value) releaseNotes.value = ''
      availableVersion.value = version
      void check(true)
    }
  })
  const observation = api?.observe(state => {
    checkRevision++
    phase.value = state.phase
    currentVersion.value = state.currentVersion || currentVersion.value
    progress.value = state.progress
    if (state.version || state.phase === 'idle') availableVersion.value = state.version
    statusText.value = state.statusText
    errorText.value = state.errorText
    canCancel.value = state.canCancel
    starting.value = false
  })
  const ready = observation?.ready ?? Promise.resolve()
  // Mounting is optional background work. Explicit actions report IPC failures.
  void ready.catch(() => {})

  async function check(silent = false): Promise<void> {
    if (!api || disposed) return
    try {
      await ready
      const preserveTerminal = silent && (phase.value === 'cancelled' || phase.value === 'failed')
      if (disposed || installing.value || starting.value || checking.value || reminderPending.value
        || (silent && phase.value !== 'idle' && !(preserveTerminal && !availableVersion.value))) return
      const revision = ++checkRevision
      const request = ++checkRequest
      checking.value = true
      const current = () => !disposed && !installing.value && !starting.value && revision === checkRevision
      try {
        const result = await api.check(!silent)
        if (!current()) return
        currentVersion.value = result.currentVersion || currentVersion.value
        availableVersion.value = result.available?.version ?? ''
        releaseNotes.value = result.available?.notes ?? ''
        if (!preserveTerminal) {
          statusText.value = !silent && !result.available ? '已是最新版本' : ''
          errorText.value = ''
        }
      } catch (error) {
        if (current() && !preserveTerminal) errorText.value = silent ? '' : message(error)
      } finally {
        if (!disposed && request === checkRequest) checking.value = false
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

  async function remind(choice: 'later' | 'skip') {
    const version = availableVersion.value
    if (!api || !version || reminderPending.value || installing.value) return
    reminderPending.value = true
    ++checkRevision
    try {
      await api.reminder(version, choice)
      if (!disposed && version === availableVersion.value) {
        availableVersion.value = ''
        releaseNotes.value = ''
        statusText.value = ''
        errorText.value = ''
      }
    } catch (error) {
      if (!disposed) errorText.value = message(error)
    } finally {
      if (!disposed) reminderPending.value = false
    }
  }

  async function openReleasePage() {
    try { await api?.openReleasePage() }
    catch (error) { if (!disposed) errorText.value = message(error) }
  }

  onScopeDispose(() => {
    disposed = true
    checkRevision++
    observation?.dispose()
    if (foundSubscription !== undefined) api?.off(foundSubscription)
  })

  return { availableVersion, currentVersion, releaseNotes, progress, statusText, installing, cancelling, canCancel,
    starting, checking, reminderPending, errorText, supported, check, install, cancel, remind, openReleasePage }
}
