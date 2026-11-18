<template><span ref="indicator" class="animated-selection tw:absolute tw:[inset:0_auto_auto_0] tw:pointer-events-none tw:[border-radius:var(--selection-radius,_var(--r-md))] tw:[border:1px_solid_var(--glass-edge)] tw:[box-shadow:var(--selection-shadow,_var(--shadow-glass-sm))]" :class="{ 'animated-selection--underline': variant === 'underline' }" aria-hidden="true"><span ref="highlight" class="animated-selection-highlight"></span></span></template>
<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { frame, cancelFrame } from 'motion'
import { createFluidMotion } from '@/utils/fluidSpring'
import { SELECTION_SPRING } from '@/utils/controlSprings'
import '@/assets/css/studio-segments.css'
const props = withDefaults(defineProps<{ target?: string; stretch?: boolean; variant?: 'surface' | 'underline' }>(), { target: '[aria-pressed="true"], [aria-selected="true"], [aria-checked="true"]', stretch: false, variant: 'surface' })
const indicator = ref<HTMLElement | null>(null)
const highlight = ref<HTMLElement | null>(null)
let resize: ResizeObserver | undefined
let mutations: MutationObserver | undefined
let fluid: ReturnType<typeof createFluidMotion> | undefined
let suspended = false
type Measurement = { control: HTMLElement; x: number; y: number; width: number; height: number }
let measurement: Measurement | null = null
let destination: Measurement | null = null
const observedControls = new Set<HTMLElement>()
let parent: HTMLElement | null = null
let observing = false
let parentBox = ''
let keyboardInput = false
function keyboard(event: KeyboardEvent) {
  // Keep keyboard selection and its painted state together in every group;
  // managed tablists still retain ownership of their own roving focus.
  // Focus and content commit immediately; the decorative spring keeps its
  // current position/velocity through repeated arrow keys and pointer presses.
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  keyboardInput = true
  if (parent && event.target instanceof HTMLButtonElement && parent.contains(event.target)) {
    // Reka tabs with data-orientation own their own roving focus. Plain button groups and custom tablists use roving keys here.
    if (parent.dataset.segmentKeyboard === 'managed' || parent.hasAttribute('data-orientation') || parent.closest('[data-reka-tabs-list]')) return
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const buttons = Array.from(parent.querySelectorAll<HTMLButtonElement>('button')).filter(button =>
      !button.disabled && button.getAttribute('aria-disabled') !== 'true' && button.getBoundingClientRect().width > 0
      && (button.parentElement === parent || button.parentElement?.classList.contains('studio-tooltip-anchor') || button.closest('.studio-segments') === parent))
    const index = buttons.indexOf(event.target)
    if (index < 0 || buttons.length <= 1) return
    const rtl = getComputedStyle(parent).direction === 'rtl'
    const previous = event.key === 'ArrowUp' || event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (previous ? -1 : 1) + buttons.length) % buttons.length
    event.preventDefault()
    event.stopPropagation()
    focusSegment(buttons[next])
    buttons[next].click()
    return
  }
}
function focusSegment(button: HTMLButtonElement) {
  button.focus({ preventScroll: true })
  // Scroll only clipped controls, by the missing distance. Native focus scrolling
  // can leave a wrapped row partly outside a short nested viewport.
  for (let ancestor = button.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor === document.scrollingElement) break
    const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect()
    const box = button.getBoundingClientRect()
    const left = bounds.left + ancestor.clientLeft + (parseFloat(style.scrollPaddingLeft) || 0)
    const top = bounds.top + ancestor.clientTop + (parseFloat(style.scrollPaddingTop) || 0)
    const right = Math.min(bounds.right, bounds.left + ancestor.clientLeft + ancestor.clientWidth) - (parseFloat(style.scrollPaddingRight) || 0)
    const bottom = Math.min(bounds.bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight) - (parseFloat(style.scrollPaddingBottom) || 0)
    const x = /auto|scroll/.test(style.overflowX) ? box.left < left ? box.left - left : Math.max(0, box.right - right) : 0
    const y = /auto|scroll/.test(style.overflowY) ? box.top < top ? box.top - top : Math.max(0, box.bottom - bottom) : 0
    if (x || y) ancestor.scrollBy({ left:x, top:y, behavior:'instant' })
    // A native top-layer dialog is not clipped by its DOM ancestors behind it.
    if (ancestor instanceof HTMLDialogElement && ancestor.open) return
  }
  const box = button.getBoundingClientRect()
  const style = getComputedStyle(button)
  const margin = parseFloat(style.getPropertyValue('--s-2')) || 0
  const top = margin + (parseFloat(style.getPropertyValue('--desktop-chrome-height')) || 0)
    + (parseFloat(style.getPropertyValue('--app-navigation-visible-height')) || 0)
  const x = box.left < margin ? box.left - margin : Math.max(0, box.right - innerWidth + margin)
  const y = box.top < top ? box.top - top : Math.max(0, box.bottom - innerHeight + margin)
  if (x || y) window.scrollBy({ left:x, top:y, behavior:'instant' })
}
function pointer() { keyboardInput = false }
function cancelScheduled() {
  cancelFrame(render)
  measurement = destination = null
}
function onVisibilityChange() {
  if (typeof document !== 'undefined' && document.hidden) {
    stopObserving()
    cancelScheduled()
    fluid?.dispose()
    fluid = undefined
  } else {
    startObserving()
  }
}
function startObserving() {
  if (observing || suspended || document.hidden || !parent) return
  observing = true
  resize?.observe(parent)
  observeControls()
  mutations?.observe(parent, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-current', 'aria-pressed', 'aria-selected', 'aria-checked', 'data-state', 'hidden'] })
}
function stopObserving() {
  observing = false
  resize?.disconnect()
  mutations?.disconnect()
  observedControls.clear()
  parentBox = ''
}
function resized(entries: ResizeObserverEntry[]) {
  if (!observing || suspended || document.hidden) return
  const entry = entries.find(entry => entry.target === parent)
  if (entry) {
    const box = `${entry.contentRect.width}:${entry.contentRect.height}`
    const reflowed = parentBox !== '' && parentBox !== box
    parentBox = box
    if (reflowed) {
      // A row/size change belongs to layout, not selection travel. Snap before
      // the next indicator paint. Keep every observer's reads ahead of writes.
      cancelScheduled()
    }
  }
  // Sibling resizes can move the selection. Read only the active control after
  // layout, then let all groups share Motion's render phase.
  const control = selectedElement()
  const width = control?.offsetWidth, height = control?.offsetHeight
  measurement = control && width && height
    ? { control, x: control.offsetLeft, y: control.offsetTop, width, height }
    : null
  frame.render(render)
}
function observeControls() {
  if (!parent) return
  const controls = new Set(parent.querySelectorAll<HTMLElement>('button, a, [role="tab"], [role="radio"]'))
  const selected = selectedElement()
  if (selected) controls.add(selected)
  for (const control of observedControls) if (!controls.has(control)) {
    resize?.unobserve(control); observedControls.delete(control)
  }
  for (const control of controls) {
    if (!observedControls.has(control)) { observedControls.add(control); resize?.observe(control) }
  }
}
function selectedElement() {
  const selector = props.target
  return parent?.querySelector<HTMLElement>(selector)
    ?? (selector.includes(':scope >') ? parent?.querySelector<HTMLElement>(selector.replace(':scope >', ':scope ')) : null)
}
function refreshLayout() {
  if (!observing || !parent || suspended || document.hidden) return
  // Reordering and breakpoint gap changes can move controls without resizing
  // them. Request a fresh natural-layout delivery instead of reading now.
  resize?.unobserve(parent); resize?.observe(parent)
}
function mutated(records: MutationRecord[]) {
  if (records.some(record => record.type === 'childList')) observeControls()
  refreshLayout()
}
function render() {
  const el = indicator.value
  if (!el || suspended || document.hidden) return
  if (!measurement) {
    fluid?.dispose()
    fluid = undefined
    destination = null
    el.style.opacity = '0'
    return
  }
  const { x, y, width, height, control } = measurement
  const previous = destination
  destination = measurement
  if (previous && previous.x === x && previous.y === y && previous.width === width && previous.height === height) return
  el.style.width = width + 'px'
  el.style.height = height + 'px'
  el.style.opacity = '1'
  fluid ??= createFluidMotion([x, y, width, height], ([left, top, width, height]) => {
    if (!destination) return
    const { x: targetX, y: targetY, width: baseWidth, height: baseHeight } = destination
    // Lucian #039 / #043 · MIT (c) 2026 Seokwoooo. Stretch the existing
    // spring surface toward its destination; labels keep their own geometry.
    const extension = props.stretch && !keyboardInput ? Math.min(baseWidth * .65, Math.abs(targetX - left) * .2) : 0
    const leadingLeft = left - (targetX < left ? extension : 0)
    el.style.transform = `translate(${leadingLeft}px,${top}px) scale(${(width + extension) / baseWidth},${height / baseHeight})`
    // Light travels with the existing geometry spring and disappears when settled.
    // No timer, layout read, restarting keyframe or extra animation loop on rapid input.
    const light = highlight.value
    if (light) {
      const energy = Math.min(1, Math.hypot(targetX - left, targetY - top, (baseWidth - width) * .5, (baseHeight - height) * .5) / Math.max(40, baseWidth))
      light.style.opacity = String(energy * .42)
      light.style.transform = `translateX(${Math.sign(targetX - left) * energy * 14}%)`
    }
  }, SELECTION_SPRING.frequency, SELECTION_SPRING.damping)
  // Layout changes under the same selection snap. Selecting another control
  // retargets the current spring and preserves its velocity.
  fluid.to([x, y, width, height], !previous || previous.control === control)
}
onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange)
  parent = indicator.value?.parentElement ?? null
  if (!parent) return
  resize = new ResizeObserver(resized)
  mutations = new MutationObserver(mutated)
  startObserving()
  parent.addEventListener('keydown', keyboard, true)
  parent.addEventListener('pointerdown', pointer, true)
  window.addEventListener('resize', refreshLayout)
  document.fonts?.addEventListener('loadingdone', refreshLayout)
})
onActivated(() => {
  suspended = false
  startObserving()
})
onDeactivated(() => {
  suspended = true
  stopObserving()
  cancelScheduled()
  fluid?.dispose()
  fluid = undefined
})
watch(() => props.target, refreshLayout, { flush: 'post' })
onUnmounted(() => {
  suspended = true
  document.fonts?.removeEventListener('loadingdone', refreshLayout)
  window.removeEventListener('resize', refreshLayout)
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  stopObserving()
  fluid?.dispose()
  cancelScheduled()
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
  background: linear-gradient(105deg, transparent 15%, var(--glass-highlight) 45%, var(--glass-highlight) 65%, transparent 85%);
}
/* The same geometry spring can travel beneath labels without painting a panel. */
.animated-selection.animated-selection--underline { z-index:var(--z-raised); border:0; border-radius:0; box-shadow:none; background:none; }
.animated-selection--underline::after { content:''; position:absolute; inset:auto 0 0; height:2px; border-radius:var(--r-pill); background:var(--selection-ink,var(--text-primary)); }
.animated-selection--underline .animated-selection-highlight { display:none; }
@media (forced-colors: active) {
  .animated-selection-highlight { display:none; }
  .animated-selection--underline::after { background:Highlight; }
}
</style>
