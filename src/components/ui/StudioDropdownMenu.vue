<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue'
import { DropdownMenuContent, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui'
import { useModalPortalHost } from '@/composables/useModalPortalHost'
import FluidTransition from '@/components/visual/FluidTransition.vue'

withDefaults(defineProps<{ label: string; sideOffset?: number }>(), { sideOffset: 8 })
const open = ref(false), pointerOpened = ref(false)
const trigger = shallowRef<{ $el: HTMLElement } | null>(null)
const { portalTarget, collisionBoundary } = useModalPortalHost(() => trigger.value?.$el, open)
let viewActive = true, actionSelected = false, interactedOutside = false
watch(open, value => { if (value) { actionSelected = false; interactedOutside = false } }, { flush: 'sync' })
onActivated(() => { viewActive = true })
function deactivate() { viewActive = false; open.value = false }
onDeactivated(deactivate)
onBeforeUnmount(deactivate)

function focusTrigger() {
  const element = trigger.value?.$el
  if (element?.isConnected && element.getClientRects().length && !element.closest('[inert], [hidden]') && !element.matches(':disabled'))
    element.focus({ preventScroll: true })
}
function run(action: () => void) {
  if (!viewActive || !open.value) return
  actionSelected = true
  open.value = false
  // The next action may open a modal synchronously; it must inherit this trigger.
  focusTrigger()
  action()
}
function closeAutoFocus(event: Event) {
  // Reka otherwise schedules an unguarded timer. Restore here so an old menu
  // cannot steal focus from a newer opening, modal, or deactivated page.
  event.preventDefault()
  if (viewActive && !open.value && !actionSelected && !interactedOutside) focusTrigger()
}
function onInteractOutside() { interactedOutside = true }
function onEscape(event: KeyboardEvent) {
  if (!open.value || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  open.value = false
}
function onDismissEscape(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) event.preventDefault()
}
</script>

<template>
  <DropdownMenuRoot v-model:open="open" :modal="false">
    <DropdownMenuTrigger ref="trigger" as-child @pointerdown="pointerOpened = true" @keydown="pointerOpened = false" @keydown.esc.capture="onEscape">
      <slot name="trigger" />
    </DropdownMenuTrigger>
    <DropdownMenuPortal :to="portalTarget">
      <FluidTransition small panel=".chat-more-menu">
      <DropdownMenuContent v-if="open" force-mount class="chat-more-menu" data-fluid-glass align="end" :side-offset="sideOffset" :collision-padding="12" :collision-boundary="collisionBoundary"
        :data-pointer-open="pointerOpened" hide-when-detached loop :aria-label="label" :aria-labelledby="undefined"
        @close-auto-focus="closeAutoFocus" @interact-outside="onInteractOutside" @keydown.capture="pointerOpened = false"
        @keydown.esc.capture="onEscape" @escape-key-down="onDismissEscape">
        <slot :run="run" />
      </DropdownMenuContent>
      </FluidTransition>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<!-- Keep the established selectors for fluid materials and Terraria surfaces. -->
<style>
@reference "../../assets/css/tailwind.css";
.chat-more-menu {
  @apply tw:flex tw:flex-col tw:p-s-2 tw:border tw:border-solid tw:border-soft tw:rounded-xl tw:bg-surface tw:text-primary tw:shadow-(--shadow-lg);
  z-index:var(--z-popover);
  width:min(272px,calc(100vw - 24px));
  max-height:var(--reka-dropdown-menu-content-available-height,calc(100dvh - 24px));
  overflow-y:auto;
  overscroll-behavior:contain;
  transform-origin:var(--reka-dropdown-menu-content-transform-origin,top right);
}
.chat-more-label { @apply tw:px-s-3 tw:py-s-2 tw:text-muted tw:text-label-xs; font-weight:600; }
.chat-more-item { @apply tw:flex tw:items-center tw:gap-s-2 tw:min-h-[40px] tw:py-s-2 tw:px-s-3 tw:rounded-md tw:text-secondary tw:text-label tw:cursor-pointer; outline:none; flex-shrink:0; }
.chat-more-item > span { min-width:0; overflow-wrap:anywhere; }
.chat-more-item .archive-icon { @apply tw:w-[16px] tw:h-[16px] tw:shrink-0; }
.chat-more-item[data-highlighted] { background:var(--accent-soft); color:var(--text-primary); }
.chat-more-menu[data-pointer-open='false'] .chat-more-item[data-highlighted] { outline:none; box-shadow:var(--focus-shadow); }
.chat-more-item.is-danger { color:var(--danger-text); }
.chat-more-item.is-danger[data-highlighted] { background:color-mix(in srgb,var(--danger) 12%,var(--bg-surface)); }
.chat-more-item[data-disabled] { color:var(--text-disabled); cursor:default; }
.chat-more-separator { height:1px; margin:var(--s-2) var(--s-1); background:var(--border-soft); flex-shrink:0; }
.chat-more-menu { --surface-enter-x:0px; --surface-enter-y:4px; }
.chat-more-menu[data-side='top'] { --surface-enter-y:-4px; }
@media(forced-colors:active) { .chat-more-item[data-highlighted] { outline:2px solid Highlight; outline-offset:-2px; } }
</style>
