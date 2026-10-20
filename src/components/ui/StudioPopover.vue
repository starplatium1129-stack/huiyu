<script setup lang="ts">
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { onActivated, onBeforeUnmount, onDeactivated, ref } from 'vue'
import { useModalPortalHost } from '@/composables/useModalPortalHost'
import FluidTransition from '@/components/visual/FluidTransition.vue'

const props = withDefaults(defineProps<{ label: string; contentClass?: string; align?: 'start' | 'center' | 'end'; side?: 'top' | 'right' | 'bottom' | 'left'; prioritizePosition?: boolean; portalTo?: HTMLElement | null }>(), { align:'end', side:'bottom', prioritizePosition:false, contentClass:'' })
const open = defineModel<boolean>('open', { default:false })
const trigger = ref<{ $el: HTMLElement } | null>(null)
const content = ref<HTMLElement | null>(null)
const { portalTarget, collisionBoundary } = useModalPortalHost(() => trigger.value?.$el, open, () => props.portalTo)
const emit = defineEmits<{ openAutoFocus: [event: Event]; closeAutoFocus: [event: Event] }>()
let viewActive = true
onActivated(() => { viewActive = true })
onDeactivated(() => {
  viewActive = false
  open.value = false
})
onBeforeUnmount(() => { viewActive = false })
// Cached and unmounted owners must not restore focus from an exiting portal.
function onCloseAutoFocus(event: Event) {
  if (!viewActive || open.value) event.preventDefault()
  emit('closeAutoFocus', event)
}
function onEscape(event: KeyboardEvent) {
  if (!open.value || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  // Let an expanded child select/menu own Escape before closing this surface.
  if (content.value?.querySelector('[aria-haspopup][aria-expanded="true"], [role="combobox"][aria-expanded="true"]')) return
  event.preventDefault()
  open.value = false
}
function onDismissEscape(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) event.preventDefault()
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger ref="trigger" as-child @keydown.esc.capture="onEscape"><slot name="trigger" /></PopoverTrigger>
    <PopoverPortal :to="portalTarget">
      <FluidTransition small panel=".studio-popover">
      <PopoverContent v-if="open" force-mount :align="align" :side="side" :prioritize-position="prioritizePosition" :side-offset="10" :collision-padding="16" :collision-boundary="collisionBoundary"
        hide-when-detached as-child @escape-key-down="onDismissEscape" @open-auto-focus="emit('openAutoFocus', $event)" @close-auto-focus="onCloseAutoFocus">
        <div ref="content" data-fluid-glass :aria-label="label" :aria-labelledby="undefined" class="studio-popover" :class="contentClass" @keydown.esc.capture="onEscape"><slot /></div>
      </PopoverContent>
      </FluidTransition>
    </PopoverPortal>
  </PopoverRoot>
</template>

<!-- Reka portals cross component roots; keep these uniquely prefixed rules global. -->
<style>
@reference "../../assets/css/tailwind.css";
.studio-popover { @apply tw:[z-index:var(--z-popover)] tw:[width:min(340px,calc(100vw_-_32px))] tw:[max-height:var(--reka-popover-content-available-height,_calc(100dvh_-_32px))] tw:overflow-y-auto tw:overscroll-contain tw:p-s-4 tw:border tw:border-solid tw:border-soft tw:rounded-xl tw:bg-surface tw:text-primary tw:shadow-(--shadow-lg); }
/* FluidTransition owns the surface spring; Reka owns placement/dismissal. */
.studio-popover { --surface-enter-x:0px; --surface-enter-y:4px; transform-origin:var(--reka-popover-content-transform-origin,top right); }
.studio-popover[data-side='top'] { --surface-enter-y:-4px; }
.studio-popover[data-side='left'] { --surface-enter-x:-4px; --surface-enter-y:0px; }
.studio-popover[data-side='right'] { --surface-enter-x:4px; --surface-enter-y:0px; }
@media(forced-colors:active) { .studio-popover { background:Canvas; border-color:CanvasText; } }
</style>
