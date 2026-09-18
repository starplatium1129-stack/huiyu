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
let frame: number | null = null
let removeMediaListener: (() => void) | undefined
let active = false, initialized = false
let parent: HTMLElement | null = null
let observedTarget: HTMLElement | null = null
let destinationBox = ''
function cancelFrame() { if (frame !== null) cancelAnimationFrame(frame); frame = null }
function schedule() { if (active && !document.hidden && frame === null) frame = requestAnimationFrame(update) }
function update() {
  frame = null
  if (!active || document.hidden) return
  const el = indicator.value
  const selected = parent?.querySelector<HTMLElement>(props.target)
  if (!el || !parent) return
  if (selected !== observedTarget) {
    if (observedTarget) resize?.unobserve(observedTarget)
    observedTarget = selected ?? null
    if (observedTarget) resize?.observe(observedTarget)
  }
  if (!selected || !selected.getClientRects().length) { fluid?.dispose(); fluid = undefined; el.style.opacity = '0'; initialized = false; destinationBox = ''; return }
  const host = parent.getBoundingClientRect(), next = selected.getBoundingClientRect()
  if (next.width <= 0 || next.height <= 0) return
  const x = next.left - host.left + parent.scrollLeft - parent.clientLeft
  const y = next.top - host.top + parent.scrollTop - parent.clientTop
  const box = [x, y, next.width, next.height].map(value => Math.round(value * 100) / 100).join(',')
  if (initialized && box === destinationBox) return
  destinationBox = box
  baseWidth = next.width; baseHeight = next.height
  el.style.width = baseWidth + 'px'; el.style.height = baseHeight + 'px'; el.style.opacity = '1'
  fluid ??= createFluidMotion([x, y, next.width, next.height], ([left, top, width, height]) => {
    el.style.transform = `translate(${left}px,${top}px) scale(${width / baseWidth},${height / baseHeight})`
  }, 5.5)
  fluid.to([x, y, next.width, next.height], !initialized)
  initialized = true
}
function visibility() {
  if (document.hidden) { cancelFrame(); fluid?.settle() }
  else { initialized = false; schedule() }
}
function start() {
  if (active) return
  parent = indicator.value?.parentElement ?? null
  if (!parent) return
  active = true
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  if (typeof media?.addEventListener === 'function') {
    media.addEventListener('change', schedule)
    removeMediaListener = () => media.removeEventListener('change', schedule)
  } else if (typeof media?.addListener === 'function') {
    media.addListener(schedule); removeMediaListener = () => media.removeListener(schedule)
  }
  if (typeof ResizeObserver === 'function') { resize = new ResizeObserver(schedule); resize.observe(parent) }
  if (typeof MutationObserver === 'function') {
    mutations = new MutationObserver(schedule)
    mutations.observe(parent, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-pressed', 'aria-selected', 'hidden'] })
  }
  parent.addEventListener('scroll', schedule, { passive: true })
  document.fonts?.addEventListener('loadingdone', schedule)
  document.addEventListener('visibilitychange', visibility)
  schedule()
}
function stop() {
  if (!active) return
  active = false
  cancelFrame(); resize?.disconnect(); mutations?.disconnect(); fluid?.dispose(); removeMediaListener?.()
  parent?.removeEventListener('scroll', schedule)
  document.fonts?.removeEventListener('loadingdone', schedule)
  document.removeEventListener('visibilitychange', visibility)
  resize = undefined; mutations = undefined; fluid = undefined; removeMediaListener = undefined
  observedTarget = null; parent = null; initialized = false; destinationBox = ''
}
onMounted(start)
onActivated(start)
onDeactivated(stop)
onUnmounted(stop)
watch(() => props.target, schedule)
</script>
<style scoped>
.animated-selection { position: absolute; inset: 0 auto auto 0; pointer-events: none; opacity: 0; transform-origin: 0 0; border-radius: var(--selection-radius, var(--r-md)); background: linear-gradient(135deg, var(--glass-highlight), transparent), var(--bg-elevated); border: 1px solid var(--glass-edge); box-shadow: var(--selection-shadow, var(--shadow-glass-sm)); }
</style>
