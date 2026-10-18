<script setup lang="ts">
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { onActivated, onDeactivated, ref } from 'vue'
import { useModalPortalHost } from '@/composables/useModalPortalHost'

const props = withDefaults(defineProps<{ label: string; contentClass?: string; align?: 'start' | 'center' | 'end'; side?: 'top' | 'right' | 'bottom' | 'left'; prioritizePosition?: boolean; portalTo?: HTMLElement | null }>(), { align:'end', side:'bottom', prioritizePosition:false, contentClass:'' })
const open = defineModel<boolean>('open', { default:false })
const pointerOpened = ref(false)
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
// Closing a cached page must release the portal without focusing its hidden trigger.
function onCloseAutoFocus(event: Event) {
  if (!viewActive) event.preventDefault()
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
    <PopoverTrigger ref="trigger" as-child @pointerdown="pointerOpened = true" @keydown="pointerOpened = false" @keydown.esc.capture="onEscape"><slot name="trigger" /></PopoverTrigger>
    <PopoverPortal :to="portalTarget">
      <PopoverContent :align="align" :side="side" :prioritize-position="prioritizePosition" :side-offset="10" :collision-padding="16" :collision-boundary="collisionBoundary"
        hide-when-detached as-child @escape-key-down="onDismissEscape" @open-auto-focus="emit('openAutoFocus', $event)" @close-auto-focus="onCloseAutoFocus">
        <div ref="content" data-fluid-glass :aria-label="label" :aria-labelledby="undefined" :data-pointer-open="pointerOpened" class="studio-popover" :class="contentClass" @keydown.esc.capture="onEscape"><slot /></div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<!-- Reka portals cross component roots; keep these uniquely prefixed rules global. -->
<style>
@reference "../../assets/css/tailwind.css";
.studio-popover { @apply tw:[z-index:var(--z-popover)] tw:[width:min(340px,calc(100vw_-_32px))] tw:[max-height:var(--reka-popover-content-available-height,_calc(100dvh_-_32px))] tw:overflow-y-auto tw:overscroll-contain tw:p-s-4 tw:border tw:border-solid tw:border-soft tw:rounded-xl tw:bg-surface tw:text-primary tw:shadow-(--shadow-lg); }
/* Reka owns collision placement; only the inner surface grows from its trigger.
   Transitions retain presentation values. Dismissal releases focus immediately. */
.studio-popover { --popover-x:0px; --popover-y:4px; transform-origin:var(--reka-popover-content-transform-origin,top right); transition:opacity var(--motion-hover) var(--ease-out),transform var(--motion-hover) var(--ease-out); }
.studio-popover[data-side='top'] { --popover-y:-4px; }
.studio-popover[data-side='left'] { --popover-x:-4px; --popover-y:0px; }
.studio-popover[data-side='right'] { --popover-x:4px; --popover-y:0px; }
@starting-style { .studio-popover[data-state='open'][data-pointer-open='true'] { opacity:0; transform:translate(var(--popover-x),var(--popover-y)) scale(.97); } }
.studio-popover[data-pointer-open='false'] { transition:none; }
:root:is([data-motion='reduce'],[data-motion='reduced']) .studio-popover { transition:none; }
@media(prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .studio-popover { transition:none; } }
@media(forced-colors:active) { .studio-popover { background:Canvas; border-color:CanvasText; } }
</style>
