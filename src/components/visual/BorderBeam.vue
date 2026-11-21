<template>
  <div
    ref="containerRef"
    class="border-beam-wrap tw:relative tw:[border-radius:inherit]"
    :class="{
      'is-active': active,
      'is-running': running,
      'is-reduced': reducedMotion,
      'is-low-effects': lowEffects,
      'is-standalone': !hasSlotContent,
      [`variant-${colorVariant}`]: true,
      [`size-${size}`]: true,
    }"
    :data-reduced-motion="reducedMotion"
    :style="beamStyle"
  >
    <slot />
    <div v-if="active" class="border-beam-track tw:absolute tw:inset-0 tw:[border-radius:var(--beam-radius,inherit)] tw:[padding:var(--beam-border-width,1.5px)] tw:pointer-events-none tw:overflow-hidden tw:box-border tw:[z-index:2]" aria-hidden="true">
      <div class="border-beam-ray tw:absolute tw:top-1/2 tw:left-1/2 tw:w-[var(--beam-extent)] tw:h-[var(--beam-extent)] tw:[background:var(--beam-gradient)]" />
      <div v-if="colorVariant === 'dual' && !lowEffects && !reducedMotion" class="border-beam-ray border-beam-echo tw:absolute tw:top-1/2 tw:left-1/2 tw:w-[var(--beam-extent)] tw:h-[var(--beam-extent)] tw:[background:var(--beam-gradient)]" />
    </div>
    <div v-if="active && glow && !lowEffects && !reducedMotion" class="border-beam-bloom tw:absolute tw:[border-radius:var(--beam-radius,inherit)] tw:pointer-events-none tw:overflow-hidden tw:box-border tw:inset-[-1px] tw:[z-index:1]" aria-hidden="true">
      <div class="border-beam-ray border-beam-ray--soft tw:absolute tw:top-1/2 tw:left-1/2 tw:w-[var(--beam-extent)] tw:h-[var(--beam-extent)] tw:[background:var(--beam-bloom-gradient)]" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, useSlots } from 'vue'
import { useVisualActivity } from '@/composables/useVisualActivity'

const props = withDefaults(defineProps<{
  active?: boolean
  duration?: number
  borderWidth?: number
  size?: 'sm' | 'md' | 'lg'
  colorVariant?: 'dual' | 'accent' | 'violet' | 'crystal'
  glow?: boolean
  borderRadius?: string
}>(), { active: true, duration: 4.2, borderWidth: 1.2, size: 'md', colorVariant: 'dual', glow: true, borderRadius: 'inherit' })

const slots = useSlots()
const hasSlotContent = computed(() => Boolean(slots.default))
const containerRef = ref<HTMLElement | null>(null)
const extent = ref(0)
const deactivated = ref(false)
const { canAnimate, reducedMotion, lowEffects } = useVisualActivity(containerRef)
const running = computed(() => props.active && canAnimate.value && !deactivated.value && !reducedMotion.value)
let observer: ResizeObserver | null = null

function measure(entries: ResizeObserverEntry[]): void {
  if (deactivated.value) return
  const box = entries[0]?.borderBoxSize[0]
  // A diagonal-sized square covers the host at every angle; no 4x-width/height texture.
  // Use delivered layout size so parent entrance transforms cannot inflate it.
  if (box) extent.value = Math.ceil(Math.hypot(box.inlineSize + 4, box.blockSize + 4))
}

function startObserving(): void {
  if (deactivated.value || !containerRef.value || typeof ResizeObserver === 'undefined') return
  observer?.disconnect()
  observer = new ResizeObserver(measure)
  observer.observe(containerRef.value, { box: 'border-box' })
}

function stopObserving(): void {
  observer?.disconnect()
  observer = null
}

onMounted(startObserving)
onActivated(() => {
  deactivated.value = false
  startObserving()
})
onDeactivated(() => {
  deactivated.value = true
  stopObserving()
})
onBeforeUnmount(() => {
  deactivated.value = true
  stopObserving()
})

const palette = computed(() => {
  const accent = 'var(--accent, #F2A8BE)'
  const violet = 'var(--accent-violet, #B784F6)'
  const first = props.colorVariant === 'violet' ? violet : props.colorVariant === 'crystal' ? 'var(--text-primary)' : accent
  const second = props.colorVariant === 'dual' ? violet : first
  return { first, second }
})

const gradient = computed(() => {
  const { first, second } = palette.value
  return `conic-gradient(from 0deg, transparent 0deg 62deg, color-mix(in srgb, ${first} 8%, transparent) 69deg, color-mix(in srgb, ${first} 28%, transparent) 78deg, ${first} 87deg, var(--text-primary) 89deg, ${second} 91deg, color-mix(in srgb, ${second} 24%, transparent) 95deg, transparent 102deg 360deg)`
})

// Soft feathered conic arc replaces expensive filter: blur(4px) so bloom stays compositor-only.
const bloomGradient = computed(() => {
  const { first, second } = palette.value
  return `conic-gradient(from 0deg, transparent 0deg 46deg, color-mix(in srgb, ${first} 10%, transparent) 62deg, color-mix(in srgb, ${first} 28%, transparent) 80deg, color-mix(in srgb, ${second} 30%, transparent) 92deg, color-mix(in srgb, ${second} 10%, transparent) 108deg, transparent 126deg 360deg)`
})

const beamStyle = computed(() => {
  const width = Number.isFinite(props.borderWidth) ? Math.max(0.5, Math.min(3, props.borderWidth)) : 1.2
  const duration = Number.isFinite(props.duration) ? Math.max(0.5, Math.min(20, props.duration)) : 4.2
  return {
    '--beam-radius': props.borderRadius,
    '--beam-border-width': `${width}px`,
    '--beam-bloom-width': `${width + 1.5}px`,
    '--beam-duration': `${duration}s`,
    '--beam-echo-delay': `${-duration / 2}s`,
    '--beam-extent': extent.value ? `${extent.value}px` : '150%',
    '--beam-gradient': gradient.value,
    '--beam-bloom-gradient': bloomGradient.value,
  }
})
</script>

<style scoped>
.border-beam-wrap.is-standalone {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}
.border-beam-track,
.border-beam-bloom {
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
}
.border-beam-track { opacity: 0.92; }
/* Feathered soft halo ring stays strictly on transform/opacity without blur() or permanent will-change. */
.border-beam-bloom {
  padding: var(--beam-bloom-width, 2.7px);
  opacity: 0.24;
}
.size-sm .border-beam-bloom { opacity: 0.2; }
.size-lg .border-beam-bloom { opacity: 0.22; }
.border-beam-ray {
  transform: translate(-50%, -50%) rotate(45deg);
}
.border-beam-echo { opacity: 0.34; }
.is-running .border-beam-ray {
  animation: border-beam-spin var(--beam-duration, 3.6s) linear infinite;
}
.is-running .border-beam-bloom {
  animation: border-beam-breathe calc(var(--beam-duration, 3.6s) * 0.65) var(--ease-in-out, ease-in-out) infinite;
}
.is-running .border-beam-echo { animation-delay: var(--beam-echo-delay); }
.is-low-effects .border-beam-track { opacity: 0.7; }
.is-reduced .border-beam-track { opacity: 0.5; }
.is-reduced .border-beam-ray { animation: none; }
@keyframes border-beam-spin {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to { transform: translate(-50%, -50%) rotate(360deg); }
}
@keyframes border-beam-breathe {
  0%, 100% { opacity: 0.14; }
  50% { opacity: 0.34; }
}
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion='full']) .border-beam-ray,
  :root:not([data-motion='full']) .border-beam-bloom { animation: none; }
  :root:not([data-motion='full']) .border-beam-bloom { opacity: 0.16; }
}
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .border-beam-ray,
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .border-beam-bloom { animation: none; }
:root:is([data-motion='reduce'], [data-motion='reduced'], [data-reduced-motion='true']) .border-beam-bloom { opacity: 0.16; }
</style>
