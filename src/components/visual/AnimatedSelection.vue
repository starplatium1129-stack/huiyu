<template><span ref="indicator" class="animated-selection" aria-hidden="true"></span></template>
<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { createFluidMotion } from '@/utils/fluidSpring'
const props = withDefaults(defineProps<{ target?: string }>(), { target: '[aria-pressed="true"]' })
const indicator = ref<HTMLElement | null>(null)
let resize: ResizeObserver | undefined
let mutations: MutationObserver | undefined
let fluid: ReturnType<typeof createFluidMotion> | undefined
let baseWidth = 1, baseHeight = 1
let frame = 0
let media: MediaQueryList | undefined
let removeMediaListener: (() => void) | undefined
let initialized = false
let parent: HTMLElement | null = null
let observedTarget: HTMLElement | null = null
let destinationBox = ''
function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
function onVisibilityChange() {
  if (typeof document !== 'undefined' && document.hidden) {
    cancelAnimationFrame(frame)
    frame = 0
    fluid?.dispose()
    fluid = undefined
  } else {
    schedule()
  }
}
function update() {
  const el = indicator.value
  const targetSelector = props.target
  const selected = parent?.querySelector<HTMLElement>(targetSelector)
    ?? (targetSelector.includes(':scope >') ? parent?.querySelector<HTMLElement>(targetSelector.replace(':scope >', ':scope ')) : null)
  if (!el || !parent || (typeof document !== 'undefined' && document.hidden)) return
  if (selected !== observedTarget) {
    if (observedTarget) resize?.unobserve(observedTarget)
    observedTarget = selected ?? null
    if (observedTarget) resize?.observe(observedTarget)
  }
  if (!selected || !selected.getClientRects().length) { fluid?.dispose(); fluid = undefined; el.style.opacity = '0'; initialized = false; destinationBox = ''; return }
  const host = parent.getBoundingClientRect()
  const next = selected.getBoundingClientRect()
  const x = next.left - host.left + parent.scrollLeft - parent.clientLeft
  const y = next.top - host.top + parent.scrollTop - parent.clientTop
  const box = [x, y, next.width, next.height].map(value => Math.round(value * 100) / 100).join(',')
  if (initialized && box === destinationBox && !media?.matches) return
  destinationBox = box
  baseWidth = next.width; baseHeight = next.height
  el.style.width = baseWidth + 'px'
  el.style.height = baseHeight + 'px'
  el.style.opacity = '1'
  fluid ??= createFluidMotion([x, y, next.width, next.height], ([left, top, width, height]) => {
    el.style.transform = `translate(${left}px,${top}px) scale(${width / baseWidth},${height / baseHeight})`
  }, 5.5)
  fluid.to([x, y, next.width, next.height], !initialized)
  initialized = true
}
onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)')
    media = m
    if (typeof m.addEventListener === 'function') {
      m.addEventListener('change', schedule)
      removeMediaListener = () => m.removeEventListener('change', schedule)
    } else if (typeof m.addListener === 'function') {
      m.addListener(schedule)
      removeMediaListener = () => m.removeListener(schedule)
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  parent = indicator.value?.parentElement ?? null
  if (!parent) return
  resize = new ResizeObserver(schedule)
  resize.observe(parent)
  mutations = new MutationObserver(schedule)
  mutations.observe(parent, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-pressed', 'aria-selected', 'hidden'] })
  parent.addEventListener('scroll', schedule, { passive: true })
  document.fonts?.addEventListener('loadingdone', schedule)
  schedule()
})
onActivated(() => {
  schedule()
})
onDeactivated(() => {
  cancelAnimationFrame(frame)
  frame = 0
  fluid?.dispose()
  fluid = undefined
})
watch(() => props.target, schedule)
onUnmounted(() => {
  document.fonts?.removeEventListener('loadingdone', schedule)
  removeMediaListener?.()
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  resize?.disconnect()
  mutations?.disconnect()
  fluid?.dispose()
  cancelAnimationFrame(frame)
  parent?.removeEventListener('scroll', schedule)
})
</script>
<style scoped>
.animated-selection {
  position: absolute;
  inset: 0 auto auto 0;
  pointer-events: none;
  opacity: 0;
  transform-origin: 0 0;
  border-radius: var(--selection-radius, var(--r-md));
  background: linear-gradient(135deg, var(--glass-highlight), transparent), var(--bg-elevated);
  border: 1px solid var(--glass-edge);
  box-shadow: var(--selection-shadow, var(--shadow-glass-sm));
  transition: opacity var(--motion-hover) var(--ease-out);
  will-change: transform, opacity;
}
</style>
