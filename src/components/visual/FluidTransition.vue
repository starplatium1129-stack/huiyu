<template>
  <Transition :css="false" :appear="appear" @enter="enter" @leave="leave" @leave-cancelled="leaveCancelled" @after-leave="afterLeave">
    <slot />
  </Transition>
</template>
<script setup lang="ts">
import { onDeactivated, onUnmounted } from 'vue'
import { createFluidSurface } from '@/composables/useFluidSurface'

const props = withDefaults(defineProps<{ panel?: string; appear?: boolean; small?: boolean }>(), {
  panel: '[role="dialog"]',
  appear: true,
})
const surface = createFluidSurface(props.panel, { small: props.small })
const leaving = new Set<Element>()
// An explicitly closing component may unmount before its picture finishes.
// Its leave callback retains ownership until Vue removes that one surface.
onDeactivated(surface.finish)
onUnmounted(() => { if (!leaving.size) surface.clear() })
let interrupted: ReturnType<typeof surface.capture>
function enter(el: Element, done: () => void) {
  const element = el as HTMLElement
  element.inert = false
  element.removeAttribute('data-fluid-leaving')
  if (interrupted) { surface.adopt(el, interrupted); interrupted = undefined }
  surface.enter(el, done)
}
function afterLeave(el: Element) {
  leaving.delete(el)
  const state = surface.capture(el)
  // Vue finishes the old v-if leave before inserting its replacement. Carry the
  // physical state across that DOM handoff, including velocity during reversal.
  interrupted = state && (state.value !== 0 || state.velocity !== 0 || state.opacity !== 0) ? state : undefined
  surface.dispose(el)
}
function leave(el: Element, done: () => void) {
  leaving.add(el)
  const element = el as HTMLElement
  element.inert = true
  element.setAttribute('data-fluid-leaving', '')
  surface.leave(el, done)
}
function leaveCancelled(el: Element) {
  leaving.delete(el)
  const element = el as HTMLElement
  element.inert = false
  element.removeAttribute('data-fluid-leaving')
}
</script>
