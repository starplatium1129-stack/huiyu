import { nextTick, onDeactivated, onUnmounted, ref, watch, type Ref } from 'vue'
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
  const motion = useImageOriginTransition({ proxyPixelBudget: 1920 * 1080 })
  const previewSrc = ref('')
  let capturedId = ''
  let opening = false
  let capturedAt = 0
  function sourceImage() {
    const id = options.current.value?.id
    const card = [...(options.shellEl.value?.querySelectorAll<HTMLElement>('.artwork') ?? [])].find(el => el.dataset.cardId === String(id))
    return card?.querySelector<HTMLImageElement>('.artwork-image-hd.is-loaded') ?? card?.querySelector<HTMLImageElement>('.artwork-image:not(.artwork-image-hd)') ?? null
  }
  function capture(event: MouseEvent) {
    const button = event.currentTarget as HTMLElement
    const id = button.closest<HTMLElement>('.artwork')?.dataset.cardId || ''
    if (capturedId !== id) motion.cancel()
    capturedId = id
    previewSrc.value = motion.capture(button.querySelector<HTMLImageElement>('.artwork-image-hd.is-loaded') ?? button.querySelector<HTMLImageElement>('.artwork-image:not(.artwork-image-hd)'))
    opening = true
    capturedAt = performance.now()
  }
  async function enter() {
    if (!opening || options.viewerIndex.value < 0) return
    await nextTick()
    if (!opening || options.viewerIndex.value < 0) return
    if (performance.now() - capturedAt >= 180) { opening = false; return }
    const host = options.viewerEl.value, image = host?.querySelector<HTMLImageElement>(PREVIEW_IMAGE)
    if (!host || !image || options.viewerIndex.value < 0) return
    // The viewer mounts before a cached thumbnail's load event. Do not consume
    // the capture yet: the bounded flight needs warm pixels and can retry on
    // that first load, still within the original 180ms handoff window.
    if (!image.complete || !image.naturalWidth) return
    opening = false
    void motion.enter(image, host)
  }
  watch([options.viewerIndex, options.viewerUrl], () => { void enter() }, { flush: 'post' })
  watch(() => { const item = options.current.value; return item && [item.id, item.image_id, item.image_url, item.image_data] }, (item, previous) => {
    // The first selection consumes the capture. Later navigation/replacement
    // must never borrow the previous artwork's preview or floating frame.
    if (item && opening && String(item[0]) === capturedId && item[0] !== previous?.[0]) return
    cancel()
  }, { flush: 'sync' })
  function loaded(event: Event) {
    if (event.target instanceof HTMLImageElement && event.target.matches(PREVIEW_IMAGE)) void enter()
  }
  function leave() {
    opening = false
    const host = options.viewerEl.value, image = host?.querySelector<HTMLImageElement>(PREVIEW_IMAGE)
    if (host && image) void motion.leave(image, host, sourceImage())
    else motion.cancel()
  }
  function interrupt() { opening = false; motion.cancel() }
  function failed(event: Event) {
    if (event.target instanceof HTMLImageElement && event.target.matches(PREVIEW_IMAGE)) interrupt()
  }
  function cancel() { interrupt(); previewSrc.value = ''; capturedId = '' }
  window.addEventListener('resize', interrupt)
  window.visualViewport?.addEventListener('resize', interrupt)
  onDeactivated(cancel)
  onUnmounted(() => {
    cancel()
    window.removeEventListener('resize', interrupt)
    window.visualViewport?.removeEventListener('resize', interrupt)
  })
  return { capture, enter, loaded, leave, cancel, failed, previewSrc }
}
