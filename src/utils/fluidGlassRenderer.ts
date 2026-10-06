/** Rounded glass optics adapted from DeepSeek Harness Desktop's MIT liquid-glass module. */
import { listenMotionChanges, prefersReducedMotion } from './motionPreference'
export const FLUID_GLASS_SELECTOR = '.nav, .nav-more-menu, .sticky-toolbar, .companion-toolbar, .toolbar-shell, .gallery-toolbar, .scene-toolbar, .pop-toolbar, .gen-bar, [data-fluid-glass]'
const SVG_NS = 'http://www.w3.org/2000/svg'
const MAX_SURFACES = 12
const MAX_MAPS = 32
const MAX_MAP_PIXELS = 160_000
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/** Independent axes preserve the bevel of wide, short toolbars within one pixel budget. */
export function fluidMapSize(w: number, h: number): [number, number] {
  const width = Math.min(2048, Math.max(2, Math.ceil(w))), height = Math.min(512, Math.max(2, Math.ceil(h)))
  const scale = Math.min(1, Math.sqrt(MAX_MAP_PIXELS / (width * height)))
  return [Math.max(2, Math.floor(width * scale)), Math.max(2, Math.floor(height * scale))]
}

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
  element: HTMLElement
  layer: HTMLDivElement
  sheen: HTMLDivElement
  displacement: SVGFEDisplacementMapElement
  release: () => void
  channels: SVGElement[]
  theme: string
  hovered: boolean
}
let serial = 0

/** The expensive renderer exists only while liquid material is explicitly active. */
export function mountFluidGlass(): () => void {
  if (typeof window === 'undefined' || !window.ResizeObserver || !window.IntersectionObserver ||
    !window.CSS?.supports('backdrop-filter', 'url("#fluid-glass")')) return () => {}

  const root = document.documentElement
  const queries = ['(forced-colors: active)', '(prefers-contrast: more)', '(prefers-reduced-transparency: reduce)']
    .map(query => window.matchMedia(query))
  const candidates = new Set<HTMLElement>()
  const visible = new Set<HTMLElement>()
  const records = new Map<HTMLElement, GlassRecord>()
  const cache = new Map<string, Promise<string | undefined>>()
  const pending = new Map<HTMLElement, string>()
  let frame = 0, pointer: { record: GlassRecord; x: number; y: number } | undefined, pressed: GlassRecord | undefined
  let mapQueue = Promise.resolve()
  const svg = svgNode('svg', { 'aria-hidden': 'true', width: '0', height: '0', focusable: 'false' })
  svg.classList.add('fluid-glass-definitions')
  const defs = svgNode('defs')
  svg.append(defs)
  document.body.append(svg)
  let timer = 0, disposed = false
  const enabled = () => root.dataset.glassMaterial === 'liquid' && root.dataset.fluidEffects !== 'low' && !document.hidden && !queries.some(query => query.matches)

  // Clamp only extremes needed for reading; keep midtones and foreground ungraded.
  function balanceBackdrop(record: GlassRecord) {
    const theme = root.dataset.theme === 'light' ? 'light' : 'dark'
    const tint = Number(root.style.getPropertyValue('--glass-tint') || .35)
    const appearance = `${theme}:${tint}`
    if (record.theme === appearance) return
    record.theme = appearance
    const fill = .3 + clamp(tint, 0, 1) * .42
    // Current surface-channel bounds: light #fffcf6, dark #1e2935.
    const limit = clamp(theme === 'light' ? (.57 - fill * .965) / (1 - fill) : (.42 - fill * .208) / (1 - fill), 0, 1)
    const values = Array.from({ length: 9 }, (_, i) => (theme === 'light' ? Math.max(limit, i / 8) : Math.min(limit, i / 8)).toFixed(4)).join(' ')
    for (const channel of record.channels) {
      channel.setAttribute('tableValues', values)
    }
  }

  function queuePresentation() {
    if (disposed || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (pointer && records.get(pointer.record.element) === pointer.record && !prefersReducedMotion()) {
        const { record, x, y } = pointer, box = record.element.getBoundingClientRect()
        record.sheen.style.transform = `translate3d(calc(-50% + ${x - box.left - box.width / 2}px),calc(-50% + ${y - box.top - box.height / 2}px),0) scale(${pressed === record ? 1.08 : 1})`
      }
      pointer = undefined
    })
  }
  function resetPress() {
    if (!pressed) return
    pressed.displacement.setAttribute('scale', '32')
    pressed.sheen.style.opacity = pressed.hovered && !prefersReducedMotion() ? '.22' : '0'
    pressed = undefined
  }
  function interactive(record: GlassRecord) {
    const move = (event: PointerEvent) => {
      if (prefersReducedMotion() || event.pointerType === 'touch') return
      record.hovered = true; record.sheen.style.opacity = pressed === record ? '.36' : '.22'
      pointer = { record, x: event.clientX, y: event.clientY }; queuePresentation()
    }
    const leave = () => { record.hovered = false; if (pressed !== record) record.sheen.style.opacity = '0' }
    const press = () => {
      if (prefersReducedMotion()) return
      resetPress(); pressed = record
      // Two discrete optical updates per press reuse the map; only the light animates per frame.
      record.displacement.setAttribute('scale', '35.2'); record.sheen.style.opacity = '.36'
    }
    const key = (event: KeyboardEvent) => {
      if (!['Enter', ' '].includes(event.key) || event.repeat || !(event.target instanceof Element)
        || !event.target.closest('button,a,[role="button"],[role="tab"],[role="radio"],[role="option"]')) return
      const box = record.element.getBoundingClientRect()
      press(); pointer = { record, x: box.left + box.width / 2, y: box.top + box.height / 2 }; queuePresentation()
    }
    record.element.addEventListener('pointermove', move); record.element.addEventListener('pointerleave', leave)
    record.element.addEventListener('pointerdown', press); record.element.addEventListener('keydown', key)
    return () => {
      if (pressed === record) resetPress()
      if (pointer?.record === record) pointer = undefined
      record.element.removeEventListener('pointermove', move); record.element.removeEventListener('pointerleave', leave)
      record.element.removeEventListener('pointerdown', press); record.element.removeEventListener('keydown', key)
    }
  }
  const stopMotion = listenMotionChanges(() => {
    if (!prefersReducedMotion()) return
    resetPress(); pointer = undefined
    for (const record of records.values()) { record.hovered = false; record.sheen.style.opacity = '0' }
  })
  window.addEventListener('pointerup', resetPress); window.addEventListener('pointercancel', resetPress); window.addEventListener('keyup', resetPress)

  async function buildMap(w: number, h: number, r: number) {
    if (disposed) return undefined
    const canvas = document.createElement('canvas')
    ;[canvas.width, canvas.height] = fluidMapSize(w, h)
    // Pixels originate on the CPU; do not upload them only to synchronously read
    // them back from the GPU for PNG encoding.
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return undefined
    const pixels = context.createImageData(canvas.width, canvas.height)
    for (let y = 0; y < canvas.height; y++) {
      if (y % 8 === 0) {
        await new Promise(resolve => window.setTimeout(resolve, 0))
        if (disposed) return undefined
      }
      for (let x = 0; x < canvas.width; x++) {
        const [dx, dy] = fluidLens(w, h, r, (x + .5) * w / canvas.width, (y + .5) * h / canvas.height)
        const i = (y * canvas.width + x) * 4
        pixels.data[i] = Math.round(127.5 + dx / 32 * 255)
        pixels.data[i + 1] = Math.round(127.5 + dy / 32 * 255)
        // B is unused by displacement: reuse it for a smooth reading/clear-bevel mask.
        pixels.data[i + 2] = Math.round(255 * (1 - Math.min(1, Math.hypot(dx, dy) / 8)))
        pixels.data[i + 3] = 255
      }
    }
    context.putImageData(pixels, 0, 0)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob || disposed) return undefined
    return new Promise<string | undefined>(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(disposed ? undefined : String(reader.result))
      reader.onerror = reader.onabort = () => resolve(undefined)
      reader.readAsDataURL(blob)
    })
  }

  function mapFor(w: number, h: number, r: number) {
    const key = `${w}:${h}:${r}`
    const cached = cache.get(key)
    if (cached) return cached
    // Rapid resizing can supersede a queued shape before it starts. Do not let
    // obsolete maps delay the latest surface, and allow a later retry of that key.
    const result: Promise<string | undefined> = mapQueue
      .then(() => [...pending.values()].includes(key) ? buildMap(w, h, r) : undefined)
      .catch(() => undefined)
      .then(url => { if (!url && cache.get(key) === result) cache.delete(key); return url })
    mapQueue = result.then(() => undefined)
    if (cache.size >= MAX_MAPS) cache.delete(cache.keys().next().value!)
    cache.set(key, result)
    return result
  }

  function remove(element: HTMLElement) {
    pending.delete(element)
    const record = records.get(element)
    if (record) {
      record.release(); record.filter.remove(); record.layer.remove()
    }
    records.delete(element)
    element.classList.remove('fluid-glass-positioned')
    element.removeAttribute('data-fluid-refracted')
    element.style.removeProperty('--fluid-glass-filter')
  }

  async function update(element: HTMLElement) {
    const w = element.offsetWidth, h = element.offsetHeight
    if (w < 2 || h < 2 || w > 4096 || h > 2048) { remove(element); return }
    // Layout dimensions, rather than animated transforms, keep the lens stationary in surface space.
    const radiusText = getComputedStyle(element).borderTopLeftRadius
    const r = Math.round(radiusText.endsWith('%') ? parseFloat(radiusText) * Math.min(w, h) / 100 : parseFloat(radiusText) || 0)
    const signature = `${w}:${h}:${r}`
    let record = records.get(element)
    if (record) balanceBackdrop(record)
    if (record?.signature === signature || pending.get(element) === signature) return
    pending.set(element, signature)
    const url = await mapFor(w, h, r)
    if (disposed || pending.get(element) !== signature) return
    pending.delete(element)
    if (!enabled() || !element.isConnected || !visible.has(element) || !element.matches(FLUID_GLASS_SELECTOR)
      || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden'
      || element.parentElement?.closest('[data-fluid-refracted]')) return
    if (element.offsetWidth !== w || element.offsetHeight !== h) { schedule(); return }
    record = records.get(element)
    if (!url) return
    if (!record) {
      const id = `huiyu-fluid-lens-${++serial}`
      const filter = svgNode('filter', { id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })
      const image = svgNode('feImage', { result: 'lens-map', preserveAspectRatio: 'none', x: '0', y: '0' })
      const displacement = svgNode('feDisplacementMap', { in: 'soft-backdrop', in2: 'lens-map', scale: '32', xChannelSelector: 'R', yChannelSelector: 'G', result: 'refracted' })
      filter.append(image,
        svgNode('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '1.2', result: 'soft-backdrop' }),
        displacement,
        svgNode('feColorMatrix', { in: 'refracted', type: 'saturate', values: '1.18', result: 'pigment' }))
      const transfer = svgNode('feComponentTransfer', { in: 'pigment', result: 'reading-backdrop' })
      const channels = [svgNode('feFuncR', { type: 'table' }), svgNode('feFuncG', { type: 'table' }), svgNode('feFuncB', { type: 'table' })]
      transfer.append(...channels); filter.append(transfer)
      // The same map keeps ungraded color on the refracting lip, away from labels.
      filter.append(
        svgNode('feColorMatrix', { in: 'lens-map', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0', result: 'reading-mask' }),
        svgNode('feComposite', { in: 'reading-backdrop', in2: 'reading-mask', operator: 'in', result: 'reading-body' }),
        svgNode('feComposite', { in: 'pigment', in2: 'reading-mask', operator: 'out', result: 'clear-bevel' }),
        svgNode('feComposite', { in: 'reading-body', in2: 'clear-bevel', operator: 'arithmetic', k1: '0', k2: '1', k3: '1', k4: '0' }))
      const layer = document.createElement('div'), sheen = document.createElement('div')
      layer.className = 'fluid-glass-optics'; layer.setAttribute('aria-hidden', 'true')
      sheen.className = 'fluid-glass-sheen'
      layer.append(sheen)
      record = { filter, image, signature: '', element, layer, sheen, displacement, channels, theme: '', release: () => {}, hovered: false }
      records.set(element, record)
      balanceBackdrop(record)
      if (getComputedStyle(element).position === 'static') element.classList.add('fluid-glass-positioned')
      element.prepend(layer); record.release = interactive(record)
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
      if (!records.has(element) && !pending.has(element)
        && new Set([...records.keys(), ...pending.keys()]).size >= MAX_SURFACES) continue
      void update(element)
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
      if (svg.contains(event.target) || event.target.parentElement?.closest('.fluid-glass-optics')) continue
      if (event.type === 'childList' && [...event.addedNodes, ...event.removedNodes].every(node => node instanceof Element && node.classList.contains('fluid-glass-optics'))) continue
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
  const preferences = new MutationObserver(() => { for (const record of records.values()) balanceBackdrop(record); schedule() })
  preferences.observe(root, { attributes: true, attributeFilter: ['data-fluid-effects', 'data-theme', 'style'] })
  queries.forEach(query => query.addEventListener('change', schedule))
  document.addEventListener('visibilitychange', schedule)
  discover(document.body)
  return () => {
    if (disposed) return
    disposed = true
    window.clearTimeout(timer)
    cancelAnimationFrame(frame); stopMotion()
    window.removeEventListener('pointerup', resetPress); window.removeEventListener('pointercancel', resetPress); window.removeEventListener('keyup', resetPress)
    mutations.disconnect(); preferences.disconnect(); resize.disconnect(); intersections.disconnect()
    queries.forEach(query => query.removeEventListener('change', schedule))
    document.removeEventListener('visibilitychange', schedule)
    for (const element of records.keys()) remove(element)
    pending.clear(); candidates.clear(); visible.clear(); cache.clear(); svg.remove()
  }
}
