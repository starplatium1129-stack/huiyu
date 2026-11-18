<template>
  <div ref="frame" class="cg-image-reveal tw:relative tw:block tw:overflow-hidden tw:[border-radius:inherit] tw:bg-deep"
    :class="{ 'is-revealing': revealing, 'is-loaded': ready }">
    <img v-if="url" :key="url" ref="image" class="cg-image-target result-image" :class="{ 'is-decoding': !ready }"
      :src="url" :crossorigin="runtimeResourceCors()" :alt="alt" decoding="async" @load="decode" @error="imageFailed" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import { useVisualActivity } from '@/composables/useVisualActivity'
import type { CanvasParticleReveal } from '@/utils/canvasTextureParticles'

const props = defineProps<{
  src: string
  alt: string
  autoReveal: boolean
  duration: number
  revealEffect: (image: HTMLImageElement, duration: number) => CanvasParticleReveal | null
}>()
const emit = defineEmits<{ load: [image: HTMLImageElement]; error: []; 'reveal-start': []; 'reveal-complete': [] }>()
const url = computed(() => resolveRuntimeUrl(props.src))
const frame = shallowRef<HTMLElement | null>(null), image = shallowRef<HTMLImageElement | null>(null)
const ready = shallowRef<HTMLImageElement | null>(null)
const revealing = ref(false)
const { canAnimate, lowEffects } = useVisualActivity(frame)
let pending: HTMLImageElement | null = null
let presented: HTMLImageElement | null = null
let effect: CanvasParticleReveal | null = null

function stop() {
  const current = effect
  effect = null
  revealing.value = false
  current?.stop()
}
function finish() {
  stop()
  emit('reveal-complete')
}
async function decode() {
  const img = image.value
  if (!img?.complete || !img.naturalWidth || pending === img) return
  pending = img
  try { await img.decode() } catch {
    if (pending === img && image.value === img && !img.naturalWidth) imageFailed()
  }
  if (pending !== img || image.value !== img) return
  ready.value = img
  emit('load', img)
}
function imageFailed(event?: Event) {
  if (event && event.target !== image.value) return
  pending = null
  ready.value = null
  stop()
  emit('error')
}
function reveal() {
  const img = ready.value
  if (!img || !props.autoReveal || presented === img) return
  presented = img
  if (!canAnimate.value) { finish(); return }
  let next = lowEffects.value ? null : props.revealEffect(img, props.duration)
  if (!next) {
    const fade = img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: props.duration / 3, easing: 'ease-out' })
    next = { stop: () => fade.cancel(), finished: fade.finished.then(() => {}) }
  }
  effect = next
  revealing.value = true
  emit('reveal-start')
  const settle = () => { if (effect === next) finish() }
  void next.finished.then(settle, settle)
}
watch(url, () => { stop(); ready.value = pending = presented = null }, { flush: 'sync' })
watch([ready, () => props.autoReveal], reveal, { flush: 'post' })
watch([canAnimate, lowEffects], () => {
  if (effect && (!canAnimate.value || lowEffects.value)) finish()
})
useResizeObserver(frame, () => effect?.resize?.())
onMounted(decode)
onBeforeUnmount(() => { pending = null; stop() })
</script>
<style scoped>
.cg-image-target.is-decoding { visibility:hidden; }
</style>
