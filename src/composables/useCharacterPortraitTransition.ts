import { nextTick, onDeactivated, onScopeDispose, ref, watch, type Ref } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { useFluidSurface } from './useFluidSurface'

type Portrait = { image: HTMLImageElement; box: DOMRect; fit: string; position: string; opacity: number }

/** Join the real shelf portrait to its archive image; loading/particle views keep the normal fade. */
export function useCharacterPortraitTransition(root: Ref<HTMLElement | null>, showShelf: Ref<boolean>, characterId: () => string) {
  const fallback = useFluidSurface()
  const preferOriginal = ref(false)
  let pending: Portrait | null = null
  let floating: HTMLImageElement | null = null
  let animation: Animation | null = null
  let landing: Animation | null = null
  let revealTarget = () => {}
  let revision = 0

  function portrait(image: HTMLImageElement | null): Portrait | null {
    if (!image?.isConnected || !image.complete || !image.naturalWidth) return null
    for (let element: HTMLElement | null = image; element; element = element.parentElement) {
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || /blur\(/.test(style.filter)) return null
    }
    const style = getComputedStyle(image)
    let box = image.getBoundingClientRect()
    let fit = style.objectFit, position = style.objectPosition
    // Directory portraits may be enlarged inside an overflow-hidden frame. A
    // plain image clone cannot reproduce that crop; leave it to the normal fade.
    if (image !== floating && style.transform && style.transform !== 'none') return null
    // The original lives in a wide contain mat. Connect the painted portrait,
    // not the empty margins, so it does not stretch across the whole panel.
    if (style.objectFit === 'contain') {
      const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight)
      const width = image.naturalWidth * scale, height = image.naturalHeight * scale
      box = new DOMRect(box.left + (box.width - width) / 2, box.top + (box.height - height) / 2, width, height)
    }
    const frame = image.closest<HTMLElement>('.character-portrait')
    if (frame) {
      const clip = frame.getBoundingClientRect()
      const left = Math.max(box.left, clip.left + frame.clientLeft), top = Math.max(box.top, clip.top + frame.clientTop)
      const right = Math.min(box.right, clip.right - frame.clientLeft), bottom = Math.min(box.bottom, clip.bottom - frame.clientTop)
      // The shelf's natural image can extend below its fixed cover viewport.
      // Connect that visible cover, not the pixels clipped over its caption.
      // More complex offset crops need an actual snapshot, so use the fade.
      if (left - box.left > 1 || top - box.top > 1 || box.right - right > 1) return null
      if (bottom < box.bottom - 1) { fit = 'cover'; position = 'center top' }
      box = new DOMRect(left, top, right - left, bottom - top)
    }
    if (box.width < 20 || box.height < 20 || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return null
    return { image, box, fit, position, opacity: Number(style.opacity || 1) }
  }
  function shelfImage() {
    const card = [...(root.value?.querySelectorAll<HTMLElement>('.bookshelf-character') || [])]
      .find(element => element.dataset.character === characterId())
    return card?.querySelector<HTMLImageElement>('img') || null
  }
  function originalImage() { return root.value?.querySelector<HTMLImageElement>('.portrait-image') || null }
  function clear() {
    if (animation) { animation.onfinish = animation.oncancel = null; animation.cancel(); animation = null }
    landing?.cancel(); landing = null
    floating?.remove(); floating = null
    revealTarget(); revealTarget = () => {}
  }
  function cancel() { revision++; pending = null; clear() }
  function join(source: Portrait, target: Portrait) {
    const image = source.image.cloneNode(false) as HTMLImageElement
    image.removeAttribute('id'); image.removeAttribute('class'); image.alt = ''
    image.setAttribute('aria-hidden', 'true'); image.setAttribute('data-archive-portrait-flight', '')
    Object.assign(image.style, {
      position: 'fixed', inset: 'auto', left: '0', top: '0', margin: '0',
      width: `${source.box.width}px`, height: `${source.box.height}px`, maxWidth: 'none', maxHeight: 'none',
      objectFit: source.fit || 'cover', objectPosition: source.position || 'center',
      borderRadius: 'var(--r-md)', pointerEvents: 'none', zIndex: 'var(--z-overlay)', transformOrigin: '0 0',
    })
    document.body.append(image); floating = image
    const opacity = target.image.style.opacity
    target.image.style.opacity = '0'
    revealTarget = () => { target.image.style.opacity = opacity }
    const from = source.box, to = target.box
    const start = `translate(${from.x}px, ${from.y}px) scale(1, 1)`
    // Shelf portraits are cropped, originals use contain. Keep the face's aspect
    // ratio while travelling, then cross-fade the crop into the real full image.
    const scale = Math.min(to.width / from.width, to.height / from.height)
    const x = to.x + (to.width - from.width * scale) / 2
    const y = to.y + (to.height - from.height * scale) / 2
    const end = `translate(${x}px, ${y}px) scale(${scale}, ${scale})`
    try {
      animation = image.animate([
        { transform: start, opacity: source.opacity, offset: 0 },
        { transform: end, opacity: 1, offset: .84 },
        { transform: end, opacity: 0, offset: 1 },
      ], { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' })
      // Cross-fade onto the actual image only as the clone lands, rather than
      // exposing a second full-size portrait behind the travelling thumbnail.
      landing = target.image.animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: .68 }, { opacity: 1, offset: 1 }],
        { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' })
      animation.onfinish = clear
      animation.oncancel = clear
    } catch { clear() }
  }

  watch(showShelf, async shelf => {
    const version = ++revision
    const source = prefersReducedMotion() ? null : portrait(floating) || portrait(shelf ? originalImage() : shelfImage())
    clear(); pending = source
    if (!shelf) preferOriginal.value = !!source
    // Navigation restores scroll in its post-render watcher. Measure only after
    // that watcher has completed, so the return lands at the original card.
    await nextTick(); await nextTick()
    if (version !== revision || !root.value) return
    pending = null
    const target = source && portrait(shelf ? shelfImage() : originalImage())
    if (source && target && !prefersReducedMotion()) join(source, target)
    else {
      const section = root.value.querySelector<HTMLElement>(shelf ? '.character-bookshelf' : '.library-layout')
      if (source && section) fallback.enter(section, () => {})
    }
  })
  function enter(element: Element, done: () => void) { if (pending) done(); else fallback.enter(element, done) }
  const preference = () => { if (prefersReducedMotion()) cancel() }
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  media?.addEventListener('change', preference)
  window.addEventListener('atelier:motion-preference', preference)
  window.addEventListener('resize', cancel)
  window.addEventListener('wheel', cancel, { passive: true })
  window.addEventListener('touchstart', cancel, { passive: true })
  onDeactivated(cancel)
  onScopeDispose(() => {
    cancel(); media?.removeEventListener('change', preference)
    window.removeEventListener('atelier:motion-preference', preference)
    window.removeEventListener('resize', cancel); window.removeEventListener('wheel', cancel); window.removeEventListener('touchstart', cancel)
  })
  return { preferOriginal, enter, dispose: fallback.dispose }
}
