import { onMounted, onScopeDispose, ref } from 'vue'
import { offHostEvent, onHostEvent } from '@/platform/desktop/hostApi'
import { hasPendingArtworkSource } from '@/platform/web/migrationBarrier'
import { hasPendingProfileWrites } from '@/platform/web/profileStorage'
import { settingWriteState } from '@/storage/settingWrites'

const IDLE_DELAY_MS = 5 * 60_000
const DIRTY_RECHECK_MS = 30_000

export function useAtelierIdle(enabled: boolean) {
  const idle = ref(false)
  if (!enabled) return idle
  let hostVisible = true
  let hiddenSince = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let subscription: number | undefined
  function refresh() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (hostVisible && !document.hidden) {
      hiddenSince = 0
      if (idle.value) {
        idle.value = false
        document.dispatchEvent(new Event('aics:resume-idle-gallery-media'))
      }
      return
    }
    if (idle.value) return
    const now = Date.now()
    hiddenSince ||= now
    const delay = IDLE_DELAY_MS - (now - hiddenSince)
    if (delay > 0) {
      timer = setTimeout(refresh, delay)
      return
    }
    if (hasPendingProfileWrites() || hasPendingArtworkSource() || settingWriteState.value.pending) {
      timer = setTimeout(refresh, DIRTY_RECHECK_MS)
      return
    }
    idle.value = true
    document.dispatchEvent(new Event('aics:release-idle-gallery-media'))
  }
  onMounted(() => {
    document.addEventListener('visibilitychange', refresh)
    subscription = onHostEvent<unknown>('aics:atelier-visibility', visible => {
      if (typeof visible === 'boolean') { hostVisible = visible; refresh() }
    }, 'current-window')
    refresh()
  })
  onScopeDispose(() => {
    document.removeEventListener('visibilitychange', refresh)
    if (subscription !== undefined) offHostEvent(subscription)
    if (timer !== undefined) clearTimeout(timer)
  })
  return idle
}
