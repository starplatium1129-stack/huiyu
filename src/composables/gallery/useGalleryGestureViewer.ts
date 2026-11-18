import { nextTick, onDeactivated, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { useGalleryWorkspace } from './useGalleryWorkspace'

type Viewer = Pick<ReturnType<typeof useGalleryWorkspace>, 'current' | 'viewerIndex' | 'viewerEl' | 'closeBtn' | 'compareMode'>

export function useGalleryGestureViewer({ current, viewerIndex, viewerEl, closeBtn, compareMode }: Viewer) {
  const PhotoSwipeStage = shallowRef<typeof import('@/components/gallery/PhotoSwipeStage.vue')['default'] | null>(null)
  const gestureViewer = ref(false)
  const gestureLoading = ref(false), gestureError = ref(false)
  let gestureRequest = 0
  function cancelGesture() { gestureRequest++; gestureViewer.value = false; gestureLoading.value = false; gestureError.value = false }
  async function failGesture() {
    const focused = document.activeElement, owned = focused?.closest('.photoswipe-stage')
    cancelGesture(); gestureError.value = true
    const request = gestureRequest
    await nextTick()
    if (owned && request === gestureRequest && viewerIndex.value >= 0 && document.activeElement === document.body)
      closeBtn.value?.focus({ preventScroll: true })
  }
  async function toggleGesture() {
    if (gestureViewer.value || gestureLoading.value) { cancelGesture(); return }
    if (viewerIndex.value < 0 || !current.value) return
    const request = ++gestureRequest, id = current.value.id
    // A retry removes its own button; the mode toggle survives every loading state.
    if (gestureError.value) viewerEl.value?.querySelector<HTMLElement>('[data-gesture-toggle]')?.focus({ preventScroll: true })
    gestureLoading.value = true; gestureError.value = false; compareMode.value = false
    const currentRequest = () => request === gestureRequest && viewerIndex.value >= 0 && current.value?.id === id
    try {
      const component = PhotoSwipeStage.value || (await import('@/components/gallery/PhotoSwipeStage.vue')).default
      if (currentRequest()) { PhotoSwipeStage.value = component; gestureViewer.value = true }
    } catch { if (currentRequest()) gestureError.value = true }
    finally { if (currentRequest()) gestureLoading.value = false }
  }
  onScopeDispose(cancelGesture)
  watch(() => current.value?.id, () => { if (gestureLoading.value || gestureError.value) cancelGesture() }, { flush:'sync' })
  watch(compareMode, value => { if (value) cancelGesture() }, { flush:'sync' })
  onDeactivated(cancelGesture)
  return { PhotoSwipeStage, gestureViewer, gestureLoading, gestureError, cancelGesture, failGesture, toggleGesture }
}
