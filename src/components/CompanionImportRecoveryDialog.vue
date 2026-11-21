<template>
  <StudioTooltip v-if="visible" :content="compact ? label : null">
    <button
      type="button"
      :class="compact ? undefined : 'companion-chat-chip'"
      :aria-label="label"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="openDialog"
    >
      <ArchiveIcon name="image" /><span v-if="!compact">{{ label }}</span>
    </button>
  </StudioTooltip>
  <StudioDialog
    v-model:open="open"
    title="图片导入恢复"
    size="sm"
    :character="characterId"
    close-label="关闭图片导入恢复"
    close-autofocus
    dialog-class="companion-import-dialog"
    @close="onClosed"
  >
    <div class="companion-import-body">
      <CompanionImportRecovery :recovery="recovery" />
      <p v-if="!status.items.length && !status.error && !recovery.feedback.value" class="companion-import-empty">当前没有待确认的图片导入。</p>
    </div>
  </StudioDialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, ref } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import StudioDialog from '@/components/ui/StudioDialog.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import CompanionImportRecovery from './CompanionImportRecovery.vue'
import type { LocalImageImportRecovery } from '../composables/useLocalImageImportRecovery'

const props = defineProps<{ recovery: LocalImageImportRecovery; characterId: string; compact?: boolean }>()
const open = ref(false), revealed = ref(false)
const status = computed(() => props.recovery.status.value)
const visible = computed(() => Boolean(revealed.value || status.value.items.length || status.value.error || props.recovery.feedback.value))
const label = computed(() => status.value.items.length ? `导入待确认 · ${status.value.items.length}` : status.value.error ? '导入待确认' : '导入结果')

function openDialog() {
  revealed.value = true
  open.value = true
}
function onClosed() {
  props.recovery.cancelInteraction()
}
function close() {
  props.recovery.cancelInteraction()
  open.value = false
}
onDeactivated(close)
onBeforeUnmount(() => props.recovery.cancelInteraction())
</script>

<style scoped>
.companion-import-body :deep(.companion-import-recovery) { margin: 0; }
.companion-import-empty { margin: 0; color: var(--text-secondary); font-size: var(--fs-label); }
</style>
