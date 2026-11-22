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
  let panels: CompanionRect[] = []
  let regionsKey = ''
  let portraitKey = ''
  let portraitRevision = 0
  let canvasFrameAt = -Infinity
  let activeCanvas: HTMLCanvasElement | undefined
  let ready: CompanionReadyKind | undefined
  let maskPublished = false
  let lastMask: CompanionAlphaMask | null = null
  let maskTail = Promise.resolve()
  let sendingCanvas: HTMLCanvasElement | undefined
  let pointerInside = false
  let geometryChanged = true
  const maskSurface = document.createElement('canvas')
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
  function physicalRect(rect: DOMRect, scale: number): CompanionRect | null {
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
    panels = [...current].filter(visible).flatMap(panel => physicalRect(panel.getBoundingClientRect(), scale) ?? []).slice(0, 32)
    publishRegions(panels, locked)
    updatePortrait(scale)
  }
  function publishRegions(panels: CompanionRect[], lock: boolean) {
    const key = JSON.stringify([panels, lock])
    if (regionsKey !== key) {
      regionsKey = key
      tail = tail.then(() => companionWindow.setInteractiveRegions(panels, lock)).catch(() => {
        if (regionsKey === key) regionsKey = ''
      })
    }
  }
  function setDragLock(lock: boolean) {
    if (locked === lock) return tail
    locked = lock
    publishRegions(panels, locked)
    return tail
  }
  function markReady(kind: CompanionReadyKind) {
    ready = kind
    if (kind !== 'static' || maskPublished) void companionWindow.markReady(kind).catch(() => {})
    schedule()
  }

  function updatePortrait(scale: number) {
    if (activeCanvas?.isConnected && activeCanvas.closest('.portrait-stage.live2d-ready') && !activeCanvas.closest('[hidden]')) return
    if (activeCanvas) {
      activeCanvas = undefined
      portraitKey = 'canvas'
    }
    const image = [...document.querySelectorAll<HTMLImageElement>(portraitSelector)].find(img => img.complete && img.naturalWidth && visible(img))
    const screen = image?.getBoundingClientRect()
    const rect = screen && physicalRect(screen, scale)
    const key = image && rect && screen ? JSON.stringify([image.currentSrc, rect, screen.x, screen.y, screen.width, screen.height, scale]) : ''
    if (portraitKey === key) return
    portraitKey = key
    maskPublished = false
    lastMask = null
    pendingMask?.abort()
    const revision = ++portraitRevision
    if (!image || !rect || !screen) { void sendMask(null, revision); return }
    const controller = new AbortController()
    pendingMask = controller
    const draw = (source: CanvasImageSource) => drawAlpha(maskSurface, source, image, screen, rect, scale)
    void readPortraitAlpha(image, draw, controller.signal)
      .then(mask => sendMask(mask, revision))
      .catch(() => failMask(revision))
  }

  function sendMask(mask: CompanionAlphaMask | null, revision: number) {
    maskTail = maskTail.then(async () => {
      if (!alive || revision !== portraitRevision) return
      await companionWindow.setStaticMask(mask)
      if (!alive || revision !== portraitRevision) return
      lastMask = mask
      const firstMask = !maskPublished && !!mask
      maskPublished = !!mask
      if (firstMask && ready === 'static') await companionWindow.markReady('static')
    }).catch(() => failMask(revision))
    return maskTail
  }
  function failMask(revision: number) {
    if (alive && revision === portraitRevision && !maskPublished && ready === 'static') {
      void companionWindow.markReady('failed').catch(() => {})
    }
  }
  function captureCanvas(canvas: HTMLCanvasElement) {
    const now = performance.now()
    if (!alive || sendingCanvas === canvas || !canvas.isConnected) return
    if (canvas === activeCanvas && !geometryChanged &&
      (now - canvasFrameAt < 250 || maskPublished && (!pointerInside || document.hidden))) return
    if (!canvas.closest('.portrait-stage.live2d-ready') || canvas.closest('[hidden]')) return
    const scale = clientScale()
    const screen = canvas.getBoundingClientRect()
    const rect = physicalRect(screen, scale)
    if (!rect || !canvas.width || !canvas.height) return
    if (canvas !== activeCanvas) {
      activeCanvas = canvas
      pendingMask?.abort()
      maskPublished = false
      lastMask = null
      portraitRevision++
    }
    canvasFrameAt = now
    geometryChanged = false
    const revision = portraitRevision
    try {
      const mask = drawAlpha(maskSurface, canvas, canvas, screen, rect, scale)
      if (!maskPublished && !mask.data.some(Boolean)) return
      const previous = lastMask
      if (previous && previous.rect.x === rect.x && previous.rect.y === rect.y &&
        previous.rect.width === rect.width && previous.rect.height === rect.height &&
        mask.data.every((value, index) => value === previous.data[index])) return
      sendingCanvas = canvas
      void sendMask(mask, revision).finally(() => { if (sendingCanvas === canvas) sendingCanvas = undefined })
    } catch { failMask(revision) }
  }
  function setPointer(x: number, y: number, windowBounds: CompanionRect) {
    pointerInside = x >= windowBounds.x && y >= windowBounds.y &&
      x < windowBounds.x + windowBounds.width && y < windowBounds.y + windowBounds.height
  }
  function resize() { geometryChanged = true; schedule() }

  onMounted(() => {
    mutations = new MutationObserver(schedule)
    mutations.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-hidden', 'class', 'data-state', 'hidden', 'inert', 'open', 'src'],
    })
    resizing = new ResizeObserver(schedule)
    window.addEventListener('resize', resize)
    document.addEventListener('load', schedule, true)
    document.addEventListener('transitionend', schedule)
    resizeSubscription = bridge?.onWindowBoundsChanged?.(next => {
      const sizeChanged = bounds?.width !== next.width || bounds?.height !== next.height
      bounds = next
      if (sizeChanged) resize()
    })
    stopPrepare = companionWindow.on('prepare', () => {
      regionsKey = ''
      if (!maskPublished) portraitKey = ''
      resize()
    })
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
    window.removeEventListener('resize', resize)
    document.removeEventListener('load', schedule, true)
    document.removeEventListener('transitionend', schedule)
    if (resizeSubscription !== undefined) bridge?.offWindowBoundsChanged?.(resizeSubscription)
    void tail.then(() => companionWindow.setInteractiveRegions([], false)).catch(() => {})
    void maskTail.then(() => companionWindow.setStaticMask(null)).catch(() => {})
  })
  return { setDragLock, markReady, captureCanvas, setPointer }
}

async function readPortraitAlpha(image: HTMLImageElement, draw: (source: CanvasImageSource) => CompanionAlphaMask, signal: AbortSignal) {
  const url = new URL(image.currentSrc, location.href)
  if (image.crossOrigin || url.origin === location.origin || url.protocol === 'data:') return draw(image)
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) })
  if (!response.ok) throw new Error('桌宠立绘暂不可用')
  const bitmap = await createImageBitmap(await response.blob())
  try { signal.throwIfAborted(); return draw(bitmap) }
  finally { bitmap.close() }
}

function drawAlpha(canvas: HTMLCanvasElement, source: CanvasImageSource, element: HTMLImageElement | HTMLCanvasElement,
  screen: DOMRect, rect: CompanionRect, scale: number): CompanionAlphaMask {
  // Cap the IPC payload even on a 4K display. The native hit check expands one cell around the cursor.
  const cell = Math.max(4, Math.max(rect.width, rect.height) / 128)
  const maskWidth = Math.ceil(rect.width / cell), maskHeight = Math.ceil(rect.height / cell)
  if (canvas.width !== maskWidth) canvas.width = maskWidth
  if (canvas.height !== maskHeight) canvas.height = maskHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('桌宠立绘透明度不可读')
  const style = getComputedStyle(element)
  const sourceWidth = element instanceof HTMLImageElement ? element.naturalWidth : element.width
  const sourceHeight = element instanceof HTMLImageElement ? element.naturalHeight : element.height
  const fit = Math.min(screen.width / sourceWidth, screen.height / sourceHeight)
  const width = style.objectFit === 'contain' ? sourceWidth * fit : screen.width
  const height = style.objectFit === 'contain' ? sourceHeight * fit : screen.height
  const x = (screen.left + (screen.width - width) / 2) * scale - rect.x
  const y = (screen.top + (screen.height - height) * (style.objectPosition.endsWith('100%') ? 1 : 0.5)) * scale - rect.y
  const sx = maskWidth / rect.width, sy = maskHeight / rect.height
  context.clearRect(0, 0, maskWidth, maskHeight)
  context.drawImage(source, x * sx, y * sy, width * scale * sx, height * scale * sy)
  const rgba = context.getImageData(0, 0, maskWidth, maskHeight).data
  const data = new Array<number>(maskWidth * maskHeight)
  for (let index = 0; index < data.length; index++) data[index] = rgba[index * 4 + 3]! > 16 ? 255 : 0
  return { rect, maskWidth, maskHeight, data }
}
