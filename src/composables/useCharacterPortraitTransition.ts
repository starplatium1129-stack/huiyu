import { nextTick, onDeactivated, onScopeDispose, ref, watch, type Ref } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { useFluidSurface } from './useFluidSurface'

type Portrait = { image: HTMLImageElement; box: DOMRect; painted: DOMRect; opacity: number }
const duration = 240
const easing = 'cubic-bezier(.23, 1, .32, 1)'

/** Connect the painted image and its visible crop, leaving loading/particle views to the normal fade. */
export function useCharacterPortraitTransition(root: Ref<HTMLElement | null>, showShelf: Ref<boolean>, characterId: () => string) {
  const fallback = useFluidSurface()
  const preferOriginal = ref(false)
  let pending: Portrait | null = null
  let floating: HTMLDivElement | null = null
  let floatingImage: HTMLImageElement | null = null
  let animations: Animation[] = []
  let revealTarget = () => {}
  let revision = 0
  let keyboard = false

  function position(value: string, space: number) {
    if (value.endsWith('%')) return space * parseFloat(value) / 100
    if (value.endsWith('px')) return parseFloat(value)
    return value === 'left' || value === 'top' ? 0 : value === 'right' || value === 'bottom' ? space : space / 2
  }
  function portrait(image: HTMLImageElement | null): Portrait | null {
    if (!image?.isConnected || !image.complete || !image.naturalWidth || !image.naturalHeight) return null
    for (let element: HTMLElement | null = image; element; element = element.parentElement) {
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || /blur\(/.test(style.filter)) return null
    }
    const style = getComputedStyle(image)
    if (style.transform && style.transform !== 'none') return null
    const rect = image.getBoundingClientRect()
    const contain = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
    const scale = style.objectFit === 'contain' ? contain : style.objectFit === 'scale-down' ? Math.min(1, contain)
      : style.objectFit === 'none' ? 1 : Math.max(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale
    const [horizontal = '50%', vertical = '50%'] = style.objectPosition.trim().split(/\s+/)
    const painted = new DOMRect(rect.left + position(horizontal, rect.width - width), rect.top + position(vertical, rect.height - height), width, height)
    const frame = image.closest<HTMLElement>('.character-portrait')
    const clip = frame?.getBoundingClientRect() || rect
    const inset = frame?.clientLeft || 0
    const left = Math.max(rect.left, painted.left, clip.left + inset), top = Math.max(rect.top, painted.top, clip.top + inset)
    const right = Math.min(rect.right, painted.right, clip.right - inset), bottom = Math.min(rect.bottom, painted.bottom, clip.bottom - inset)
    const box = new DOMRect(left, top, right - left, bottom - top)
    if (box.width < 20 || box.height < 20 || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return null
    return { image, box, painted, opacity: Number(style.opacity || 1) }
  }
  function currentFlight(): Portrait | null {
    if (!floating?.isConnected || !floatingImage?.complete || !floatingImage.naturalWidth) return null
    return { image: floatingImage, box: floating.getBoundingClientRect(), painted: floatingImage.getBoundingClientRect(), opacity: Number(getComputedStyle(floating).opacity || 1) }
  }
  function shelfImage() {
    const card = [...(root.value?.querySelectorAll<HTMLElement>('.bookshelf-character') || [])]
      .find(element => element.dataset.character === characterId())
    return card?.querySelector<HTMLImageElement>('img') || null
  }
  function originalImage() { return root.value?.querySelector<HTMLImageElement>('.portrait-image') || null }
  function clear() {
    for (const animation of animations) { animation.onfinish = animation.oncancel = null; animation.cancel() }
    animations = []
    floating?.remove(); floating = null; floatingImage = null
    revealTarget(); revealTarget = () => {}
  }
  function cancel() { revision++; pending = null; clear() }
  function join(source: Portrait, target: Portrait) {
    const frame = document.createElement('div')
    frame.setAttribute('aria-hidden', 'true'); frame.setAttribute('data-archive-portrait-flight', '')
    frame.dataset.character = characterId()
    Object.assign(frame.style, {
      position: 'fixed', inset: 'auto', left: '0', top: '0', margin: '0',
      width: `${source.box.width}px`, height: `${source.box.height}px`, overflow: 'hidden',
      borderRadius: 'var(--r-md)', pointerEvents: 'none', zIndex: 'var(--z-overlay)', transformOrigin: '0 0',
    })
    const image = source.image.cloneNode(false) as HTMLImageElement
    image.removeAttribute('id'); image.removeAttribute('class'); image.removeAttribute('style'); image.alt = ''
    Object.assign(image.style, {
      position: 'absolute', left: '0', top: '0', margin: '0', display: 'block',
      width: `${source.painted.width}px`, height: `${source.painted.height}px`, maxWidth: 'none', maxHeight: 'none',
      objectFit: 'fill', border: '0', borderRadius: '0', filter: 'none', transformOrigin: '0 0',
    })
    frame.append(image); document.body.append(frame); floating = frame; floatingImage = image
    const opacity = target.image.style.opacity
    target.image.style.opacity = '0'
    revealTarget = () => { target.image.style.opacity = opacity }
    const clipFrames: Keyframe[] = [], imageFrames: Keyframe[] = []
    const mix = (from: number, to: number, progress: number) => from + (to - from) * progress
    // Both layers use the same compositor timeline. Counter-scale the image
    // against its crop frame so faces retain their natural ratio while the
    // clipped card opens into a contain mat. Intermediate geometry is sampled
    // here once; no layout reads or style writes run during the flight.
    for (let step = 0; step <= 32; step++) {
      const progress = step / 32
      const x = mix(source.box.x, target.box.x, progress), y = mix(source.box.y, target.box.y, progress)
      const sx = mix(source.box.width, target.box.width, progress) / source.box.width
      const sy = mix(source.box.height, target.box.height, progress) / source.box.height
      const scale = mix(source.painted.width, target.painted.width, progress) / source.painted.width
      const ix = (mix(source.painted.x, target.painted.x, progress) - x) / sx
      const iy = (mix(source.painted.y, target.painted.y, progress) - y) / sy
      clipFrames.push({ transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})`,
        opacity: source.opacity, offset: progress })
      imageFrames.push({ transform: `translate(${ix}px, ${iy}px) scale(${scale / sx}, ${scale / sy})`, offset: progress })
    }
    try {
      const flight = frame.animate(clipFrames, { duration, easing, fill: 'both' })
      animations.push(flight)
      animations.push(image.animate(imageFrames, { duration, easing, fill: 'both' }))
      // Keep one portrait visible throughout the flight. The real image is
      // restored in the same task that removes this proxy at its final geometry.
      flight.onfinish = clear; flight.oncancel = clear
    } catch { clear() }
  }

  watch(showShelf, async shelf => {
    const version = ++revision, id = characterId()
    const ready = currentFlight() || portrait(shelf ? originalImage() : shelfImage())
    const source = document.hidden || prefersReducedMotion() || keyboard ? null : ready
    clear(); pending = source
    if (!shelf) preferOriginal.value = !!ready
    // Navigation restores scroll/focus in its post-render watcher. Measure
    // after that handoff so the return lands at the user's original card.
    await nextTick(); await nextTick()
    if (version !== revision) return
    if (id !== characterId() || !root.value) { pending = null; return }
    pending = null
    const target = source && portrait(shelf ? shelfImage() : originalImage())
    // Thumbnail/full-image pairs share a composition. A different aspect ratio
    // can indicate another crop, so keep the normal transition for that pair.
    const sameRatio = source && target && Math.abs(source.painted.width / source.painted.height / (target.painted.width / target.painted.height) - 1) <= .02
    if (source && target && sameRatio && !prefersReducedMotion() && !keyboard) join(source, target)
    else {
      const section = root.value.querySelector<HTMLElement>(shelf ? '.character-bookshelf' : '.library-layout')
      if (source && section && !keyboard) fallback.enter(section, () => {})
    }
  })
  watch(characterId, id => { if (floating && floating.dataset.character !== id) cancel() })
  function enter(element: Element, done: () => void) { if (pending || keyboard) done(); else fallback.enter(element, done) }
  const preference = () => { if (prefersReducedMotion() || document.hidden) cancel() }
  const pointer = () => { keyboard = false }
  const key = () => { keyboard = true; cancel() }
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  media?.addEventListener('change', preference)
  window.addEventListener('atelier:motion-preference', preference)
  document.addEventListener('visibilitychange', preference)
  window.addEventListener('pointerdown', pointer, true)
  window.addEventListener('keydown', key, true)
  window.addEventListener('resize', cancel)
  window.addEventListener('wheel', cancel, { passive: true })
  window.addEventListener('touchstart', cancel, { passive: true })
  onDeactivated(cancel)
  onScopeDispose(() => {
    cancel(); media?.removeEventListener('change', preference)
    window.removeEventListener('atelier:motion-preference', preference)
    document.removeEventListener('visibilitychange', preference)
    window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('keydown', key, true)
    window.removeEventListener('resize', cancel); window.removeEventListener('wheel', cancel); window.removeEventListener('touchstart', cancel)
  })
  return { preferOriginal, enter, dispose: fallback.dispose }
}
