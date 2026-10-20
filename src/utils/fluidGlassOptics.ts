const CHROME_SELECTOR = '.nav, .companion-toolbar, .studio-popover[data-fluid-glass], .studio-select-content[data-fluid-glass], .chat-more-menu[data-fluid-glass], .wardrobe-menu[data-fluid-glass], .gallery-selection-dock[data-fluid-glass], .gallery-orbit-navigation[data-fluid-glass]'
const OPTICS_SELECTOR = `${CHROME_SELECTOR}, .generation-action-surface`
const SVG_NS = 'http://www.w3.org/2000/svg'
let sequence = 0

/** Encode a rounded lens into red/green offsets; its centre stays undistorted.
 * This is a small geometry texture, never a screenshot or a copy of UI content. */
function lensMap(width: number, height: number, radius: number, rim: number) {
  const ratio = Math.min(1, 1024 / width, 768 / height, Math.sqrt(180000 / (width * height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width * ratio)); canvas.height = Math.max(1, Math.ceil(height * ratio))
  const context = canvas.getContext('2d')
  if (!context) return
  const pixels = context.createImageData(canvas.width, canvas.height)
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const px = (x + .5) * width / canvas.width - width / 2
      const py = (y + .5) * height / canvas.height - height / 2
      const qx = Math.abs(px) - (width / 2 - radius), qy = Math.abs(py) - (height / 2 - radius)
      const cx = Math.max(qx, 0), cy = Math.max(qy, 0), length = Math.hypot(cx, cy)
      const depth = -(length + Math.min(Math.max(qx, qy), 0) - radius)
      const bend = Math.pow(1 - Math.max(0, Math.min(1, depth / rim)), 1.8)
      const nx = length > 0 ? cx / length : qx >= qy ? 1 : 0
      const ny = length > 0 ? cy / length : qy > qx ? 1 : 0
      const index = (y * canvas.width + x) * 4
      pixels.data[index] = Math.round(128 - Math.sign(px) * nx * bend * 127)
      pixels.data[index + 1] = Math.round(128 - Math.sign(py) * ny * bend * 127)
      pixels.data[index + 2] = 128; pixels.data[index + 3] = 255
    }
  }
  context.putImageData(pixels, 0, 0)
  return canvas.toDataURL()
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
  const surfaces = new Map<HTMLElement, { filter?: SVGFilterElement; geometry: string }>()
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
      const rim = Math.min(12, Math.max(4, Math.min(width, height) * .16))
      const map = lensMap(width, height, radius, rim)
      if (!map) continue
      state.geometry = geometry
      const filter = state.filter ?? document.createElementNS(SVG_NS, 'filter')
      if (!state.filter) { filter.id = `atelier-glass-${++sequence}`; defs.append(filter); state.filter = filter }
      filter.setAttribute('filterUnits', 'userSpaceOnUse'); filter.setAttribute('primitiveUnits', 'userSpaceOnUse')
      filter.setAttribute('x', '-24'); filter.setAttribute('y', '-24')
      filter.setAttribute('width', String(width + 48)); filter.setAttribute('height', String(height + 48))
      filter.setAttribute('color-interpolation-filters', 'sRGB')
      const blur = document.createElementNS(SVG_NS, 'feGaussianBlur')
      blur.setAttribute('in', 'SourceGraphic'); blur.setAttribute('stdDeviation', '3.2'); blur.setAttribute('result', 'softened')
      const image = document.createElementNS(SVG_NS, 'feImage')
      image.setAttribute('x', '0'); image.setAttribute('y', '0')
      image.setAttribute('href', map); image.setAttribute('width', String(width)); image.setAttribute('height', String(height))
      image.setAttribute('preserveAspectRatio', 'none'); image.setAttribute('result', 'lens')
      const bend = document.createElementNS(SVG_NS, 'feDisplacementMap')
      bend.setAttribute('in', 'softened'); bend.setAttribute('in2', 'lens'); bend.setAttribute('scale', String(rim * 2.2))
      bend.setAttribute('xChannelSelector', 'R'); bend.setAttribute('yChannelSelector', 'G')
      filter.replaceChildren(blur, image, bend)
      element.style.setProperty('--fluid-glass-filter', `url("#${filter.id}")`)
      element.classList.add('fluid-glass-refractive')
    }
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
    for (const element of surfaces.keys()) release(element)
    definitions.remove()
  }
}
