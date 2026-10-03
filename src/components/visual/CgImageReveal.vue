<template>
  <div ref="containerRef" class="cg-image-reveal tw:relative tw:block tw:overflow-hidden tw:[border-radius:inherit] tw:bg-deep" :class="{ 'is-revealing': isRevealing, 'is-loaded': isLoaded }">
    <img
      v-if="resolvedSrc" :key="resolvedSrc" :crossorigin="runtimeResourceCors()" ref="imgRef"
      class="cg-image-target tw:block tw:w-full tw:h-full tw:object-contain" :class="[imgClass, { 'is-decoding': !isLoaded }]"
      :src="resolvedSrc" :alt="alt" loading="eager" decoding="async"
      @load="onImageLoad" @error="onImageError" @click="$emit('click', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { startImageDevelopmentReveal } from '@/utils/imageDevelopmentReveal'
import { useVisualActivity } from '@/composables/useVisualActivity'

const props = withDefaults(defineProps<{
  src: string
  alt?: string
  imgClass?: string
  duration?: number
  autoReveal?: boolean
}>(), { alt: '生成的画面成片', imgClass: '', duration: 600, autoReveal: true })
const emit = defineEmits<{
  load: [event: Event]
  error: [event: Event]
  click: [event: MouseEvent]
  'reveal-start': []
  'reveal-complete': []
}>()
const containerRef = ref<HTMLElement | null>(null)
const resolvedSrc = computed(() => resolveRuntimeUrl(props.src))
const imgRef = ref<HTMLImageElement | null>(null)
const { canAnimate, lowEffects } = useVisualActivity(containerRef)
const isRevealing = ref(false)
const isLoaded = ref(false)
let stopEffect: (() => void) | null = null
let revealSize = { width: 0, height: 0 }
let generation = 0
let handledImage: HTMLImageElement | null = null
let revealedImage: HTMLImageElement | null = null
let decodedImage: HTMLImageElement | null = null
let decodingImage: HTMLImageElement | null = null
let pendingDecode: Promise<boolean> | null = null
let sourceRevision = 0

function stopAnimation() {
  generation += 1
  stopEffect?.()
  stopEffect = null
  isRevealing.value = false
}
function finishReveal() {
  const wasRevealing = isRevealing.value
  stopAnimation()
  isLoaded.value = true
  if (wasRevealing) emit('reveal-complete')
}
function isCurrentImage(img: HTMLImageElement | null): img is HTMLImageElement {
  return Boolean(img && img === imgRef.value && img.getAttribute('src') === resolvedSrc.value)
}
function decodeImage(img: HTMLImageElement): Promise<boolean> {
  if (decodedImage === img) return Promise.resolve(true)
  if (decodingImage === img && pendingDecode) return pendingDecode
  const revision = sourceRevision
  decodingImage = img
  pendingDecode = (async () => {
    try { if (typeof img.decode === 'function') await img.decode() }
    catch {
      if (revision === sourceRevision && isCurrentImage(img)) isLoaded.value = true
      return false
    }
    if (revision !== sourceRevision || !isCurrentImage(img) || !img.complete || !img.naturalWidth) return false
    decodedImage = img
    isLoaded.value = true
    return true
  })()
  return pendingDecode
}
async function triggerReveal() {
  const img = imgRef.value
  if (!isCurrentImage(img) || !img.complete || !img.naturalWidth) return
  stopAnimation()
  const token = generation
  if (!await decodeImage(img) || token !== generation || !isCurrentImage(img)) return
  revealedImage = img
  if (!canAnimate.value || lowEffects.value || typeof img.animate !== 'function') {
    emit('reveal-complete')
    return
  }
  const duration = Number.isFinite(props.duration) ? Math.max(450, Math.min(700, props.duration)) : 600
  try {
    // Preparation precedes fading. Any failure leaves the decoded work available.
    const bounds = containerRef.value?.getBoundingClientRect()
    if (bounds) revealSize = { width: bounds.width, height: bounds.height }
    const effect = containerRef.value ? startImageDevelopmentReveal(img, containerRef.value, duration) : null
    if (!effect) { emit('reveal-complete'); return }
    stopEffect = effect.stop
    void effect.finished.then(() => {
      if (token === generation && isCurrentImage(img)) finishReveal()
    }).catch(() => { if (token === generation) finishReveal() })
    isRevealing.value = true
    emit('reveal-start')
  } catch {
    const started = isRevealing.value
    finishReveal()
    if (!started) emit('reveal-complete')
  }
}
function handleReadyImage() {
  const img = imgRef.value
  if (!isCurrentImage(img) || !img.complete || !img.naturalWidth || handledImage === img) return
  handledImage = img
  if (props.autoReveal) void triggerReveal()
  else void decodeImage(img)
}
function onImageLoad(event: Event) {
  if (event.target !== imgRef.value || !isCurrentImage(imgRef.value)) return
  emit('load', event)
  handleReadyImage()
}
function onImageError(event: Event) {
  if (event.target !== imgRef.value) return
  sourceRevision += 1
  stopAnimation()
  isLoaded.value = true
  emit('error', event)
}
watch(resolvedSrc, () => {
  sourceRevision += 1
  stopAnimation()
  isLoaded.value = false
  handledImage = null
  revealedImage = null
  decodedImage = null
  decodingImage = null
  pendingDecode = null
}, { flush: 'sync' })
watch(resolvedSrc, handleReadyImage, { flush: 'post' })
// A success callback can arrive just after a cached image's load event.
watch(() => props.autoReveal, enabled => {
  if (enabled && revealedImage !== imgRef.value) void triggerReveal()
})
watch([canAnimate, lowEffects], () => {
  if (isRevealing.value && (!canAnimate.value || lowEffects.value)) finishReveal()
}, { flush: 'sync' })
useResizeObserver(containerRef, () => {
  const bounds = containerRef.value?.getBoundingClientRect()
  if (isRevealing.value && bounds && (Math.abs(bounds.width - revealSize.width) > 1 || Math.abs(bounds.height - revealSize.height) > 1)) finishReveal()
})
onMounted(handleReadyImage)
onBeforeUnmount(() => { sourceRevision += 1; stopAnimation() })
defineExpose({ triggerReveal })
</script>
<style scoped>
.cg-image-target.is-decoding { visibility: hidden; }
</style>
