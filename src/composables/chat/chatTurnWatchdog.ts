// Include module loading, connection/queue waits and interrupted streams.
const CHAT_FIRST_EVENT_TIMEOUT_MS = 180_000
const CHAT_STREAM_IDLE_MS = 180_000
const WATCHDOG_INTERVAL_MS = 4_000

export function startTurnWatchdog(controller: AbortController) {
  const state = { firstEventAt: 0, idleTimedOut: false, lastEventAt: Date.now() }
  const handle = window.setInterval(() => {
    const silentFor = Date.now() - state.lastEventAt
    if ((!state.firstEventAt && silentFor > CHAT_FIRST_EVENT_TIMEOUT_MS)
      || (state.firstEventAt && silentFor > CHAT_STREAM_IDLE_MS)) {
      state.idleTimedOut = true
      controller.abort()
    }
  }, WATCHDOG_INTERVAL_MS)
  return {
    touch() {
      const now = Date.now()
      if (!state.firstEventAt) state.firstEventAt = now
      state.lastEventAt = now
    },
    stop() { window.clearInterval(handle) },
    get sawFirstEvent() { return Boolean(state.firstEventAt) },
    get idleTimedOut() { return state.idleTimedOut },
  }
}
