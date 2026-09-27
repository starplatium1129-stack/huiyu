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
    const launcher = document.querySelector<HTMLElement>('.orbit-settings-trigger')
      ?? source?.closest('.companion-page')?.querySelector<HTMLElement>('.companion-settings-btn')
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

<style scoped src="@/assets/css/components/CharacterStageSettings-0.css"></style>
