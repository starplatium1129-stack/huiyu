import { nextTick, watch, type Ref } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'
import { useImageOriginTransition } from '@/composables/useImageOriginTransition'

const PREVIEW_IMAGE = '.zoomable-img, .image-compare-slider .after-img, .pswp__item[aria-hidden="false"] .pswp__img:not(.pswp__img--placeholder)'

/** Gallery-specific DOM selection; the shared flight owns only the transient image. */
export function useGalleryImageOrigin(options: {
  viewerEl: Ref<HTMLElement | null>
  shellEl: Ref<HTMLElement | null>
  viewerIndex: Ref<number>
  viewerUrl: Ref<string>
  current: Ref<ArtworkRecord | null>
}) {
  const motion = useImageOriginTransition()
  let opening = false
  let capturedAt = 0
  function sourceImage() {
    const id = options.current.value?.id
    const card = [...(options.shellEl.value?.querySelectorAll<HTMLElement>('.artwork') ?? [])].find(el => el.dataset.cardId === String(id))
    return card?.querySelector<HTMLImageElement>('.artwork-image-hd.is-loaded') ?? card?.querySelector<HTMLImageElement>('.artwork-image:not(.artwork-image-hd)') ?? null
  }
  function capture(event: MouseEvent) {
    const button = event.currentTarget as HTMLElement
    motion.capture(button.querySelector<HTMLImageElement>('.artwork-image-hd.is-loaded') ?? button.querySelector<HTMLImageElement>('.artwork-image:not(.artwork-image-hd)'))
    opening = true
    capturedAt = performance.now()
  }
  async function enter() {
    if (!opening || options.viewerIndex.value < 0) return
    await nextTick()
    if (performance.now() - capturedAt >= 180) { opening = false; return }
    const host = options.viewerEl.value, image = host?.querySelector<HTMLImageElement>(PREVIEW_IMAGE)
    if (!host || !image || options.viewerIndex.value < 0) return
    opening = false
    void motion.enter(image, host)
  }
  watch([options.viewerIndex, options.viewerUrl], () => { void enter() }, { flush: 'post' })
  function loaded(event: Event) {
    if (event.target instanceof HTMLImageElement) void enter()
  }
  function leave() {
    opening = false
    const host = options.viewerEl.value, image = host?.querySelector<HTMLImageElement>(PREVIEW_IMAGE)
    if (host && image) void motion.leave(image, host, sourceImage())
    else motion.cancel()
  }
  function cancel() { opening = false; motion.cancel() }
  return { capture, enter, loaded, leave, cancel }
}
