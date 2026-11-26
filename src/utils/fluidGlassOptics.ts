import type { LensDimensions } from './fluidGlassLens.worker'

const CHROME_SELECTOR = [
  '.companion-toolbar',
  '.gallery-selection-dock[data-fluid-glass]',
  '.gallery-orbit-navigation[data-fluid-glass]',
  '.drawing-jump-links[data-fluid-glass]',
  '.viewer-close[data-fluid-glass]',
  '.viewer-nav[data-fluid-glass]',
  '.viewer-mode-switch[data-fluid-glass]',
  '.directory-pocket[data-fluid-glass]',
].join(', ')
const OPTICS_SELECTOR = CHROME_SELECTOR
const SVG_NS = 'http://www.w3.org/2000/svg'
let sequence = 0

function preloadMap(dataUrl: string): Promise<void> {
  return new Promise(resolve => {
    const img = new Image()
    img.src = dataUrl
    if (typeof img.decode === 'function') {
      img.decode().then(() => resolve(), () => resolve())
    } else {
      img.onload = () => resolve()
      img.onerror = () => resolve()
    }
  })
}

/** Static backdrop refraction is sized only on mount/resize. Pointer motion
 * continues to use the existing transform/opacity light, never animated filters. */
export function mountFluidGlassOptics(): () => void {
  const definitions = document.createElementNS(SVG_NS, 'svg')
  definitions.classList.add('fluid-glass-definitions')
  definitions.setAttribute('aria-hidden', 'true'); definitions.setAttribute('focusable', 'false')
  definitions.setAttribute('width', '0'); definitions.setAttribute('height', '0')
  const defs = document.createElementNS(SVG_NS, 'defs')
  definitions.append(defs); document.body.append(definitions)
  const filters = window.CSS.supports('backdrop-filter', 'url("#fluid-glass")')
  type Surface = { filter?: SVGFilterElement; geometry: string; requested?: LensDimensions }
  const surfaces = new Map<HTMLElement, Surface>()
  const maps = new Map<string, string | null>()
  let worker: Worker | undefined
  let workingOn: string | undefined
  let canGenerate = filters && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
  const pending = new Set<HTMLElement>()
  let frame = 0
  function queue(element: HTMLElement) {
    pending.add(element)
    if (!frame) frame = requestAnimationFrame(paint)
  }
  const sizes = new ResizeObserver(entries => {
    for (const entry of entries) if (entry.target instanceof HTMLElement) queue(entry.target)
  })
  function release(element: HTMLElement) {
    sizes.unobserve(element); pending.delete(element)
    surfaces.get(element)?.filter?.remove(); surfaces.delete(element)
    element.classList.remove('fluid-glass-chrome', 'fluid-glass-refractive')
    element.style.removeProperty('--fluid-glass-filter')
  }
  function discover() {
    for (const element of surfaces.keys()) {
      if (!element.isConnected || !element.matches(OPTICS_SELECTOR) || element.parentElement?.closest(CHROME_SELECTOR)
        || element.closest('.gallery-toolbar, .browse-toolbar')) release(element)
    }
    for (const element of document.querySelectorAll<HTMLElement>(OPTICS_SELECTOR)) {
      // A nested menu shares its parent's backdrop instead of filtering it twice.
      if (element.parentElement?.closest(CHROME_SELECTOR) || element.closest('.gallery-toolbar, .browse-toolbar')) continue
      if (surfaces.has(element)) continue
      surfaces.set(element, { geometry: '' })
      if (element.matches(CHROME_SELECTOR)) element.classList.add('fluid-glass-chrome')
      sizes.observe(element); queue(element)
    }
  }
  function applyMap(element: HTMLElement, state: Surface, { width, height, rim }: LensDimensions, map: string) {
    const filter = state.filter ?? document.createElementNS(SVG_NS, 'filter')
    if (!state.filter) { filter.id = `atelier-glass-${++sequence}`; defs.append(filter); state.filter = filter }
    filter.setAttribute('filterUnits', 'userSpaceOnUse'); filter.setAttribute('primitiveUnits', 'userSpaceOnUse')
    filter.setAttribute('x', '-16'); filter.setAttribute('y', '-16')
    filter.setAttribute('width', String(width + 32)); filter.setAttribute('height', String(height + 32))
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    const blur = document.createElementNS(SVG_NS, 'feGaussianBlur')
    blur.setAttribute('in', 'SourceGraphic')
    blur.setAttribute('stdDeviation', '5.5')
    blur.setAttribute('result', 'softened')
    const image = document.createElementNS(SVG_NS, 'feImage')
    image.setAttribute('x', '0'); image.setAttribute('y', '0')
    image.setAttribute('href', map); image.setAttribute('width', String(width)); image.setAttribute('height', String(height))
    image.setAttribute('preserveAspectRatio', 'none'); image.setAttribute('result', 'lens')
    // Single-pass neutral displacement preserves true backdrop colors and crisp edges
    // without chromatic text fringing or multi-stage premultiplied alpha artifacts.
    const bend = document.createElementNS(SVG_NS, 'feDisplacementMap')
    bend.setAttribute('in', 'softened'); bend.setAttribute('in2', 'lens')
    bend.setAttribute('scale', Math.min(16, rim * 1.35).toFixed(2))
    bend.setAttribute('xChannelSelector', 'R'); bend.setAttribute('yChannelSelector', 'G')
    filter.replaceChildren(blur, image, bend)
    const geometry = state.geometry
    void preloadMap(map).then(() => {
      if (!element.isConnected || surfaces.get(element) !== state || state.geometry !== geometry) return
      element.style.setProperty('--fluid-glass-filter', `url("#${filter.id}")`)
      element.classList.add('fluid-glass-refractive')
    })
  }

  function stopWorker() {
    canGenerate = false
    worker?.terminate()
    worker = undefined
    workingOn = undefined
  }

  // Keep one job in flight. Resizing or removing a surface replaces its request
  // before the worker picks it up; reopened surfaces reuse a bounded map cache.
  function updateMaps() {
    let next: Surface | undefined
    for (const [element, state] of surfaces) {
      if (!state.requested || !element.isConnected) continue
      const map = maps.get(state.geometry)
      if (map === undefined) {
        next ??= state
      } else {
        if (map) applyMap(element, state, state.requested, map)
        state.requested = undefined
      }
    }
    if (!next || workingOn || !canGenerate) return
    try {
      if (!worker) {
        worker = new Worker(new URL('./fluidGlassLens.worker.ts', import.meta.url), { type: 'module' })
        worker.onerror = stopWorker
        worker.onmessageerror = stopWorker
        worker.onmessage = (event: MessageEvent<string | null>) => {
          if (!workingOn) return
          if (maps.size >= 16) maps.delete(maps.keys().next().value!)
          maps.set(workingOn, event.data)
          workingOn = undefined
          updateMaps()
        }
      }
      workingOn = next.geometry
      worker.postMessage(next.requested)
    } catch { stopWorker() }
  }

  function paint() {
    frame = 0
    // Finish geometry reads before adding filters/classes to avoid layout thrash.
    const measurements = [...pending].map(element => {
      const width = element.offsetWidth, height = element.offsetHeight
      const raw = getComputedStyle(element).borderTopLeftRadius
      const corner = Number.parseFloat(raw) || 0
      const radius = Math.min(width / 2, height / 2, raw.endsWith('%') ? Math.min(width, height) * corner / 100 : corner)
      return { element, width, height, radius }
    })
    pending.clear()
    for (const { element, width, height, radius } of measurements) {
      const state = surfaces.get(element)
      if (!state || !element.isConnected || !width || !height || !filters) continue
      const geometry = `${width}:${height}:${radius}`
      if (state.geometry === geometry) continue
      const rim = Math.min(13, Math.max(7, Math.min(width, height) * .18))
      state.geometry = geometry
      state.requested = { width, height, radius, rim }
    }
    updateMaps()
  }
  const changes = new MutationObserver(records => {
    const relevant = records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(node =>
      node instanceof Element && (node.matches(OPTICS_SELECTOR) || !!node.querySelector(OPTICS_SELECTOR))))
    if (relevant) discover()
  })
  changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-fluid-glass'] })
  discover()
  return () => {
    changes.disconnect(); sizes.disconnect(); cancelAnimationFrame(frame); pending.clear()
    stopWorker(); maps.clear()
    for (const element of surfaces.keys()) release(element)
    definitions.remove()
  }
}
