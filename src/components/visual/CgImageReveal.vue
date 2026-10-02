<template>
  <div ref="containerRef" class="cg-image-reveal tw:relative tw:block tw:overflow-hidden tw:[border-radius:inherit] tw:bg-deep" :class="{ 'is-revealing': isRevealing, 'is-loaded': isLoaded }">
    <img
      v-if="resolvedSrc" :key="resolvedSrc" :crossorigin="runtimeResourceCors()" ref="imgRef"
      class="cg-image-target tw:block tw:w-full tw:h-full tw:object-contain" :class="imgClass"
      :src="resolvedSrc" :alt="alt" loading="eager" decoding="async"
      @load="onImageLoad" @error="onImageError" @click="$emit('click', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { startCanvasParticleReveal } from '@/utils/canvasParticleReveal'
import { useVisualActivity } from '@/composables/useVisualActivity'

const props = withDefaults(defineProps<{
  src: string
  alt?: string
  imgClass?: string
  duration?: number
  autoReveal?: boolean
}>(), { alt: '生成的画面成片', imgClass: '', duration: 960, autoReveal: true })
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
let stopParticles: (() => void) | null = null
let revealSize = { width: 0, height: 0 }
let generation = 0
let handledImage: HTMLImageElement | null = null
let revealedImage: HTMLImageElement | null = null

function stopAnimation() {
  generation += 1
  stopParticles?.()
  stopParticles = null
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
function triggerReveal() {
  const img = imgRef.value
  if (!isCurrentImage(img) || !img.complete || !img.naturalWidth) return
  stopAnimation()
  isLoaded.value = true
  revealedImage = img
  if (!canAnimate.value || lowEffects.value || typeof img.animate !== 'function') {
    emit('reveal-complete')
    return
  }
  const duration = Number.isFinite(props.duration) ? Math.max(240, Math.min(1200, props.duration)) : 960
  const token = generation
  try {
    // Prepare the particle field before fading the original. Any failure leaves
    // the decoded full-resolution image immediately available.
    const bounds = containerRef.value?.getBoundingClientRect()
    if (bounds) revealSize = { width: bounds.width, height: bounds.height }
    const particles = containerRef.value ? startCanvasParticleReveal(img, containerRef.value, duration) : null
    if (!particles) { emit('reveal-complete'); return }
    stopParticles = particles.stop
    void particles.finished.then(() => {
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
  isLoaded.value = true
  if (props.autoReveal) triggerReveal()
}
function onImageLoad(event: Event) {
  if (event.target !== imgRef.value || !isCurrentImage(imgRef.value)) return
  emit('load', event)
  handleReadyImage()
}
function onImageError(event: Event) {
  if (event.target !== imgRef.value) return
  stopAnimation()
  isLoaded.value = true
  emit('error', event)
}
watch(resolvedSrc, () => {
  stopAnimation()
  isLoaded.value = false
  handledImage = null
  revealedImage = null
}, { flush: 'sync' })
watch(resolvedSrc, handleReadyImage, { flush: 'post' })
// A success callback can arrive just after a cached image's load event.
watch(() => props.autoReveal, enabled => {
  if (enabled && revealedImage !== imgRef.value) triggerReveal()
})
watch([canAnimate, lowEffects], () => {
  if (isRevealing.value && (!canAnimate.value || lowEffects.value)) finishReveal()
}, { flush: 'sync' })
useResizeObserver(containerRef, () => {
  const bounds = containerRef.value?.getBoundingClientRect()
  if (isRevealing.value && bounds && (Math.abs(bounds.width - revealSize.width) > 1 || Math.abs(bounds.height - revealSize.height) > 1)) finishReveal()
})
onMounted(handleReadyImage)
onBeforeUnmount(stopAnimation)
defineExpose({ triggerReveal })
</script>
