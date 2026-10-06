<template>
  <Teleport v-if="desktop" to="body">
    <dialog ref="dialog" class="companion-preferences" :data-character="characterId" aria-label="桌宠设置"
      @cancel.prevent.stop="close" @click="backdrop" @keydown.esc.stop>
      <header class="preferences-heading tw:flex tw:items-center tw:justify-between"><div><h2>桌宠设置</h2><small>{{ characterName }}</small></div>
        <button type="button" aria-label="关闭桌宠设置" autofocus @click="close"><ArchiveIcon name="close" /></button>
      </header>
      <nav class="preferences-tabs studio-segments tw:grid tw:gap-[4px] tw:p-[4px] tw:rounded-lg" data-fluid-glass role="tablist" aria-label="设置分类" @keydown="tabKey">
        <AnimatedSelection />
        <button v-for="tab in tabs" :id="`${id}-${tab.value}`" :key="tab.value" type="button" role="tab"
          :aria-selected="pane === tab.value" :aria-controls="`${id}-panel`" :tabindex="pane === tab.value ? 0 : -1"
          @click="pane = tab.value"><ArchiveIcon :name="tab.icon" />{{ tab.label }}</button>
      </nav>
      <div :id="`${id}-panel`" v-content-motion:up="pane" class="companion-preferences-body tw:grid tw:gap-s-3 tw:min-h-0 tw:overflow-auto" :data-pane="pane" role="tabpanel" :aria-labelledby="`${id}-${pane}`"><slot /></div>
    </dialog>
  </Teleport>
  <template v-else><FluidTransition panel=".companion-settings-popover"><div v-if="open" class="companion-settings-popover" data-fluid-glass role="dialog" aria-label="桌宠设置" @pointerdown.stop><slot /></div></FluidTransition></template>
</template>

<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import AnimatedSelection from './visual/AnimatedSelection.vue'
import FluidTransition from './visual/FluidTransition.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
const props = defineProps<{ open: boolean; desktop: boolean; characterId: string; characterName: string }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const fluid = useFluidDialog(dialog)
const id = useId()
const tabs = [
  { value: 'character', label: '角色', icon: 'character' },
  { value: 'companion', label: '陪伴', icon: 'chat' },
  { value: 'more', label: '更多', icon: 'gear' },
] as const
const pane = ref<(typeof tabs)[number]['value']>('character')
watch(() => props.open, value => {
  if (!props.desktop) return
  if (value) { pane.value = 'character'; fluid.open(document.querySelector<HTMLElement>('.orbit-settings-trigger')) }
  else fluid.close()
}, { flush: 'post' })
watch(pane, () => { dialog.value?.querySelector('.companion-preferences-body')?.scrollTo({ top: 0 }) })
function tabKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault(); event.stopPropagation()
  const current = tabs.findIndex(tab => tab.value === pane.value)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (current + (event.key === 'ArrowLeft' ? 2 : 1)) % 3
  pane.value = tabs[next]!.value
  dialog.value?.querySelector<HTMLButtonElement>(`#${id}-${pane.value}`)?.focus()
}
function close() { emit('update:open', false) }
function backdrop(event: MouseEvent) { if (isBackdropClick(event, dialog.value)) close() }
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.companion-preferences { @apply tw:box-border; width: min(380px, calc(100vw - 24px)); max-height: min(540px, calc(100dvh - 24px)); @apply tw:m-auto tw:p-0 tw:overflow-hidden tw:text-primary; background: var(--bg-elevated); border: 1px solid var(--border-strong); @apply tw:rounded-xl; box-shadow: var(--shadow-lg); }
.companion-preferences[open] { @apply tw:flex tw:flex-col; }
.companion-preferences::backdrop { background: color-mix(in srgb, var(--bg-deep) 24%, transparent); }
.preferences-heading { flex: 0 0 auto; padding: var(--s-3) var(--s-4); }
.preferences-heading > div { @apply tw:grid tw:gap-[4px]; }
.preferences-heading small { @apply tw:text-secondary tw:text-label-sm; }
h2 { @apply tw:m-0 tw:text-body; font-weight: 650; }
.preferences-heading button { @apply tw:grid; place-items: center; @apply tw:w-[40px] tw:h-[40px]; border: 1px solid var(--border-soft); border-radius: 50%; @apply tw:text-primary; background: var(--bg-surface); @apply tw:cursor-pointer; }
.preferences-heading svg { @apply tw:w-[18px] tw:h-[18px]; }
.preferences-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); flex: 0 0 auto; margin: 0 var(--s-4) var(--s-3); border: 1px solid var(--border-soft); background: var(--bg-surface); }
.preferences-tabs button { @apply tw:flex tw:items-center tw:justify-center tw:gap-[6px] tw:min-h-[40px] tw:p-[4px]; border: 1px solid transparent; @apply tw:rounded-md; background: transparent; @apply tw:text-secondary tw:text-label-sm tw:cursor-pointer; }
.preferences-tabs button[aria-selected="true"] { @apply tw:text-primary; background: color-mix(in srgb, var(--accent) 12%, var(--bg-elevated)); @apply tw:border-accent; }
.preferences-tabs svg { @apply tw:w-[17px] tw:h-[17px]; }
.companion-preferences-body { overscroll-behavior: contain; padding: 0 var(--s-4) var(--s-4); scrollbar-width: thin; }
.companion-preferences-body :deep(.companion-pop-group) { @apply tw:hidden tw:gap-[4px] tw:p-s-3; border: 1px solid var(--border-soft); @apply tw:rounded-lg; background: var(--bg-surface); }
.companion-preferences-body[data-pane="character"] :deep([data-preference-pane="character"]),
.companion-preferences-body[data-pane="companion"] :deep([data-preference-pane="companion"]),
.companion-preferences-body[data-pane="more"] :deep([data-preference-pane="more"]) { @apply tw:grid; }
.companion-preferences-body :deep(.companion-pop-group > strong) { padding: 0 4px 6px; @apply tw:text-secondary tw:text-label-sm tw:font-medium; }
.companion-preferences-body :deep(.companion-pop-item), .companion-preferences-body :deep(.appearance-entry) { @apply tw:flex tw:items-center tw:gap-[8px] tw:w-full tw:min-h-[44px] tw:m-0; padding: 8px 4px; border: 0; @apply tw:rounded-sm tw:text-primary; background: transparent; @apply tw:text-left; text-decoration: none; @apply tw:text-label-sm; }
.companion-preferences-body :deep(.companion-pop-item > svg), .companion-preferences-body :deep(.appearance-entry > svg) { @apply tw:w-[18px] tw:h-[18px] tw:text-accent; }
.companion-preferences-body :deep(.preference-chevron) { @apply tw:ml-auto; transform: rotate(-90deg); }
.companion-preferences-body :deep(button.companion-pop-item:hover), .companion-preferences-body :deep(.appearance-entry:hover) { background: var(--bg-hover); @apply tw:cursor-pointer; }
.companion-preferences-body :deep(.companion-pop-switch small) { @apply tw:block tw:mt-[2px] tw:text-secondary tw:text-label-xs; }
.companion-preferences-body :deep(.companion-pop-volume) { @apply tw:justify-between; }
.companion-preferences-body :deep(.companion-pop-volume input) { @apply tw:w-[55%] tw:h-[6px]; appearance: none; @apply tw:rounded-pill; background: var(--border-strong); accent-color: var(--accent); }
.companion-preferences-body :deep(.companion-pop-volume input::-webkit-slider-thumb) { appearance: none; @apply tw:w-[18px] tw:h-[18px]; border: 3px solid var(--bg-elevated); border-radius: 50%; background: var(--accent); @apply tw:cursor-grab; }
.companion-preferences-body :deep(.companion-pop-volume input::-moz-range-thumb) { @apply tw:w-[12px] tw:h-[12px]; border: 3px solid var(--bg-elevated); border-radius: 50%; background: var(--accent); @apply tw:cursor-grab; }
.companion-preferences-body :deep(.live2d-quality-control) { @apply tw:mt-s-3; }
.companion-preferences-body :deep(.live2d-quality-options) { @apply tw:rounded-md; background: var(--bg-elevated); }
.companion-preferences-body :deep(.live2d-quality-option[aria-checked="true"]) { @apply tw:border-accent; background: color-mix(in srgb, var(--accent) 12%, var(--bg-surface)); }
.companion-preferences-body :deep(.live2d-quality-option[aria-checked="true"] small) { @apply tw:text-secondary; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
