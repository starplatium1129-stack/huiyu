import { onActivated, onDeactivated, ref, watchEffect } from 'vue'
import { acquirePageScrollLock } from '@/utils/pageScrollLock'

/** Reka surfaces keep their focus scope and share the application's scroll lock. */
export function usePageScrollLock(open: () => boolean) {
  const attached = ref(true)
  watchEffect(cleanup => {
    if (attached.value && open()) cleanup(acquirePageScrollLock())
  }, { flush: 'sync' })
  onActivated(() => { attached.value = true })
  onDeactivated(() => { attached.value = false })
}
