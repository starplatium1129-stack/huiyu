<template>
  <div ref="frame" class="cg-image-reveal tw:relative tw:block tw:overflow-hidden tw:[border-radius:inherit] tw:bg-deep"
    :class="{ 'is-revealing': revealing, 'is-loaded': ready }">
    <img v-if="url" :key="url" ref="image" class="cg-image-target result-image" :class="{ 'is-decoding': !ready }"
      :src="url" :crossorigin="runtimeResourceCors()" :alt="alt" decoding="async" @load="decode" @error="imageFailed" />
    <span v-if="sheening" class="cg-cel-sheen" aria-hidden="true">
      <i class="cg-cel-sheen-beam" @animationend="clearSheen" @animationcancel="clearSheen" />
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue'
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
const sheening = ref(false)
const { canAnimate, reducedMotion, lowEffects } = useVisualActivity(frame)
let pending: HTMLImageElement | null = null
let presented: HTMLImageElement | null = null
let effect: CanvasParticleReveal | null = null
let deactivated = false
let deferredReveal = false
let sheenTimer: ReturnType<typeof setTimeout> | undefined

function clearSheen() {
  if (sheenTimer !== undefined) {
    clearTimeout(sheenTimer)
    sheenTimer = undefined
  }
  sheening.value = false
}

function playCelSheen() {
  if (deactivated || reducedMotion.value || lowEffects.value || !canAnimate.value) return
  clearSheen()
  sheening.value = true
  // Guard against suppressed CSS animations where animationend never fires.
  sheenTimer = setTimeout(clearSheen, 500)
}

function stop() {
  const current = effect
  effect = null
  revealing.value = false
  current?.stop()
}

function finish(withSheen = false) {
  stop()
  emit('reveal-complete')
  if (withSheen) playCelSheen()
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
  deferredReveal = false
  clearSheen()
  stop()
  emit('error')
}

function reveal() {
  const img = ready.value
  if (!img || !props.autoReveal || presented === img) {
    if (!props.autoReveal) deferredReveal = false
    return
  }
  if (reducedMotion.value) {
    deferredReveal = false
    presented = img
    finish(false)
    return
  }
  // If a fresh image finishes while KeepAlive-deactivated or hidden, hold the
  // reveal until the user returns rather than swallowing the first presentation.
  if (deactivated || !canAnimate.value) {
    deferredReveal = true
    return
  }
  deferredReveal = false
  presented = img
  let next = lowEffects.value ? null : props.revealEffect(img, props.duration)
  if (!next) {
    const fade = img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: props.duration / 3, easing: 'ease-out' })
    next = { stop: () => fade.cancel(), finished: fade.finished.then(() => {}) }
  }
  effect = next
  revealing.value = true
  emit('reveal-start')
  const settle = (completed: boolean) => { if (effect === next) finish(completed) }
  void next.finished.then(() => settle(true), () => settle(false))
}

watch(url, () => {
  stop()
  clearSheen()
  deferredReveal = false
  ready.value = pending = presented = null
}, { flush: 'sync' })
watch([ready, () => props.autoReveal], reveal, { flush: 'post' })
watch([canAnimate, lowEffects, reducedMotion], () => {
  if (effect && (!canAnimate.value || lowEffects.value)) finish(false)
  if (sheening.value && (reducedMotion.value || lowEffects.value || !canAnimate.value)) clearSheen()
  if (!deactivated && deferredReveal && (canAnimate.value || reducedMotion.value)) reveal()
})
useResizeObserver(frame, () => {
  if (!deactivated) effect?.resize?.()
})
onMounted(decode)
onActivated(() => {
  deactivated = false
  void nextTick(() => {
    if (!deactivated && (deferredReveal || (ready.value && props.autoReveal && presented !== ready.value))) {
      reveal()
    }
  })
})
onDeactivated(() => {
  deactivated = true
  clearSheen()
  if (effect) finish(false)
})
onBeforeUnmount(() => {
  deactivated = true
  deferredReveal = false
  pending = null
  clearSheen()
  stop()
})
</script>

<style scoped>
.cg-image-target.is-decoding { visibility: hidden; }
.cg-cel-sheen {
  position: absolute;
  inset: 0;
  z-index: var(--z-raised, 3);
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}
.cg-cel-sheen-beam {
  position: absolute;
  inset: -24% -36%;
  display: block;
  background: linear-gradient(
    112deg,
    transparent 36%,
    color-mix(in srgb, var(--on-art-sheen) 44%, transparent) 46%,
    var(--on-art-sheen) 50%,
    color-mix(in srgb, var(--character-accent, var(--accent)) 22%, var(--on-art-sheen)) 54%,
    transparent 64%
  );
  opacity: 0;
  transform: translate3d(-96%, 0, 0);
  animation: cg-cel-sheen-sweep 420ms var(--ease-out) both;
}
@keyframes cg-cel-sheen-sweep {
  0%   { opacity: 0; transform: translate3d(-96%, 0, 0); }
  22%  { opacity: 0.78; }
  74%  { opacity: 0.52; }
  100% { opacity: 0; transform: translate3d(96%, 0, 0); }
}
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion='full']) .cg-cel-sheen-beam { animation: none; opacity: 0; }
}
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .cg-cel-sheen-beam {
  animation: none;
  opacity: 0;
}
</style>
