<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue'
import { DropdownMenuContent, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui'
import { useModalPortalHost } from '@/composables/useModalPortalHost'
import FluidTransition from '@/components/visual/FluidTransition.vue'

withDefaults(defineProps<{
  label: string
  sideOffset?: number
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
}>(), {
  sideOffset: 8,
  align: 'end',
  side: 'bottom',
})

const open = ref(false), pointerOpened = ref(false)
const trigger = shallowRef<{ $el?: unknown } | HTMLElement | null>(null)
const { portalTarget, collisionBoundary } = useModalPortalHost(() => trigger.value, open)
let viewActive = true, actionSelected = false, interactedOutside = false
watch(open, value => { if (value) { actionSelected = false; interactedOutside = false } }, { flush: 'sync' })
onActivated(() => { viewActive = true })
function deactivate() { viewActive = false; open.value = false }
onDeactivated(deactivate)
onBeforeUnmount(deactivate)

function focusTrigger() {
  const raw = trigger.value
  const element = (raw && typeof raw === 'object' && '$el' in raw && (raw as { $el?: unknown }).$el instanceof HTMLElement)
    ? (raw as { $el: HTMLElement }).$el
    : (raw instanceof HTMLElement ? raw : null)
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
  event.stopPropagation()
  open.value = false
  focusTrigger()
}
function onDismissEscape(event: KeyboardEvent | CustomEvent<{ originalEvent?: KeyboardEvent }>) {
  const customDetail = 'detail' in event && typeof event.detail === 'object' && event.detail !== null
    ? (event.detail as { originalEvent?: KeyboardEvent })
    : null
  const orig = customDetail?.originalEvent ?? (event instanceof KeyboardEvent ? event : null)
  if (orig?.isComposing || orig?.keyCode === 229) {
    event.preventDefault()
    orig?.preventDefault?.()
    return
  }
  event.stopPropagation?.()
  orig?.stopPropagation?.()
}
</script>

<template>
  <DropdownMenuRoot v-model:open="open" :modal="false">
    <DropdownMenuTrigger ref="trigger" as-child @pointerdown="pointerOpened = true" @keydown="pointerOpened = false" @keydown.esc.capture="onEscape">
      <slot name="trigger" />
    </DropdownMenuTrigger>
    <DropdownMenuPortal :to="portalTarget">
      <FluidTransition small panel=".studio-dropdown-menu">
      <DropdownMenuContent
        v-if="open"
        force-mount
        class="studio-dropdown-menu"
        data-fluid-glass
        data-elevation="2"
        :align="align"
        :side="side"
        :side-offset="sideOffset"
        :collision-padding="12"
        :collision-boundary="collisionBoundary"
        :data-pointer-open="pointerOpened"
        hide-when-detached
        loop
        :aria-label="label"
        :aria-labelledby="undefined"
        @close-auto-focus="closeAutoFocus"
        @interact-outside="onInteractOutside"
        @keydown.capture="pointerOpened = false"
        @keydown.esc.capture="onEscape"
        @escape-key-down="onDismissEscape"
      >
        <slot :run="run" />
      </DropdownMenuContent>
      </FluidTransition>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<!-- Shared dropdown primitives (.studio-dropdown-*); keep legacy .chat-more-* aliases for existing callers. -->
<style>
@reference "../../assets/css/tailwind.css";
.studio-dropdown-menu {
  @apply tw:flex tw:flex-col tw:p-s-2 tw:border tw:border-solid tw:border-soft tw:rounded-xl tw:bg-surface tw:text-primary tw:shadow-(--shadow-lg);
  z-index: var(--z-popover);
  width: min(272px, calc(100vw - 24px));
  max-height: var(--reka-dropdown-menu-content-available-height, calc(100dvh - 24px));
  overflow-y: auto;
  overscroll-behavior: contain;
  transform-origin: var(--reka-dropdown-menu-content-transform-origin, top right);
  --surface-enter-x: 0px;
  --surface-enter-y: 4px;
}
.studio-dropdown-menu[data-side='top'] { --surface-enter-y: -4px; }
:is(.studio-dropdown-label, .chat-more-label) { @apply tw:px-s-3 tw:py-s-2 tw:text-muted tw:text-label-xs; font-weight: 600; }
:is(.studio-dropdown-item, .chat-more-item) {
  @apply tw:flex tw:items-center tw:gap-s-2 tw:min-h-[40px] tw:py-s-2 tw:px-s-3 tw:rounded-md tw:text-secondary tw:text-label tw:cursor-pointer;
  outline: none;
  flex-shrink: 0;
}
:is(.studio-dropdown-item, .chat-more-item) > span { min-width: 0; overflow-wrap: anywhere; }
:is(.studio-dropdown-item, .chat-more-item) .archive-icon { @apply tw:w-[16px] tw:h-[16px] tw:shrink-0; }
:is(.studio-dropdown-item, .chat-more-item)[data-highlighted] { color: var(--text-primary); }
.studio-dropdown-menu[data-pointer-open='false'] :is(.studio-dropdown-item, .chat-more-item)[data-highlighted] {
  outline: none;
  box-shadow: var(--focus-shadow, 0 0 0 2px var(--focus-color, var(--text-secondary)));
}
:is(.studio-dropdown-item, .chat-more-item).is-danger { color: var(--danger-text); }
:is(.studio-dropdown-item, .chat-more-item).is-danger[data-highlighted] {
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-surface));
}
:is(.studio-dropdown-item, .chat-more-item)[data-disabled] { color: var(--text-disabled); cursor: default; }
:is(.studio-dropdown-separator, .chat-more-separator) {
  height: 1px;
  margin: var(--s-2) var(--s-1);
  background: var(--border-soft);
  flex-shrink: 0;
}
@media (pointer: coarse) {
  :is(.studio-dropdown-item, .chat-more-item) { min-height: 44px; }
}
:root[data-theme-style='terraria'] .studio-dropdown-menu {
  border: 3px solid var(--terraria-soil);
  border-radius: 0;
  background-color: var(--bg-surface);
  background-image: var(--terraria-paper);
  background-size: auto, 256px 256px;
  box-shadow: inset 0 0 0 1px var(--terraria-edge), 2px 2px 0 var(--terraria-outline);
}
@media (forced-colors: active) {
  .studio-dropdown-menu { background: Canvas; border-color: CanvasText; color: CanvasText; }
  :is(.studio-dropdown-item, .chat-more-item)[data-highlighted] { outline: 2px solid Highlight; outline-offset: -2px; }
}
</style>
