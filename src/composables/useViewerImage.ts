import { onBeforeUnmount, ref, watch } from 'vue'
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'

/** Current-picture decoding and explicit recovery; no neighboring loads or retry loop. */
export function useViewerImage(props: Readonly<{
  src: string; previewSrc?: string; imageKey?: string | number; loadFailed?: boolean; reload?: () => Promise<void>
}>, callbacks: { loaded: () => void; error: () => void; reset: () => void; focus: () => void }) {
  const imageEl = ref<HTMLImageElement | null>(null), fullImageEl = ref<HTMLImageElement | null>(null)
  const displayedSrc = ref(props.previewSrc || props.src)
  const fullImageFailed = ref(false), imageReady = ref(false), imageFailed = ref(false)
  const imageAttempt = ref(0), fullAttempt = ref(0), imageRevision = ref(0), retrying = ref(false)
  let sourceRevision = 0, retryRevision = 0
  onBeforeUnmount(() => { sourceRevision++; retryRevision++ })

  function requestSrc(source: string, attempt: number) {
    const src = resolveRuntimeUrl(source)
    if (!attempt || /^(data:|blob:)/.test(src)) return src
    try { const url = new URL(src, location.href); url.searchParams.set('_imageRetry', String(attempt)); return url.href }
    catch { return src }
  }
  function currentImage(event: Event, full = false): event is Event & { target: HTMLImageElement } {
    const image = event.target
    return image instanceof HTMLImageElement && image === (full ? fullImageEl.value : imageEl.value)
      && image.dataset.imageAttempt === String(full ? fullAttempt.value : imageAttempt.value)
      && image.getAttribute('src') === requestSrc(full ? props.src : displayedSrc.value, full ? fullAttempt.value : imageAttempt.value)
  }
  function onImageLoad(event: Event) {
    if (!currentImage(event)) return
    imageReady.value = true; imageFailed.value = false
    if (displayedSrc.value === props.src) { fullImageFailed.value = false; retrying.value = false }
    callbacks.loaded()
  }
  function onImageError(event: Event) {
    if (!currentImage(event)) return
    if (displayedSrc.value !== props.src) { imageReady.value = false; displayedSrc.value = props.src; return }
    imageReady.value = false; imageFailed.value = true; retrying.value = false
    callbacks.error()
  }
  function onFullImageError(event: Event) {
    if (currentImage(event, true)) { fullImageFailed.value = true; retrying.value = false; callbacks.error() }
  }
  async function upgradeImage(event: Event) {
    if (!currentImage(event, true)) return
    const image = event.target, revision = sourceRevision
    try { if (typeof image.decode === 'function') await image.decode() }
    catch { if (revision === sourceRevision) onFullImageError(event); return }
    if (revision === sourceRevision && currentImage(event, true)) {
      if (imageAttempt.value !== fullAttempt.value) imageRevision.value++
      imageAttempt.value = fullAttempt.value; displayedSrc.value = props.src
    }
  }
  async function retryImage() {
    if (retrying.value) return
    const revision = ++retryRevision, source = props.src, preview = props.previewSrc
    retrying.value = true
    // Recovery disappears after success; leave focus on the picture without scrolling.
    callbacks.focus()
    try { await props.reload?.() }
    catch { if (revision === retryRevision) { retrying.value = false; callbacks.error() }; return }
    if (revision !== retryRevision) return
    if (props.loadFailed || !props.src) { retrying.value = false; return }
    // A repository refresh can replace the source; its decode owns completion.
    if (props.src !== source || props.previewSrc !== preview) return
    fullAttempt.value = Date.now(); fullImageFailed.value = false
    if (imageFailed.value) { imageRevision.value++; imageAttempt.value = fullAttempt.value; imageReady.value = false; imageFailed.value = false }
  }
  watch(() => [props.src, props.previewSrc, props.imageKey] as const, ([src, preview, key], [previousSrc, previousPreview, previousKey]) => {
    sourceRevision++
    const changedRecord = key !== previousKey
    if (changedRecord) { retryRevision++; retrying.value = false }
    if (src !== previousSrc || changedRecord) fullAttempt.value = 0
    fullImageFailed.value = false
    // Hydrating the same picture preserves its frame and geometry through decoding.
    const preserve = !changedRecord && (retrying.value || !imageFailed.value && ((preview && preview === previousPreview)
      || (src === previousSrc && imageReady.value)))
    if (preserve && !imageFailed.value) return
    imageRevision.value++
    displayedSrc.value = props.previewSrc || props.src
    imageAttempt.value = 0; imageReady.value = false; imageFailed.value = false
    if (!preserve) callbacks.reset()
  }, { flush:'sync' })
  return { imageEl, fullImageEl, displayedSrc, fullImageFailed, imageAttempt, fullAttempt, imageRevision, retrying, imageReady, imageFailed,
    requestSrc, onImageLoad, onImageError, upgradeImage, onFullImageError, retryImage }
}
