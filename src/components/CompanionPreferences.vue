<template>
  <Teleport v-if="desktop" to="body">
    <dialog ref="dialog" class="companion-preferences" :data-character="characterId" aria-label="桌宠设置"
      @cancel.prevent.stop="close" @click="backdrop" @keydown.esc.stop>
      <header><div><small>陪伴偏好</small><h2>桌宠设置</h2></div>
        <button type="button" aria-label="关闭桌宠设置" autofocus @click="close"><ArchiveIcon name="close" /></button>
      </header>
      <div class="companion-preferences-body"><slot /></div>
    </dialog>
  </Teleport>
  <div v-else-if="open" class="companion-settings-popover" role="dialog" aria-label="桌宠设置" @pointerdown.stop><slot /></div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
const props = defineProps<{ open: boolean; desktop: boolean; characterId: string }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const fluid = useFluidDialog(dialog)
watch(() => props.open, value => {
  if (!props.desktop) return
  if (value) fluid.open(document.querySelector<HTMLElement>('.companion-orbit .companion-settings-btn'))
  else fluid.close()
}, { flush: 'post' })
function close() { emit('update:open', false) }
function backdrop(event: MouseEvent) { if (isBackdropClick(event, dialog.value)) close() }
</script>

<style scoped>
.companion-preferences { width: min(400px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); margin: auto; padding: 0; overflow: hidden; color: var(--text-primary); background: var(--bg-elevated); border: 1px solid var(--border-soft); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); }
.companion-preferences[open] { display: flex; flex-direction: column; }
.companion-preferences::backdrop { background: var(--art-backdrop); }
header { display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; padding: var(--s-4); border-bottom: 1px solid var(--border-soft); }
header small { color: var(--text-secondary); font-size: var(--fs-label-sm); }
h2 { margin: var(--s-1) 0 0; font-size: var(--fs-title-sm); }
header button { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid var(--border-soft); border-radius: var(--r-md); color: var(--text-primary); background: var(--bg-surface); cursor: pointer; }
.companion-preferences-body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: var(--s-4); }
.companion-preferences-body :deep(.companion-pop-item) { color: var(--text-primary); min-height: 44px; }
.companion-preferences-body :deep(.companion-pop-group > strong) { color: var(--text-secondary); }
.companion-preferences-body :deep(.companion-pop-group) { display: grid; gap: 4px; padding-block: var(--s-3); }
.companion-preferences-body :deep(.companion-pop-group + .companion-pop-group) { border-top: 1px solid var(--border-soft); }
.companion-preferences-body :deep(.companion-pop-item) { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; border: 0; border-radius: var(--r-sm); background: transparent; text-align: left; text-decoration: none; font-size: var(--fs-label-sm); }
.companion-preferences-body :deep(button.companion-pop-item:hover) { background: var(--bg-hover); cursor: pointer; }
.companion-preferences-body :deep(.companion-pop-volume) { justify-content: space-between; }
.companion-preferences-body :deep(.companion-pop-volume input) { width: 55%; height: 6px; appearance: none; border-radius: var(--r-pill); background: var(--border-strong); accent-color: var(--accent); }
.companion-preferences-body :deep(.companion-pop-volume input::-webkit-slider-thumb) { appearance: none; width: 18px; height: 18px; border: 3px solid var(--bg-elevated); border-radius: 50%; background: var(--accent); cursor: grab; }
.companion-preferences-body :deep(.companion-pop-volume input::-moz-range-thumb) { width: 12px; height: 12px; border: 3px solid var(--bg-elevated); border-radius: 50%; background: var(--accent); cursor: grab; }
.companion-preferences-body :deep(.companion-pop-group > strong) { padding-inline: 8px; font-size: var(--fs-label-sm); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
