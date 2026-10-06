<template><span ref="indicator" class="animated-selection tw:absolute tw:[inset:0_auto_auto_0] tw:pointer-events-none tw:[border-radius:var(--selection-radius,_var(--r-md))] tw:[border:1px_solid_var(--glass-edge)] tw:[box-shadow:var(--selection-shadow,_var(--shadow-glass-sm))]" aria-hidden="true"><span ref="highlight" class="animated-selection-highlight"></span></span></template>
<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { frame, cancelFrame } from 'motion'
import { createFluidMotion } from '@/utils/fluidSpring'
import '@/assets/css/studio-segments.css'
const props = withDefaults(defineProps<{ target?: string }>(), { target: '[aria-pressed="true"], [aria-selected="true"], [aria-checked="true"]' })
const indicator = ref<HTMLElement | null>(null)
const highlight = ref<HTMLElement | null>(null)
let resize: ResizeObserver | undefined
let mutations: MutationObserver | undefined
let fluid: ReturnType<typeof createFluidMotion> | undefined
let baseWidth = 1, baseHeight = 1
let targetX = 0, targetY = 0
let suspended = false
let measurement: { x: number; y: number; width: number; height: number; box: string } | null = null
let media: MediaQueryList | undefined
let removeMediaListener: (() => void) | undefined
let initialized = false
let parent: HTMLElement | null = null
let observedTarget: HTMLElement | null = null
let destinationBox = ''
let keyboardInput = false
let measureFrame = 0
function keyboard(event: KeyboardEvent) {
  if (parent?.classList.contains('studio-segments') && event.target instanceof HTMLButtonElement) {
    keyboardInput = false
    // Reka owns tab/radio roving focus. Plain pressed-button groups use the same keys.
    if (parent.getAttribute('role') === 'tablist' || parent.dataset.segmentKeyboard === 'managed' || event.altKey || event.ctrlKey || event.metaKey) return
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const buttons = Array.from(parent.querySelectorAll<HTMLButtonElement>('button')).filter(button =>
      !button.disabled && button.getAttribute('aria-disabled') !== 'true' && button.getBoundingClientRect().width > 0)
    const index = buttons.indexOf(event.target)
    if (index < 0 || !buttons.length) return
    const rtl = getComputedStyle(parent).direction === 'rtl'
    const previous = event.key === 'ArrowUp' || event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (previous ? -1 : 1) + buttons.length) % buttons.length
    event.preventDefault()
    event.stopPropagation()
    buttons[next].focus({ preventScroll: true })
    buttons[next].click()
    return
  }
  keyboardInput = true; fluid?.settle(); indicator.value?.style.setProperty('transition','none')
}
function pointer() { keyboardInput = false; indicator.value?.style.removeProperty('transition') }
// Motion batches all indicator reads before any indicator writes in this frame.
function schedule() {
  if (suspended || document.hidden || measureFrame) return
  // Navigation first commits and paints its content. Decorative geometry reads
  // then use that layout, rather than forcing a large new image page to lay out.
  measureFrame = requestAnimationFrame(() => {
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0
      if (!suspended && !document.hidden) frame.read(update)
    })
  })
}
function cancelScheduled() {
  cancelAnimationFrame(measureFrame); measureFrame = 0
  cancelFrame(update); cancelFrame(render); measurement = null
  // Reactivation must snap to the selected target, not retain a paused spring.
  initialized = false; destinationBox = ''
}
function onVisibilityChange() {
  if (typeof document !== 'undefined' && document.hidden) {
    cancelScheduled()
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
  const next = selected?.getBoundingClientRect()
  if (!next?.width || !next.height) { measurement = null; frame.render(render); return }
  const host = parent.getBoundingClientRect()
  const x = next.left - host.left + parent.scrollLeft - parent.clientLeft
  const y = next.top - host.top + parent.scrollTop - parent.clientTop
  const box = [x, y, next.width, next.height].map(value => Math.round(value * 100) / 100).join(',')
  if (initialized && box === destinationBox && !media?.matches) return
  measurement = { x, y, width: next.width, height: next.height, box }
  frame.render(render)
}
function render() {
  const el = indicator.value
  if (!el || suspended || document.hidden) return
  if (!measurement) { fluid?.dispose(); fluid = undefined; el.style.opacity = '0'; initialized = false; destinationBox = ''; return }
  const { x, y, width, height, box } = measurement
  destinationBox = box
  baseWidth = width; baseHeight = height
  targetX = x; targetY = y
  el.style.width = baseWidth + 'px'
  el.style.height = baseHeight + 'px'
  el.style.opacity = '1'
  fluid ??= createFluidMotion([x, y, width, height], ([left, top, width, height]) => {
    el.style.transform = `translate(${left}px,${top}px) scale(${width / baseWidth},${height / baseHeight})`
    // Light travels with the existing geometry spring and disappears when settled.
    // No timer, layout read, restarting keyframe or extra animation loop on rapid input.
    const light = highlight.value
    if (light) {
      const energy = Math.min(1, Math.hypot(targetX - left, targetY - top, (baseWidth - width) * .5, (baseHeight - height) * .5) / Math.max(40, baseWidth))
      light.style.opacity = String(energy * .42)
      light.style.transform = `translateX(${Math.sign(targetX - left) * energy * 14}%)`
    }
  }, 5.5)
  fluid.to([x, y, width, height], !initialized || keyboardInput)
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
  mutations.observe(parent, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-current', 'aria-pressed', 'aria-selected', 'aria-checked', 'data-state', 'hidden'] })
  parent.addEventListener('scroll', schedule, { passive: true })
  parent.addEventListener('keydown', keyboard, true)
  parent.addEventListener('pointerdown', pointer, true)
  document.fonts?.addEventListener('loadingdone', schedule)
  schedule()
})
onActivated(() => {
  suspended = false
  schedule()
})
onDeactivated(() => {
  suspended = true
  cancelScheduled()
  fluid?.dispose()
  fluid = undefined
})
watch(() => props.target, schedule)
onUnmounted(() => {
  suspended = true
  document.fonts?.removeEventListener('loadingdone', schedule)
  removeMediaListener?.()
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  resize?.disconnect()
  mutations?.disconnect()
  fluid?.dispose()
  cancelScheduled()
  parent?.removeEventListener('scroll', schedule)
  parent?.removeEventListener('keydown', keyboard, true)
  parent?.removeEventListener('pointerdown', pointer, true)
})
</script>
<style scoped>
.animated-selection {
  opacity: 0;
  overflow: hidden;
  transform-origin: 0 0;
  background: linear-gradient(135deg, var(--glass-highlight), transparent), var(--bg-elevated);
  transition: opacity var(--motion-hover) var(--ease-out);
}
.animated-selection-highlight {
  position: absolute;
  inset: 0 -20%;
  border-radius: inherit;
  opacity: 0;
  background: linear-gradient(105deg, transparent 15%, var(--glass-highlight) 45%, var(--accent-soft) 65%, transparent 85%);
}
@media (forced-colors: active) { .animated-selection-highlight { display: none; } }
</style>
