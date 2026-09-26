import { profileLocalStorage as localStorage } from '../../platform/web/profileStorage.ts'
import { onMounted, onUnmounted, ref } from 'vue'
import { LIVE2D_QUALITY_KEY, normalizeLive2DQuality } from '@/live2d/quality'

function readQuality() {
  try { return normalizeLive2DQuality(localStorage.getItem(LIVE2D_QUALITY_KEY)) } catch { return 'original' as const }
}
const quality = ref(readQuality())

export function useLive2DPreferences() {
  function onStorage(event: StorageEvent) {
    if (event.key === LIVE2D_QUALITY_KEY || event.key === null) quality.value = readQuality()
  }
  onMounted(() => window.addEventListener('storage', onStorage))
  onUnmounted(() => window.removeEventListener('storage', onStorage))
  return {
    quality,
    setQuality(value: unknown) {
      quality.value = normalizeLive2DQuality(value)
      try { localStorage.setItem(LIVE2D_QUALITY_KEY, quality.value) } catch { /* session-only in restricted storage */ }
    },
  }
}
