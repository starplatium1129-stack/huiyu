import { inject, onMounted, onUnmounted, provide, type InjectionKey } from 'vue'
import { companionWindow, getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { getDesktopWindowRole } from '@/platform/desktop/runtime'
import type { CompanionAlphaMask, CompanionReadyKind, CompanionRect } from '@/types/desktop'

const inputKey: InjectionKey<ReturnType<typeof createInput>> = Symbol('companion-input')
const panelsSelector = 'dialog[open], [data-companion-interactive], .orbit-wheel, .orbit-selection, .orbit-option, .orbit-feedback, [data-reka-popper-content-wrapper], .studio-select-content[data-state="open"]'
const portraitSelector = '.portrait-stage:not(.live2d-ready) .portrait-decoded, .card-portrait img'

export function provideCompanionInput() {
  if (getDesktopWindowRole() !== 'companion') return
  const input = createInput()
  provide(inputKey, input)
  return input
}
export function useCompanionInput() { return inject(inputKey, undefined) }

function createInput() {
  const bridge = getDesktopCapabilities()
  let bounds: CompanionRect | undefined
  let locked = false, alive = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let resizing: ResizeObserver | undefined
  let mutations: MutationObserver | undefined
  let resizeSubscription: number | undefined
  let stopPrepare: (() => void) | undefined
  let observed = new Set<HTMLElement>()
  let regionsKey = ''
  let portraitKey = ''
  let portraitRevision = 0
  let canvasFrameAt = -Infinity
  let activeCanvas: HTMLCanvasElement | undefined
  let ready: CompanionReadyKind | undefined
  let maskPublished = false
  let tail = Promise.resolve()
  let pendingMask: AbortController | undefined

  function schedule() {
    // Hidden WebView2s can throttle animation frames during initial layout.
    if (alive && timer === undefined) timer = setTimeout(update, 0)
  }
  function visible(element: HTMLElement) {
    if (element.closest('[inert], [hidden], [aria-hidden="true"]')) return false
    const style = getComputedStyle(element)
    return style.visibility === 'visible' && style.display !== 'none'
  }
  const clientScale = () => bounds?.width && innerWidth ? bounds.width / innerWidth : devicePixelRatio || 1
  function physicalRect(element: Element, scale: number): CompanionRect | null {
    const rect = element.getBoundingClientRect()
    const x = Math.max(0, Math.floor(rect.left * scale))
    const y = Math.max(0, Math.floor(rect.top * scale))
    const width = Math.ceil(Math.min(window.innerWidth, rect.right) * scale) - x
    const height = Math.ceil(Math.min(window.innerHeight, rect.bottom) * scale) - y
    return width > 0 && height > 0 ? { x, y, width, height } : null
  }
  function update() {
    timer = undefined
    const scale = clientScale()
    const current = new Set(document.querySelectorAll<HTMLElement>(panelsSelector))
    for (const panel of observed) if (!current.has(panel)) resizing?.unobserve(panel)
    for (const panel of current) if (!observed.has(panel)) resizing?.observe(panel)
    observed = current
    const panels = [...current].filter(visible).flatMap(panel => physicalRect(panel, scale) ?? []).slice(0, 32)
    const key = JSON.stringify([panels, locked])
    if (regionsKey !== key) {
      regionsKey = key
      const lock = locked
      tail = tail.then(() => companionWindow.setInteractiveRegions(panels, lock)).catch(() => {
        if (regionsKey === key) regionsKey = ''
      })
    }
    updatePortrait(scale)
  }
  function setDragLock(lock: boolean) {
    if (locked === lock) return tail
    locked = lock
    if (timer !== undefined) clearTimeout(timer)
    update()
    return tail
  }
  function markReady(kind: CompanionReadyKind) {
    ready = kind
    if (kind !== 'static' || maskPublished) void companionWindow.markReady(kind).catch(() => {})
    schedule()
  }

  function updatePortrait(scale: number) {
    if (activeCanvas?.isConnected && !activeCanvas.closest('[hidden]')) return
    if (activeCanvas) {
      activeCanvas = undefined
      portraitKey = 'canvas'
    }
    const image = [...document.querySelectorAll<HTMLImageElement>(portraitSelector)].find(img => img.complete && img.naturalWidth && visible(img))
    const rect = image && physicalRect(image, scale)
    const key = image && rect ? JSON.stringify([image.currentSrc, rect]) : ''
    if (portraitKey === key) return
    portraitKey = key
    maskPublished = false
    pendingMask?.abort()
    const revision = ++portraitRevision
    void companionWindow.setStaticMask(null).catch(() => {})
    if (!image || !rect) return
    const controller = new AbortController()
    pendingMask = controller
    void readPortraitAlpha(image, rect, controller.signal)
      .then(mask => publishMask(mask, revision))
      .catch(() => failMask(revision))
  }

  async function publishMask(mask: CompanionAlphaMask, revision: number) {
    if (!alive || revision !== portraitRevision) return
    await companionWindow.setStaticMask(mask)
    if (!alive || revision !== portraitRevision) return
    const firstMask = !maskPublished
    maskPublished = true
    if (firstMask && ready === 'static') await companionWindow.markReady('static')
  }
  function failMask(revision: number) {
    if (alive && revision === portraitRevision && !maskPublished && ready === 'static') {
      void companionWindow.markReady('failed').catch(() => {})
    }
  }
  function captureCanvas(canvas: HTMLCanvasElement) {
    const now = performance.now()
    if (canvas === activeCanvas && now - canvasFrameAt < 250) return
    const scale = clientScale()
    const rect = physicalRect(canvas, scale)
    if (!rect || !canvas.width || !canvas.height) return
    if (canvas !== activeCanvas) {
      activeCanvas = canvas
      pendingMask?.abort()
      maskPublished = false
    }
    canvasFrameAt = now
    const revision = ++portraitRevision
    try {
      const screen = canvas.getBoundingClientRect()
      // Read WebGL's transparent frame while its drawing buffer is available.
      const mask = drawAlpha(rect, context => {
        const fit = Math.min(screen.width / canvas.width, screen.height / canvas.height)
        const width = fit * canvas.width, height = fit * canvas.height
        context.scale(context.canvas.width / rect.width, context.canvas.height / rect.height)
        context.drawImage(canvas, (screen.left + (screen.width - width) / 2) * scale - rect.x,
          (screen.top + (screen.height - height) / 2) * scale - rect.y, width * scale, height * scale)
      })
      void publishMask(mask, revision).catch(() => failMask(revision))
    } catch { failMask(revision) }
  }

  onMounted(() => {
    mutations = new MutationObserver(schedule)
    mutations.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-hidden', 'class', 'data-state', 'hidden', 'inert', 'open', 'src'],
    })
    resizing = new ResizeObserver(schedule)
    window.addEventListener('resize', schedule)
    document.addEventListener('load', schedule, true)
    document.addEventListener('transitionend', schedule)
    resizeSubscription = bridge?.onWindowBoundsChanged?.(next => { bounds = next; schedule() })
    stopPrepare = companionWindow.on('prepare', () => { regionsKey = ''; schedule() })
    void bridge?.getState().then(state => { if (alive && !bounds) { bounds = state.bounds; schedule() } }).catch(() => {})
    schedule()
  })
  onUnmounted(() => {
    alive = false
    pendingMask?.abort()
    stopPrepare?.()
    if (timer !== undefined) clearTimeout(timer)
    mutations?.disconnect()
    resizing?.disconnect()
    window.removeEventListener('resize', schedule)
    document.removeEventListener('load', schedule, true)
    document.removeEventListener('transitionend', schedule)
    if (resizeSubscription !== undefined) bridge?.offWindowBoundsChanged?.(resizeSubscription)
    void tail.then(() => companionWindow.setInteractiveRegions([], false)).catch(() => {})
    void companionWindow.setStaticMask(null).catch(() => {})
  })
  return { setDragLock, markReady, captureCanvas }
}

async function readPortraitAlpha(image: HTMLImageElement, rect: CompanionRect, signal: AbortSignal): Promise<CompanionAlphaMask> {
  const draw = (source: CanvasImageSource) => drawAlpha(rect, context => {
    const { width: maskWidth, height: maskHeight } = context.canvas
    const scale = Math.min(maskWidth / image.naturalWidth, maskHeight / image.naturalHeight)
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale
    const position = getComputedStyle(image).objectPosition
    const x = (maskWidth - width) / 2
    const y = position.endsWith('100%') ? maskHeight - height : (maskHeight - height) / 2
    context.drawImage(source, x, y, width, height)
  })
  const url = new URL(image.currentSrc, location.href)
  if (url.origin === location.origin || url.protocol === 'data:') return draw(image)
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) })
  if (!response.ok) throw new Error('桌宠立绘暂不可用')
  const bitmap = await createImageBitmap(await response.blob())
  try { return draw(bitmap) }
  finally { bitmap.close() }
}

function drawAlpha(rect: CompanionRect, draw: (context: CanvasRenderingContext2D) => void): CompanionAlphaMask {
  const maskWidth = Math.min(1024, Math.ceil(rect.width / 4))
  const maskHeight = Math.min(1024, Math.ceil(rect.height / 4))
  const canvas = document.createElement('canvas')
  canvas.width = maskWidth
  canvas.height = maskHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('桌宠立绘透明度不可读')
  draw(context)
  const rgba = context.getImageData(0, 0, maskWidth, maskHeight).data
  const data = Array.from({ length: maskWidth * maskHeight }, (_, index) => rgba[index * 4 + 3]!)
  return { rect, maskWidth, maskHeight, data }
}
