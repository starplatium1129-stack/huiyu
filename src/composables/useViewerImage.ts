import { onBeforeUnmount, ref, watch } from 'vue'
import { resolveRuntimeUrl, runtimeResourceIdentity } from '@/platform/runtimeUrl'

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
  function currentImage(image: EventTarget | null, full = false): image is HTMLImageElement {
    return image instanceof HTMLImageElement && image === (full ? fullImageEl.value : imageEl.value)
      && image.dataset.imageAttempt === String(full ? fullAttempt.value : imageAttempt.value)
      && image.getAttribute('src') === requestSrc(full ? props.src : displayedSrc.value, full ? fullAttempt.value : imageAttempt.value)
  }
  async function onImageLoad(event: Event) {
    const image = event.target, revision = sourceRevision
    if (!currentImage(image)) return
    try { await image.decode() }
    catch { if (revision === sourceRevision) failImage(image); return }
    if (revision !== sourceRevision || !currentImage(image)) return
    imageReady.value = true; imageFailed.value = false
    if (displayedSrc.value === props.src) { fullImageFailed.value = false; retrying.value = false }
    callbacks.loaded()
  }
  function onImageError(event: Event) { failImage(event.target) }
  function failImage(image: EventTarget | null) {
    if (!currentImage(image)) return
    if (displayedSrc.value !== props.src) { imageReady.value = false; displayedSrc.value = props.src; return }
    imageReady.value = false; imageFailed.value = true; retrying.value = false
    callbacks.error()
  }
  function failFullImage() { fullImageFailed.value = true; retrying.value = false; callbacks.error() }
  function onFullImageError(event: Event) {
    if (currentImage(event.target, true)) failFullImage()
  }
  async function upgradeImage(event: Event) {
    const image = event.target, revision = sourceRevision
    if (!currentImage(image, true)) return
    const source = image.getAttribute('src'), identity = runtimeResourceIdentity(), attempt = fullAttempt.value
    const current = () => revision === sourceRevision && identity === runtimeResourceIdentity() && attempt === fullAttempt.value
      && image.getAttribute('src') === source && currentImage(image, true)
    try { if (typeof image.decode === 'function') await image.decode() }
    catch { if (current()) failFullImage(); return }
    // Native event targets may be cleared after dispatch; retain the decoded node.
    if (current() && image.complete && image.naturalWidth && image.naturalHeight) {
      if (imageAttempt.value !== fullAttempt.value) imageRevision.value++
      imageAttempt.value = fullAttempt.value; displayedSrc.value = props.src
    }
  }
  async function retryImage() {
    if (retrying.value) return
    const revision = ++retryRevision, source = props.src, preview = props.previewSrc, imageSourceRevision = sourceRevision
    retrying.value = true
    // Recovery disappears after success; leave focus on the picture without scrolling.
    callbacks.focus()
    try { await props.reload?.() }
    catch { if (revision === retryRevision && imageSourceRevision === sourceRevision) { retrying.value = false; callbacks.error() }; return }
    if (revision !== retryRevision || imageSourceRevision !== sourceRevision) return
    if (props.loadFailed || !props.src) { retrying.value = false; return }
    // A repository refresh can replace the source; its decode owns completion.
    if (props.src !== source || props.previewSrc !== preview) return
    fullAttempt.value = Date.now(); fullImageFailed.value = false
    if (imageFailed.value) { imageRevision.value++; imageAttempt.value = fullAttempt.value; imageReady.value = false; imageFailed.value = false }
  }
  watch([() => props.src, () => props.previewSrc, () => props.imageKey,
    () => resolveRuntimeUrl(props.src), () => resolveRuntimeUrl(props.previewSrc), runtimeResourceIdentity],
  ([src, preview, key, resolved, resolvedPreview, identity], [previousSrc, previousPreview, previousKey, previousResolved, previousResolvedPreview, previousIdentity]) => {
    const changedOwner = key !== previousKey || identity !== previousIdentity
    const changedSource = src !== previousSrc || resolved !== previousResolved || changedOwner
    // Snapshot an already painted alias before its actual request changes in place.
    const paintedRequest = imageEl.value?.src
    const retainedPainted = !changedOwner && src === previousSrc && resolved !== previousResolved
      && displayedSrc.value === src && imageReady.value && !!paintedRequest
    if (retainedPainted) displayedSrc.value = paintedRequest!
    // Entrance previews can change while the same original is decoding.
    // Actual requests and runtime owners also invalidate a decode of the same raw path.
    if (changedSource) sourceRevision++
    if (changedOwner) { retryRevision++; retrying.value = false }
    if (changedSource) fullAttempt.value = src === previousSrc ? fullAttempt.value + 1 : 0
    fullImageFailed.value = false
    // Hydrating the same picture preserves its frame and geometry through decoding.
    const preserve = !changedOwner && (retainedPainted || retrying.value || !imageFailed.value && ((preview && preview === previousPreview && resolvedPreview === previousResolvedPreview)
      || (imageReady.value && (key !== undefined || !changedSource))))
    if (preserve && !imageFailed.value) return
    imageRevision.value++
    displayedSrc.value = props.previewSrc || props.src
    imageAttempt.value = 0; imageReady.value = false; imageFailed.value = false
    if (!preserve) callbacks.reset()
  }, { flush:'sync' })
  return { imageEl, fullImageEl, displayedSrc, fullImageFailed, imageAttempt, fullAttempt, imageRevision, retrying, imageReady, imageFailed,
    requestSrc, onImageLoad, onImageError, upgradeImage, onFullImageError, retryImage }
}
