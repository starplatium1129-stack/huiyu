import { readonly, ref } from 'vue'

interface ZoomBridge { getWindowZoom(): Promise<number>; setWindowZoom(value: number): Promise<number> }
const available = ref(false), zoom = ref(1), error = ref('')
let bridge: ZoomBridge | undefined, requested = 1, saving = false, disposed = false
let installation = 0
const bounded = (value: number) => Math.max(.75, Math.min(2, Math.round(value * 100) / 100))

async function flush() {
  if (saving || !bridge) return
  saving = true
  try {
    while (!disposed) {
      const target = requested
      const actual = await bridge.setWindowZoom(target)
      if (disposed) break
      zoom.value = bounded(actual); error.value = ''
      if (target === requested) break
    }
  } catch { requested = zoom.value; error.value = '缩放未保存，请重试。' }
  finally { saving = false }
}
function setZoom(value: number) {
  if (!available.value || !Number.isFinite(value)) return
  requested = bounded(value); void flush()
}
export function useDesktopZoom() { return { available: readonly(available), zoom: readonly(zoom), error: readonly(error), setZoom } }

/** Native WebView zoom only: CSS scaling cannot keep text and hit coordinates correct. */
export function installDesktopZoom() {
  // Presence selects the adapter only; the host authenticates origin and role.
  // Normal browsers do not load the desktop module or change browser shortcuts.
  if (!('__TAURI__' in window)) return () => {}
  const generation = ++installation
  disposed = false
  void import('@/platform/desktop/bootstrap').then(async desktop => {
    if (disposed || generation !== installation) return
    const bootstrap = await desktop.readDesktopBootstrap()
    if (disposed || generation !== installation || bootstrap.connection !== 'ready' || bootstrap.windowRole === 'companion') return
    const value = await desktop.desktopWindowZoom.getWindowZoom()
    if (disposed || generation !== installation) return
    bridge = desktop.desktopWindowZoom
    zoom.value = requested = bounded(value); available.value = true
  }).catch(() => {})
  function keydown(event: KeyboardEvent) {
    if (!available.value || event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return
    if (!['+', '=', '-', '0'].includes(event.key)) return
    event.preventDefault()
    setZoom(event.key === '0' ? 1 : requested + (event.key === '-' ? -.1 : .1))
  }
  function wheel(event: WheelEvent) {
    if (!available.value || !event.ctrlKey || event.defaultPrevented || !event.deltaY) return
    event.preventDefault(); setZoom(requested + (event.deltaY < 0 ? .1 : -.1))
  }
  document.addEventListener('keydown', keydown)
  document.addEventListener('wheel', wheel, { passive: false })
  return () => {
    if (generation === installation) { disposed = true; available.value = false; bridge = undefined }
    document.removeEventListener('keydown', keydown); document.removeEventListener('wheel', wheel)
  }
}
