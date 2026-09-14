/** Rounded glass optics adapted from DeepSeek Harness Desktop's MIT liquid-glass module. */
export const FLUID_GLASS_SELECTOR = '.nav, .nav-more-menu, .sticky-toolbar, .companion-toolbar, .toolbar-shell, .gen-bar, [data-fluid-glass]'
const SVG_NS = 'http://www.w3.org/2000/svg'
const MAX_SURFACES = 12
const MAX_MAPS = 32
const MAX_MAP_EDGE = 360
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/** The reading area stays undistorted; only the rounded bevel refracts the backdrop. */
export function fluidLens(width: number, height: number, radius: number, x: number, y: number): [number, number] {
  if (width <= 0 || height <= 0) return [0, 0]
  const r = clamp(radius, 0, Math.min(width / 2, height / 2))
  const px = x - width / 2, py = y - height / 2
  const qx = Math.abs(px) - (width / 2 - r), qy = Math.abs(py) - (height / 2 - r)
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), length = Math.hypot(ox, oy)
  const depth = -(length + Math.min(Math.max(qx, qy), 0) - r)
  const lip = Math.min(15, r || 15, width / 4, height / 4)
  if (depth <= 0 || depth >= lip) return [0, 0]
  const nx = length > .001 ? ox / length * Math.sign(px) : qx > qy ? Math.sign(px) : 0
  const ny = length > .001 ? oy / length * Math.sign(py) : qx > qy ? 0 : Math.sign(py)
  const slope = (lip - depth) / Math.sqrt(Math.max(.1, lip * lip - (lip - depth) ** 2))
  const normalZ = 1 / Math.sqrt(1 + slope * slope), eta = 1 / 1.46
  const k = eta * normalZ - Math.sqrt(1 - eta * eta * (1 - normalZ * normalZ))
  const travel = 17 * k * slope * normalZ / Math.abs(-eta + k * normalZ)
  const seam = Math.min(1, depth / 1.4)
  return [clamp(nx * travel * seam, -15, 15), clamp(ny * travel * seam, -15, 15)]
}

function svgNode<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string> = {}) {
  const element = document.createElementNS(SVG_NS, name)
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value))
  return element
}

interface GlassRecord {
  filter: SVGFilterElement
  image: SVGFEImageElement
  signature: string
}
let serial = 0
let installed: (() => void) | undefined

/** Install once after mount; call the returned function on app teardown / HMR. */
export function installFluidGlass(): () => void {
  if (installed) return installed
  if (typeof window === 'undefined' || !window.ResizeObserver || !window.IntersectionObserver ||
    !window.CSS?.supports('backdrop-filter', 'url("#fluid-glass")')) return () => {}

  const root = document.documentElement
  const queries = ['(forced-colors: active)', '(prefers-contrast: more)', '(prefers-reduced-transparency: reduce)']
    .map(query => window.matchMedia(query))
  const candidates = new Set<HTMLElement>()
  const visible = new Set<HTMLElement>()
  const records = new Map<HTMLElement, GlassRecord>()
  const cache = new Map<string, string>()
  const svg = svgNode('svg', { 'aria-hidden': 'true', width: '0', height: '0', focusable: 'false' })
  svg.classList.add('fluid-glass-definitions')
  const defs = svgNode('defs')
  svg.append(defs)
  document.body.append(svg)
  let timer = 0, disposed = false
  const enabled = () => root.dataset.fluidEffects !== 'low' && !document.hidden && !queries.some(query => query.matches)

  function mapFor(w: number, h: number, r: number) {
    const key = `${w}:${h}:${r}`
    const cached = cache.get(key)
    if (cached) return cached
    const factor = Math.min(1, MAX_MAP_EDGE / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(2, Math.round(w * factor))
    canvas.height = Math.max(2, Math.round(h * factor))
    const context = canvas.getContext('2d')
    if (!context) return undefined
    const pixels = context.createImageData(canvas.width, canvas.height)
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const [dx, dy] = fluidLens(w, h, r, (x + .5) * w / canvas.width, (y + .5) * h / canvas.height)
      const i = (y * canvas.width + x) * 4
      pixels.data[i] = Math.round(127.5 + dx / 32 * 255)
      pixels.data[i + 1] = Math.round(127.5 + dy / 32 * 255)
      pixels.data[i + 2] = 128
      pixels.data[i + 3] = 255
    }
    context.putImageData(pixels, 0, 0)
    const url = canvas.toDataURL()
    if (cache.size >= MAX_MAPS) cache.delete(cache.keys().next().value!)
    cache.set(key, url)
    return url
  }

  function remove(element: HTMLElement) {
    records.get(element)?.filter.remove()
    records.delete(element)
    element.removeAttribute('data-fluid-refracted')
    element.style.removeProperty('--fluid-glass-filter')
  }

  function update(element: HTMLElement) {
    const w = element.offsetWidth, h = element.offsetHeight
    if (w < 2 || h < 2 || w > 4096 || h > 2048) { remove(element); return }
    // Layout dimensions, rather than animated transforms, keep the lens stationary in surface space.
    const radiusText = getComputedStyle(element).borderTopLeftRadius
    const r = Math.round(radiusText.endsWith('%') ? parseFloat(radiusText) * Math.min(w, h) / 100 : parseFloat(radiusText) || 0)
    const signature = `${w}:${h}:${r}`
    let record = records.get(element)
    if (record?.signature === signature) return
    const url = mapFor(w, h, r)
    if (!url) return
    if (!record) {
      const id = `huiyu-fluid-lens-${++serial}`
      const filter = svgNode('filter', { id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })
      const image = svgNode('feImage', { result: 'lens-map', preserveAspectRatio: 'none', x: '0', y: '0' })
      filter.append(image,
        svgNode('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '2.4', result: 'soft-backdrop' }),
        svgNode('feDisplacementMap', { in: 'soft-backdrop', in2: 'lens-map', scale: '32', xChannelSelector: 'R', yChannelSelector: 'G', result: 'refracted' }),
        svgNode('feColorMatrix', { in: 'refracted', type: 'saturate', values: '1.18' }))
      record = { filter, image, signature: '' }
      records.set(element, record)
    }
    record.signature = signature
    for (const node of [record.filter, record.image]) {
      node.setAttribute('width', String(w)); node.setAttribute('height', String(h))
      node.setAttribute('x', '0'); node.setAttribute('y', '0')
    }
    record.image.setAttribute('href', url)
    // Populate the image before attaching the SVG filter to avoid invalid resource requests.
    defs.append(record.filter)
    // Inline fragment references survive Vue's history.pushState route changes.
    const filterUrl = `#${record.filter.id}`
    element.style.setProperty('--fluid-glass-filter', `url(${JSON.stringify(filterUrl)})`)
    element.setAttribute('data-fluid-refracted', '')
  }

  function refresh() {
    timer = 0
    for (const element of candidates) if (!element.isConnected || !element.matches(FLUID_GLASS_SELECTOR)) {
      remove(element); candidates.delete(element); visible.delete(element)
      resize.unobserve(element); intersections.unobserve(element)
    }
    for (const element of records.keys()) if (!enabled() || !visible.has(element) || !element.getClientRects().length ||
      getComputedStyle(element).visibility === 'hidden') remove(element)
    if (!enabled()) return
    for (const element of visible) {
      if (!element.isConnected || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue
      // Never refract a translucent layer through another lens.
      if (element.parentElement?.closest('[data-fluid-refracted]')) { remove(element); continue }
      if (!records.has(element) && records.size >= MAX_SURFACES) continue
      update(element)
    }
  }
  function schedule() { if (!disposed && !timer) timer = window.setTimeout(refresh, 80) }
  const resize = new ResizeObserver(schedule)
  const intersections = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const element = entry.target as HTMLElement
      if (entry.isIntersecting) visible.add(element)
      else visible.delete(element)
    }
    schedule()
  })
  function discover(node: Node) {
    if (!(node instanceof Element) || svg.contains(node)) return
    const elements = [...node.querySelectorAll<HTMLElement>(FLUID_GLASS_SELECTOR)]
    if (node instanceof HTMLElement && node.matches(FLUID_GLASS_SELECTOR)) elements.unshift(node)
    for (const element of elements) if (!candidates.has(element)) {
      candidates.add(element); resize.observe(element); intersections.observe(element)
    }
  }
  const mutations = new MutationObserver(events => {
    let changed = false
    for (const event of events) {
      if (svg.contains(event.target)) continue
      if (event.type === 'childList') {
        event.addedNodes.forEach(discover)
        changed ||= event.removedNodes.length > 0 || event.addedNodes.length > 0
      } else if (event.target instanceof Element) {
        // A class toggle can reveal an existing surface; no document-wide polling.
        discover(event.target)
        changed = true
      }
    }
    if (changed) schedule()
  })
  mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open', 'class', 'data-fluid-glass'] })
  const preferences = new MutationObserver(schedule)
  preferences.observe(root, { attributes: true, attributeFilter: ['data-fluid-effects', 'data-theme'] })
  queries.forEach(query => query.addEventListener('change', schedule))
  document.addEventListener('visibilitychange', schedule)
  discover(document.body)
  installed = () => {
    if (disposed) return
    disposed = true
    window.clearTimeout(timer)
    mutations.disconnect(); preferences.disconnect(); resize.disconnect(); intersections.disconnect()
    queries.forEach(query => query.removeEventListener('change', schedule))
    document.removeEventListener('visibilitychange', schedule)
    for (const element of records.keys()) remove(element)
    candidates.clear(); visible.clear(); cache.clear(); svg.remove()
    installed = undefined
  }
  return installed
}
