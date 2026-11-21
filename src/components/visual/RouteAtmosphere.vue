<template>
  <div class="route-atmosphere tw:fixed tw:inset-x-0 tw:top-0 tw:[z-index:var(--z-below)] tw:pointer-events-none tw:[contain:strict]" aria-hidden="true">
    <div
      v-for="(slot, index) in slots"
      :key="index"
      class="atmosphere-layer"
      :class="{ 'is-active': activeSlot === index }"
      :style="slot.style"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watch, type CSSProperties } from 'vue'
import { useRoute } from 'vue-router'

interface AuraSnapshot {
  key: string
  style: CSSProperties
}

const route = useRoute()

function readAtmosphere(): AuraSnapshot {
  if (typeof document === 'undefined') {
    return {
      key: 'default',
      style: {
        '--layer-aura': 'var(--accent-glow)',
        '--layer-aura-secondary': 'var(--archive-blue-soft)',
      } as CSSProperties,
    }
  }
  const rootStyle = document.documentElement.style
  const accent = rootStyle.getPropertyValue('--active-character-accent').trim()
    || rootStyle.getPropertyValue('--character-accent').trim()
  const primary = rootStyle.getPropertyValue('--character-aura').trim()
    || (accent ? `color-mix(in srgb, ${accent} 24%, transparent)` : 'var(--accent-glow)')
  const secondary = rootStyle.getPropertyValue('--character-aura-secondary').trim()
    || (accent ? `color-mix(in srgb, ${accent} 14%, transparent)` : 'var(--archive-blue-soft)')
  return {
    key: `${primary}|${secondary}`,
    style: {
      '--layer-aura': primary,
      '--layer-aura-secondary': secondary,
    } as CSSProperties,
  }
}

const initial = readAtmosphere()
const slots = reactive<[AuraSnapshot, AuraSnapshot]>([
  { ...initial },
  { ...initial },
])
const activeSlot = ref<0 | 1>(0)
let currentKey = initial.key
let pendingFrame = 0
let observer: MutationObserver | undefined

function crossfadeIfChanged() {
  const next = readAtmosphere()
  if (next.key === currentKey) return
  currentKey = next.key
  const target: 0 | 1 = activeSlot.value === 0 ? 1 : 0
  slots[target] = next
  if (pendingFrame) cancelAnimationFrame(pendingFrame)
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0
    activeSlot.value = target
  })
}

watch(() => route.path, () => {
  crossfadeIfChanged()
})

onMounted(() => {
  crossfadeIfChanged()
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(crossfadeIfChanged)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  }
})

onUnmounted(() => {
  observer?.disconnect()
  observer = undefined
  if (pendingFrame) {
    cancelAnimationFrame(pendingFrame)
    pendingFrame = 0
  }
})
</script>

<style scoped>
/* Dual-layer static painted atmosphere: each buffer freezes its character aura
   snapshot and crossfades via compositor-safe opacity only (no gradient
   animation, no blur, no retired starfield, no permanent will-change). */
.route-atmosphere {
  height: min(72vh, 52rem);
}
.atmosphere-layer {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 480ms var(--ease-out);
  background:
    radial-gradient(ellipse min(48vw, 46rem) min(38vh, 30rem) at 6% 0%, color-mix(in srgb, var(--layer-aura, var(--accent-glow)) 36%, transparent), transparent 74%),
    radial-gradient(ellipse min(38vw, 34rem) min(34vh, 26rem) at 96% 6%, color-mix(in srgb, var(--layer-aura-secondary, var(--archive-blue-soft)) 26%, transparent), transparent 74%),
    radial-gradient(ellipse min(64vw, 56rem) min(22vh, 16rem) at 50% -4%, color-mix(in srgb, var(--glass-highlight) 85%, transparent), transparent 70%);
}
.atmosphere-layer.is-active {
  opacity: 1;
}
:global(:root[data-theme="light"]) .atmosphere-layer {
  background:
    radial-gradient(ellipse min(48vw, 46rem) min(38vh, 30rem) at 6% 0%, color-mix(in srgb, var(--layer-aura, var(--accent-glow)) 24%, transparent), transparent 74%),
    radial-gradient(ellipse min(38vw, 34rem) min(34vh, 26rem) at 96% 6%, color-mix(in srgb, var(--layer-aura-secondary, var(--archive-blue-soft)) 18%, transparent), transparent 74%),
    radial-gradient(ellipse min(64vw, 56rem) min(22vh, 16rem) at 50% -4%, color-mix(in srgb, var(--bg-surface) 70%, transparent), transparent 72%);
}
@media (prefers-reduced-motion: reduce) {
  :global(:root:not([data-motion="full"])) .atmosphere-layer { transition-duration: 120ms; }
}
:global(:root:is([data-motion="reduce"], [data-motion="reduced"], [data-reduced-motion="true"])) .atmosphere-layer {
  transition-duration: 120ms;
}
@media (prefers-reduced-transparency: reduce), (forced-colors: active) {
  .route-atmosphere { display: none; }
}
:global(:root:is([data-theme-style="terraria"], [data-fluid-effects="low"], [data-reduced-glass="true"]) .route-atmosphere) {
  display: none;
}
</style>
