<template>
  <div
    ref="containerRef"
    class="border-beam-wrap"
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
    <div v-if="active" class="border-beam-track" aria-hidden="true">
      <div class="border-beam-ray" />
    </div>
    <div v-if="active && glow && !lowEffects" class="border-beam-bloom" aria-hidden="true">
      <div class="border-beam-ray" />
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
}>(), { active: true, duration: 3.6, borderWidth: 1.5, size: 'md', colorVariant: 'dual', glow: true, borderRadius: 'inherit' })

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
  const first = props.colorVariant === 'violet' ? violet : props.colorVariant === 'crystal' ? '#ffffff' : accent
  const second = props.colorVariant === 'dual' ? violet : first
  return `conic-gradient(from 0deg, transparent 0deg 50deg, color-mix(in srgb, ${first} 35%, transparent) 70deg, #ffffff 90deg, color-mix(in srgb, ${second} 75%, transparent) 110deg, transparent 130deg 360deg)`
})
const beamStyle = computed(() => ({
  '--beam-radius': props.borderRadius,
  '--beam-border-width': `${Number.isFinite(props.borderWidth) ? Math.max(0.5, Math.min(3, props.borderWidth)) : 1.5}px`,
  '--beam-duration': `${Number.isFinite(props.duration) ? Math.max(0.5, Math.min(20, props.duration)) : 3.6}s`,
  '--beam-extent': extent.value ? `${extent.value}px` : '150%',
  '--beam-gradient': gradient.value,
}))
</script>

<style scoped>
.border-beam-wrap { position: relative; border-radius: inherit; }
.border-beam-wrap.is-standalone {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}
.border-beam-track,
.border-beam-bloom {
  position: absolute;
  inset: 0;
  border-radius: var(--beam-radius, inherit);
  padding: var(--beam-border-width, 1.5px);
  pointer-events: none;
  overflow: hidden;
  box-sizing: border-box;
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
}
.border-beam-track { z-index: 2; opacity: 0.85; }
/* Bloom is edge-masked too, so it cannot wash across labels or artwork. */
.border-beam-bloom {
  inset: -1px;
  z-index: 1;
  opacity: 0.3;
  filter: blur(6px);
  mix-blend-mode: screen;
}
.size-sm .border-beam-bloom { filter: blur(3px); }
.size-lg .border-beam-bloom { opacity: 0.2; }
.border-beam-ray {
  position: absolute;
  top: 50%;
  left: 50%;
  width: var(--beam-extent);
  height: var(--beam-extent);
  background: var(--beam-gradient);
  transform: translate(-50%, -50%) rotate(45deg);
}
.is-running .border-beam-ray {
  animation: border-beam-spin var(--beam-duration, 3.6s) linear infinite;
  will-change: transform;
}
.is-low-effects .border-beam-track { opacity: 0.7; }
@keyframes border-beam-spin {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to { transform: translate(-50%, -50%) rotate(360deg); }
}
</style>
