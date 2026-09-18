<template>
  <Transition :css="false" :appear="appear" @before-enter="own" @enter="enter" @leave="leave" @after-leave="surface.dispose">
    <slot />
  </Transition>
</template>
<script setup lang="ts">
import { useFluidSurface } from '@/composables/useFluidSurface'
const props = withDefaults(defineProps<{ panel?: string; appear?: boolean }>(), {
  panel: '.story-card, .modal-card, .batch-panel, .shot-script-panel, .pb-compare, .pb-backup-card, .pb-backup-modal, .candidate-compare, .task-center, .art-viewer, .showcase-viewer, .guest-guide-card, [role="dialog"]',
  appear: false,
})
const surface = useFluidSurface(props.panel)
function own(el: Element) { el.setAttribute('data-fluid-surface', '') }
function enter(el: Element, done: () => void) {
  const element = el as HTMLElement
  own(el)
  element.inert = false
  element.removeAttribute('data-fluid-leaving')
  surface.enter(el, done)
}
function leave(el: Element, done: () => void) {
  const element = el as HTMLElement
  element.inert = true
  element.setAttribute('data-fluid-leaving', '')
  surface.leave(el, done)
}
</script>
<style>
/* This viewer now has one motion owner. Keep the legacy rule for native dialogs,
   but never combine its forwards-filled CSS animation with this spring. */
.art-viewer.open[data-fluid-surface] { animation: none; }
</style>
