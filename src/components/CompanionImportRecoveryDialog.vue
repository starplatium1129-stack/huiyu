<template>
  <button v-if="visible" type="button" :class="compact ? undefined : 'companion-chat-chip'" :aria-label="label"
    :title="label" aria-haspopup="dialog" :aria-expanded="open" @click="open = true">
    <ArchiveIcon name="image" /><span v-if="!compact">{{ label }}</span>
  </button>
  <Teleport to="body">
    <!-- Nested confirmation owns Escape before the native dialog's cancel event. -->
    <dialog ref="dialog" class="companion-import-dialog" :data-character="characterId" aria-label="图片导入恢复"
      @cancel.prevent.stop="close" @click="backdrop">
      <header class="companion-import-heading">
        <h2>图片导入恢复</h2>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="关闭图片导入恢复" autofocus @click="close"><ArchiveIcon name="close" /></button>
      </header>
      <div class="companion-import-body">
        <CompanionImportRecovery :recovery="recovery" />
        <p v-if="!status.items.length && !status.error && !recovery.feedback.value" class="companion-import-empty">当前没有待确认的图片导入。</p>
      </div>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import CompanionImportRecovery from './CompanionImportRecovery.vue'
import { isBackdropClick, useFluidDialog } from '../composables/useFluidDialog'
import type { LocalImageImportRecovery } from '../composables/useLocalImageImportRecovery'
const props = defineProps<{ recovery: LocalImageImportRecovery; characterId: string; compact?: boolean }>()
const open = ref(false), revealed = ref(false), dialog = ref<HTMLDialogElement | null>(null)
const status = computed(() => props.recovery.status.value)
const visible = computed(() => Boolean(revealed.value || status.value.items.length || status.value.error || props.recovery.feedback.value))
const label = computed(() => status.value.items.length ? `导入待确认 · ${status.value.items.length}` : status.value.error ? '导入待确认' : '导入结果')
const fluid = useFluidDialog(dialog)
watch(open, value => { if (value) { revealed.value = true; fluid.open() } else fluid.close() }, { flush: 'post' })
onDeactivated(close)
onBeforeUnmount(() => props.recovery.cancelInteraction())
function close() { props.recovery.cancelInteraction(); open.value = false }
function backdrop(event: MouseEvent) { if (isBackdropClick(event, dialog.value)) close() }
</script>

<style scoped>
.companion-import-dialog { box-sizing:border-box; width:min(420px, calc(100vw - 24px)); max-height:calc(100dvh - 24px); margin:auto; padding:0; overflow:hidden; color:var(--text-primary); background:var(--bg-elevated); border:1px solid var(--border-strong); border-radius:var(--r-xl); box-shadow:var(--shadow-lg); }
.companion-import-dialog[open] { display:flex; flex-direction:column; }
.companion-import-dialog::backdrop { background:color-mix(in srgb, var(--bg-deep) 24%, transparent); }
.companion-import-heading { display:flex; flex:0 0 auto; align-items:center; justify-content:space-between; gap:var(--s-3); padding:var(--s-3) var(--s-4); }
.companion-import-heading h2 { margin:0; font-size:var(--fs-body); }
.companion-import-heading button { min-width:40px; min-height:40px; }
.companion-import-heading svg { width:20px; height:20px; }
.companion-import-body { min-height:0; overflow:auto; overscroll-behavior:contain; padding-bottom:var(--s-4); }
.companion-import-body :deep(.companion-import-recovery) { margin-top:0; }
.companion-import-empty { margin:0 var(--s-4); color:var(--text-secondary); font-size:var(--fs-label); }
</style>
