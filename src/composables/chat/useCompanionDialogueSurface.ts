import { onMounted, onUnmounted, ref } from 'vue'
import { companionDialogueVisible, onCompanionDialogueVisibility, onCompanionDialogueSide, resizeCompanionDialogue, type CompanionDialogueSide } from '@/platform/desktop/companionDialogue'

/** The transparent native window follows the painted dialogue's intrinsic size. */
export function useCompanionDialogueSurface(desktop: boolean) {
  const surfaceRef = ref<HTMLElement>()
  const dockSide = ref<CompanionDialogueSide>()
  let observer: ResizeObserver | undefined
  let removeSideListener: (() => void) | undefined
  let frame = 0
  let disposed = false
  let resizing = false
  let pending = false
  let previousSize = ''

  async function resize() {
    if (disposed || !surfaceRef.value || document.hidden) return
    if (resizing) { pending = true; return }
    const rect = surfaceRef.value.getBoundingClientRect()
    const width = Math.ceil(rect.width), height = Math.ceil(rect.height)
    const key = `${width}:${height}`
    if (!width || !height || key === previousSize) return
    resizing = true
    try {
      const limit = await resizeCompanionDialogue(width, height)
      if (!disposed) {
        surfaceRef.value?.style.setProperty('--dialogue-max-height', `${limit}px`)
        previousSize = key
      }
    } catch (error) { console.warn('悬浮对白尺寸未能同步', error) }
    finally {
      resizing = false
      if (pending && !disposed) { pending = false; scheduleResize() }
    }
  }
  function scheduleResize() {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => { frame = 0; void resize() })
  }
  function onViewportResize() { previousSize = ''; scheduleResize() }
  onMounted(() => {
    if (!desktop || !surfaceRef.value) return
    removeSideListener = onCompanionDialogueSide(side => { dockSide.value = side })
    observer = new ResizeObserver(scheduleResize)
    observer.observe(surfaceRef.value)
    document.addEventListener('visibilitychange', scheduleResize)
    window.addEventListener('resize', onViewportResize)
  })
  onUnmounted(() => {
    disposed = true
    observer?.disconnect()
    removeSideListener?.()
    cancelAnimationFrame(frame)
    document.removeEventListener('visibilitychange', scheduleResize)
    window.removeEventListener('resize', onViewportResize)
  })
  return { surfaceRef, dockSide }
}

/** Keep the pet's transient preview out of the way while its dialogue is open. */
export function useCompanionDialogueVisibility() {
  const visible = ref(false)
  let removeListener: (() => void) | undefined
  let revision = 0
  let disposed = false
  onMounted(() => {
    removeListener = onCompanionDialogueVisibility(value => { revision++; visible.value = value })
    const readingRevision = revision
    void companionDialogueVisible().then(value => {
      if (!disposed && revision === readingRevision) visible.value = value
    }).catch(error => { if (!disposed) console.warn('对白可见状态暂时不可用', error) })
  })
  onUnmounted(() => { disposed = true; removeListener?.() })
  return visible
}
