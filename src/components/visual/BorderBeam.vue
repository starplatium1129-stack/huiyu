<template>
  <div
    ref="containerRef"
    class="border-beam-wrap tw:relative tw:[border-radius:inherit]"
    :class="{
      'is-active': active,
      'is-running': active && canAnimate,
      'is-low-effects': lowEffects,
      'is-standalone': !hasSlotContent,
      [`variant-${colorVariant}`]: true,
      [`size-${size}`]: true,
    }"
    :style="beamStyle"
  >
    <slot />
    <div v-if="active" class="border-beam-track tw:absolute tw:inset-0 tw:[border-radius:var(--beam-radius,inherit)] tw:[padding:var(--beam-border-width,1.5px)] tw:pointer-events-none tw:overflow-hidden tw:box-border tw:[z-index:2]" aria-hidden="true">
      <div class="border-beam-ray tw:absolute tw:top-1/2 tw:left-1/2 tw:w-[var(--beam-extent)] tw:h-[var(--beam-extent)] tw:[background:var(--beam-gradient)]" />
      <div v-if="colorVariant === 'dual' && !lowEffects" class="border-beam-ray border-beam-echo tw:absolute tw:top-1/2 tw:left-1/2 tw:w-[var(--beam-extent)] tw:h-[var(--beam-extent)] tw:[background:var(--beam-gradient)]" />
    </div>
    <div v-if="active && glow && !lowEffects" class="border-beam-bloom tw:absolute tw:[border-radius:var(--beam-radius,inherit)] tw:[padding:var(--beam-border-width,1.5px)] tw:pointer-events-none tw:overflow-hidden tw:box-border tw:inset-[-1px] tw:[z-index:1] tw:[mix-blend-mode:screen]" aria-hidden="true">
      <div class="border-beam-ray tw:absolute tw:top-1/2 tw:left-1/2 tw:w-[var(--beam-extent)] tw:h-[var(--beam-extent)] tw:[background:var(--beam-gradient)]" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, useSlots } from 'vue'
import { useResizeObserver } from '@vueuse/core'
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
const { canAnimate, lowEffects } = useVisualActivity(containerRef)

function measure(): void {
  const rect = containerRef.value?.getBoundingClientRect()
  // A diagonal-sized square covers the host at every angle; no 4x-width/height texture.
  if (rect) extent.value = Math.ceil(Math.hypot(rect.width + 4, rect.height + 4))
}
useResizeObserver(containerRef, measure)
onMounted(measure)

const gradient = computed(() => {
  const accent = 'var(--accent, #F2A8BE)'
  const violet = 'var(--accent-violet, #B784F6)'
  const first = props.colorVariant === 'violet' ? violet : props.colorVariant === 'crystal' ? 'var(--text-primary)' : accent
  const second = props.colorVariant === 'dual' ? violet : first
  return `conic-gradient(from 0deg, transparent 0deg 62deg, color-mix(in srgb, ${first} 8%, transparent) 69deg, color-mix(in srgb, ${first} 28%, transparent) 78deg, ${first} 87deg, var(--text-primary) 89deg, ${second} 91deg, color-mix(in srgb, ${second} 24%, transparent) 95deg, transparent 102deg 360deg)`
})
const beamStyle = computed(() => ({
  '--beam-radius': props.borderRadius,
  '--beam-border-width': `${Number.isFinite(props.borderWidth) ? Math.max(0.5, Math.min(3, props.borderWidth)) : 1.2}px`,
  '--beam-duration': `${Number.isFinite(props.duration) ? Math.max(0.5, Math.min(20, props.duration)) : 4.2}s`,
  '--beam-echo-delay': `${-(Number.isFinite(props.duration) ? Math.max(0.5, Math.min(20, props.duration)) : 4.2) / 2}s`,
  '--beam-extent': extent.value ? `${extent.value}px` : '150%',
  '--beam-gradient': gradient.value,
}))
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
/* Bloom is edge-masked too, so it cannot wash across labels or artwork. */
.border-beam-bloom {
  opacity: 0.22;
  filter: blur(4px);
}
.size-sm .border-beam-bloom { filter: blur(3px); }
.size-lg .border-beam-bloom { opacity: 0.2; }
.border-beam-ray {
  transform: translate(-50%, -50%) rotate(45deg);
}
.border-beam-echo { opacity:0.34; }
.is-running .border-beam-ray {
  animation: border-beam-spin var(--beam-duration, 3.6s) linear infinite;
  will-change: transform;
}
.is-low-effects .border-beam-track { opacity: 0.7; }
.is-running .border-beam-echo { animation-delay:var(--beam-echo-delay); }
@keyframes border-beam-spin {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to { transform: translate(-50%, -50%) rotate(360deg); }
}
</style>
