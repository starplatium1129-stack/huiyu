<template>
  <Teleport v-if="desktop" to="body">
    <dialog ref="dialog" class="companion-preferences" :data-character="characterId" aria-label="桌宠设置"
      @cancel.prevent.stop="close" @click="backdrop" @keydown.esc.stop>
      <header class="preferences-heading"><div><h2>桌宠设置</h2><small>{{ characterName }}</small></div>
        <button type="button" aria-label="关闭桌宠设置" autofocus @click="close"><ArchiveIcon name="close" /></button>
      </header>
      <nav class="preferences-tabs" role="tablist" aria-label="设置分类" @keydown="tabKey">
        <button v-for="tab in tabs" :id="`${id}-${tab.value}`" :key="tab.value" type="button" role="tab"
          :aria-selected="pane === tab.value" :aria-controls="`${id}-panel`" :tabindex="pane === tab.value ? 0 : -1"
          @click="pane = tab.value"><ArchiveIcon :name="tab.icon" />{{ tab.label }}</button>
      </nav>
      <div :id="`${id}-panel`" class="companion-preferences-body" :data-pane="pane" role="tabpanel" :aria-labelledby="`${id}-${pane}`"><slot /></div>
    </dialog>
  </Teleport>
  <div v-else-if="open" class="companion-settings-popover" role="dialog" aria-label="桌宠设置" @pointerdown.stop><slot /></div>
</template>

<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
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
.companion-preferences { box-sizing: border-box; width: min(380px, calc(100vw - 24px)); max-height: min(540px, calc(100dvh - 24px)); margin: auto; padding: 0; overflow: hidden; color: var(--text-primary); background: var(--bg-elevated); border: 1px solid var(--border-strong); border-radius: var(--r-xl); box-shadow: var(--shadow-lg); }
.companion-preferences[open] { display: flex; flex-direction: column; }
.companion-preferences::backdrop { background: color-mix(in srgb, var(--bg-deep) 24%, transparent); }
.preferences-heading { display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; padding: var(--s-3) var(--s-4); }
.preferences-heading > div { display: grid; gap: 4px; }
.preferences-heading small { color: var(--text-secondary); font-size: var(--fs-label-sm); }
h2 { margin: 0; font-size: var(--fs-body); font-weight: 650; }
.preferences-heading button { display: grid; place-items: center; width: 40px; height: 40px; border: 1px solid var(--border-soft); border-radius: 50%; color: var(--text-primary); background: var(--bg-surface); cursor: pointer; }
.preferences-heading svg { width: 18px; height: 18px; }
.preferences-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); flex: 0 0 auto; gap: 4px; margin: 0 var(--s-4) var(--s-3); padding: 4px; border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-surface); }
.preferences-tabs button { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; padding: 4px; border: 1px solid transparent; border-radius: var(--r-md); background: transparent; color: var(--text-secondary); font-size: var(--fs-label-sm); cursor: pointer; }
.preferences-tabs button[aria-selected="true"] { color: var(--text-primary); background: color-mix(in srgb, var(--accent) 12%, var(--bg-elevated)); border-color: var(--accent); }
.preferences-tabs svg { width: 17px; height: 17px; }
.companion-preferences-body { display: grid; gap: var(--s-3); min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 0 var(--s-4) var(--s-4); scrollbar-width: thin; }
.companion-preferences-body :deep(.companion-pop-group) { display: none; gap: 4px; padding: var(--s-3); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg-surface); }
.companion-preferences-body[data-pane="character"] :deep([data-preference-pane="character"]),
.companion-preferences-body[data-pane="companion"] :deep([data-preference-pane="companion"]),
.companion-preferences-body[data-pane="more"] :deep([data-preference-pane="more"]) { display: grid; }
.companion-preferences-body :deep(.companion-pop-group > strong) { padding: 0 4px 6px; color: var(--text-secondary); font-size: var(--fs-label-sm); font-weight: 500; }
.companion-preferences-body :deep(.companion-pop-item), .companion-preferences-body :deep(.appearance-entry) { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; margin: 0; padding: 8px 4px; border: 0; border-radius: var(--r-sm); color: var(--text-primary); background: transparent; text-align: left; text-decoration: none; font-size: var(--fs-label-sm); }
.companion-preferences-body :deep(.companion-pop-item > svg), .companion-preferences-body :deep(.appearance-entry > svg) { width: 18px; height: 18px; color: var(--accent); }
.companion-preferences-body :deep(.preference-chevron) { margin-left: auto; transform: rotate(-90deg); }
.companion-preferences-body :deep(button.companion-pop-item:hover), .companion-preferences-body :deep(.appearance-entry:hover) { background: var(--bg-hover); cursor: pointer; }
.companion-preferences-body :deep(.companion-pop-switch small) { display: block; margin-top: 2px; color: var(--text-secondary); font-size: var(--fs-label-xs); }
.companion-preferences-body :deep(.companion-pop-volume) { justify-content: space-between; }
.companion-preferences-body :deep(.companion-pop-volume input) { width: 55%; height: 6px; appearance: none; border-radius: var(--r-pill); background: var(--border-strong); accent-color: var(--accent); }
.companion-preferences-body :deep(.companion-pop-volume input::-webkit-slider-thumb) { appearance: none; width: 18px; height: 18px; border: 3px solid var(--bg-elevated); border-radius: 50%; background: var(--accent); cursor: grab; }
.companion-preferences-body :deep(.companion-pop-volume input::-moz-range-thumb) { width: 12px; height: 12px; border: 3px solid var(--bg-elevated); border-radius: 50%; background: var(--accent); cursor: grab; }
.companion-preferences-body :deep(.live2d-quality-control) { margin-top: var(--s-3); }
.companion-preferences-body :deep(.live2d-quality-options) { border-radius: var(--r-md); background: var(--bg-elevated); }
.companion-preferences-body :deep(.live2d-quality-option[aria-checked="true"]) { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--bg-surface)); }
.companion-preferences-body :deep(.live2d-quality-option[aria-checked="true"] small) { color: var(--text-secondary); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
