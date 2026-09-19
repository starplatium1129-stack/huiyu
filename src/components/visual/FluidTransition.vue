<template>
  <Transition :css="false" :appear="appear" @enter="enter" @leave="leave" @after-leave="surface.dispose">
    <slot />
  </Transition>
</template>
<script setup lang="ts">
import { useFluidSurface, DEFAULT_FLUID_PANEL_SELECTOR } from '@/composables/useFluidSurface'

const props = withDefaults(defineProps<{ panel?: string; appear?: boolean }>(), {
  panel: DEFAULT_FLUID_PANEL_SELECTOR,
  appear: false,
})
const surface = useFluidSurface(props.panel)
function enter(el: Element, done: () => void) {
  const element = el as HTMLElement
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
