<template>
  <Teleport v-if="companion" to="body">
    <dialog ref="dialog" class="character-settings-dialog open-character-stage" :data-character="characterId" aria-label="角色取景与外观"
      @cancel.prevent.stop="close" @click="onBackdrop" @keydown.esc.stop>
      <header class="character-settings-heading">
        <h2>角色取景与外观</h2>
        <button type="button" class="character-settings-close" aria-label="关闭角色设置" autofocus @click="close"><ArchiveIcon name="close" /></button>
      </header>
      <div class="character-controls-panel"><slot /></div>
    </dialog>
  </Teleport>
  <details v-else ref="details" class="character-controls" @keydown.esc.stop="close">
    <summary><ArchiveIcon name="gear" /><span>角色设置</span></summary>
    <div class="character-controls-panel"><slot /></div>
  </details>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'

defineProps<{ companion: boolean; characterId: string }>()
const dialog = ref<HTMLDialogElement | null>(null)
const details = ref<HTMLDetailsElement | null>(null)
const fluid = useFluidDialog(dialog)
function open() {
  if (dialog.value) {
    const source = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // The menu item disappears when it opens this dialog; return to its persistent launcher.
    const launcher = source?.closest('.companion-page')?.querySelector<HTMLElement>('.companion-settings-btn')
    fluid.open(launcher ?? source)
  } else if (details.value) {
    details.value.open = true
    details.value.querySelector('summary')?.focus()
  }
}
function close() {
  if (dialog.value) fluid.close()
  else if (details.value) {
    details.value.open = false
    details.value.querySelector('summary')?.focus()
  }
}
function onBackdrop(event: MouseEvent) { if (isBackdropClick(event, dialog.value)) close() }
defineExpose({ open, close })
</script>

<style scoped>
.character-controls > summary { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-height: 32px; color: var(--text-primary); cursor: pointer; font-size: var(--fs-label-sm); list-style: none; }
.character-controls > summary svg { width: 16px; height: 16px; }
.character-controls-panel { position: absolute; z-index: var(--z-popover); left: 10px; right: 10px; bottom: calc(100% + 8px); max-height: min(450px, 65dvh); overflow-y: auto; padding: var(--s-3); border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--bg-elevated); box-shadow: var(--shadow-lg); }
.character-settings-dialog { box-sizing: border-box; width: min(440px, calc(100vw - 24px)); max-width: none; max-height: calc(100dvh - 24px); margin: auto; padding: 0; overflow: hidden; color: var(--text-primary); background: var(--bg-elevated); border: 1px solid var(--border-soft); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); }
.character-settings-dialog[open] { display: flex; flex-direction: column; }
.character-settings-dialog::backdrop { background: var(--art-backdrop); }
.character-settings-heading { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: var(--s-3); padding: var(--s-3); border-bottom: 1px solid var(--border-soft); }
.character-settings-heading h2 { margin: 0; font-size: var(--fs-body); line-height: var(--lh-body); }
.character-settings-close { display: grid; place-items: center; flex: 0 0 44px; height: 44px; border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--bg-surface); color: var(--text-primary); cursor: pointer; }
.character-settings-close svg { width: 18px; height: 18px; }
.character-settings-dialog .character-controls-panel { position: static; min-height: 0; max-height: none; overflow: auto; overscroll-behavior: contain; padding: var(--s-4); border: 0; border-radius: 0; box-shadow: none; }
.character-settings-dialog :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
