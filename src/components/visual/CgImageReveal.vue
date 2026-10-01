<template>
  <div ref="containerRef" class="cg-image-reveal tw:relative tw:block tw:overflow-hidden tw:[border-radius:inherit] tw:bg-deep" :class="{ 'is-revealing': isRevealing, 'is-loaded': isLoaded }">
    <img
      v-if="resolvedSrc" :key="resolvedSrc" :crossorigin="runtimeResourceCors()" ref="imgRef"
      class="cg-image-target tw:block tw:w-full tw:h-full tw:object-contain" :class="imgClass"
      :src="resolvedSrc" :alt="alt" loading="eager" decoding="async"
      @load="onImageLoad" @error="onImageError" @click="$emit('click', $event)"
    />
    <div v-show="isRevealing" ref="glowRef" class="cg-reveal-glow tw:absolute tw:inset-0 tw:pointer-events-none" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useVisualActivity } from '@/composables/useVisualActivity'

const props = withDefaults(defineProps<{
  src: string
  alt?: string
  imgClass?: string
  duration?: number
  autoReveal?: boolean
}>(), { alt: '生成的画面成片', imgClass: '', duration: 620, autoReveal: true })
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
const glowRef = ref<HTMLElement | null>(null)
const { canAnimate, lowEffects } = useVisualActivity(containerRef)
const isRevealing = ref(false)
const isLoaded = ref(false)
let animations: Animation[] = []
let generation = 0
let handledImage: HTMLImageElement | null = null
let revealedImage: HTMLImageElement | null = null

function stopAnimation() {
  generation += 1
  animations.splice(0).forEach(animation => animation.cancel())
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
  const duration = Number.isFinite(props.duration) ? Math.max(160, Math.min(1000, props.duration)) : 620
  const token = generation
  try {
    // No pixel readback or animated blur: the decoded full-resolution artwork remains sharp.
    const reveal = img.animate([
      { opacity: 0.28, transform: 'scale(1.008)' },
      { opacity: 1, transform: 'scale(1)' },
    ], { duration, easing: 'cubic-bezier(.2,.65,.3,1)' })
    animations.push(reveal)
    void reveal.finished.then(() => {
      if (token === generation && isCurrentImage(img)) finishReveal()
    }).catch(() => { if (token === generation) finishReveal() })
    if (glowRef.value) {
      const glow = glowRef.value.animate([
        { opacity: 0.16, transform: 'scale(.98)' },
        { opacity: 0, transform: 'scale(1.025)' },
      ], { duration: duration * 0.85, easing: 'ease-out', fill: 'both' })
      animations.push(glow)
      void glow.finished.catch(() => {})
    }
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
onMounted(handleReadyImage)
onBeforeUnmount(stopAnimation)
defineExpose({ triggerReveal })
</script>

<style scoped>
.cg-reveal-glow {
  opacity: 0;
  background: radial-gradient(ellipse at 48% 42%, var(--glass-specular), transparent 72%);
}
</style>
