import { onDeactivated, onUnmounted, type Ref } from 'vue'
import { useFluidSurface } from './useFluidSurface'

/** Keep native focus containment until exit ends; reopening preserves current motion. */
export function useFluidDialog(dialog: Ref<HTMLDialogElement | null>) {
  const surface = useFluidSurface()
  let intention = 0
  function open(source: HTMLElement | null = document.activeElement as HTMLElement | null) {
    const el = dialog.value
    if (!el) return
    intention++
    if (!el.open) {
      surface.dispose(el); el.style.transform = ''; el.style.opacity = ''
      el.showModal()
      if (source && source !== document.body && !el.contains(source)) {
        const from = source.getBoundingClientRect(), rect = el.getBoundingClientRect()
        el.style.transformOrigin = `${Math.max(0, Math.min(100, (from.x + from.width / 2 - rect.x) / rect.width * 100))}% 0%`
      }
    }
    surface.enter(el, () => {})
  }
  function close(after?: () => void) {
    const el = dialog.value, version = ++intention
    if (!el?.open) { after?.(); return }
    surface.leave(el, () => {
      if (version !== intention) return
      el.close(); surface.dispose(el); el.style.transform = ''; el.style.opacity = ''
      after?.()
    })
  }
  function dispose() { intention++; const el = dialog.value; if (el) { surface.dispose(el); el.close() } }
  onDeactivated(dispose); onUnmounted(dispose)
  return { open, close, dispose }
}
