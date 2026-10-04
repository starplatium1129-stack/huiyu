<script setup lang="ts">
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { computed, onActivated, onDeactivated, ref } from 'vue'

withDefaults(defineProps<{ label: string; contentClass?: string; align?: 'start' | 'center' | 'end' }>(), { align:'end', contentClass:'' })
const open = defineModel<boolean>('open', { default:false })
const pointerOpened = ref(false)
const trigger = ref<{ $el: HTMLElement } | null>(null)
// Native top layers and custom focus traps both require content inside their modal.
const portalTarget = computed(() => trigger.value?.$el?.closest<HTMLElement>('dialog, [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]') ?? undefined)
const collisionBoundary = computed(() => portalTarget.value?.tagName === 'DIALOG' ? undefined : portalTarget.value)
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
  event.preventDefault()
  open.value = false
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger ref="trigger" as-child @pointerdown="pointerOpened = true" @keydown="pointerOpened = false" @keydown.esc="onEscape"><slot name="trigger" /></PopoverTrigger>
    <PopoverPortal :to="portalTarget">
      <PopoverContent :align="align" :side-offset="10" :collision-padding="16" :collision-boundary="collisionBoundary"
        hide-when-detached as-child @open-auto-focus="emit('openAutoFocus', $event)" @close-auto-focus="onCloseAutoFocus">
        <div :aria-label="label" :aria-labelledby="undefined" :data-pointer-open="pointerOpened" class="studio-popover" :class="contentClass" @keydown.esc="onEscape"><slot /></div>
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
.studio-popover { transform-origin:var(--reka-popover-content-transform-origin,top right); transition:opacity var(--motion-hover) var(--ease-out),transform var(--motion-hover) var(--ease-out); }
@starting-style { .studio-popover[data-state='open'][data-pointer-open='true'] { opacity:0; transform:scale(.97); } }
.studio-popover[data-pointer-open='false'] { transition:none; }
@media(prefers-reduced-motion:reduce) { .studio-popover { transition:none; } }
@media(forced-colors:active) { .studio-popover { background:Canvas; border-color:CanvasText; } }
</style>
