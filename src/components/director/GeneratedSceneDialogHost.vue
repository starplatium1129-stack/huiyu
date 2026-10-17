<template>
  <Teleport to="body">
    <dialog ref="dialog" class="generated-scene-loading-dialog" aria-labelledby="generated-scene-loading-title" @cancel.prevent="cancel()" @close="onClosed" @click="backdropClose">
      <header><h2 id="generated-scene-loading-title"><ArchiveIcon name="image" />保存为场景</h2><button class="btn btn-ghost btn-icon" type="button" aria-label="取消保存为场景" autofocus @click="cancel()"><ArchiveIcon name="close" /></button></header>
      <AsyncPanel class="generated-scene-loading-body" :loader="loadDialog" label="保存场景窗口" v-slot="{ component }">
        <component v-if="handedOff && !closed && route.path === initialPath" :is="component" :source="source" @close="emit('close')" />
      </AsyncPanel>
      <footer><button class="btn btn-ghost" type="button" @click="cancel()">取消</button></footer>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import AsyncPanel from '@/components/ui/AsyncPanel.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import type { GeneratedSceneCapture } from '@/composables/prompt/useGeneratedSceneCapture'

defineProps<{ source: GeneratedSceneCapture }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null), closed = ref(false)
const motion = useFluidDialog(dialog), route = useRoute()
const initialPath = route.path
const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
let handedOff = false, disposed = false
async function loadDialog() {
  const module = await import('@/components/maintenance/GeneratedSceneDialog.vue')
  if (!disposed && !closed.value && route.path === initialPath) {
    // The loaded form teleports its own modal. Release native focus and scroll
    // ownership before AsyncPanel mounts that form and its focus trap.
    handedOff = true
    motion.close()
  }
  return module
}
function cancel(restoreFocus = true) {
  if (closed.value || handedOff || disposed) return
  closed.value = true
  if (restoreFocus) motion.close()
  else motion.dispose()
  emit('close')
}
function onClosed() { if (!handedOff) cancel() }
function backdropClose(event: MouseEvent) { if (isBackdropClick(event, dialog.value)) cancel() }
watch(() => route.path, () => { if (!handedOff) cancel(false) }, { flush: 'sync' })
onMounted(() => { if (!closed.value) motion.open(origin) })
onDeactivated(() => { if (!handedOff) cancel(false) })
onBeforeUnmount(() => { disposed = true })
</script>

<style scoped>
.generated-scene-loading-dialog { position:fixed; inset:var(--desktop-chrome-height,0px) 0 0; width:min(620px,calc(100vw - 32px)); max-height:calc(100dvh - var(--desktop-chrome-height,0px) - 32px); margin:auto; padding:0; overflow:hidden; border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); color:var(--text-primary); box-shadow:var(--shadow-lg); }
.generated-scene-loading-dialog[open] { display:flex; flex-direction:column; }
.generated-scene-loading-dialog::backdrop { background:var(--art-scrim); }
header, footer { display:flex; align-items:center; gap:var(--s-3); flex-shrink:0; padding:var(--s-4); }
header { justify-content:space-between; border-bottom:1px solid var(--border-soft); }
h2 { display:flex; align-items:center; gap:var(--s-2); margin:0; font:600 var(--fs-title-sm)/var(--lh-tight) var(--font-display); }
h2 .archive-icon { color:var(--accent); }
.generated-scene-loading-body { min-height:0; padding:var(--s-4); overflow:auto; overscroll-behavior:contain; }
footer { justify-content:flex-end; border-top:1px solid var(--border-soft); }
</style>
