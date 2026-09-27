<template>
  <Teleport to="body">
    <dialog
      id="companion-workspace-settings"
      ref="dialogEl"
      class="companion-workspace-settings"
      aria-label="AI 工作区设置"
      aria-describedby="companion-workspace-description"
      @keydown.esc.stop
      @cancel.prevent.stop="emit('close')"
    >
      <div>
        <strong>AI 工作区</strong>
        <span id="companion-workspace-description">存放样张、训练数据与配音资源的目录（例如 E:\AI）。设置后网关重启生效。</span>
      </div>
      <input
        ref="inputEl"
        autofocus
        :value="modelValue"
        type="text"
        placeholder="目录路径"
        aria-label="AI 工作区目录路径"
        @input="emit('update:modelValue', inputValue($event))"
        @keydown.enter="emit('save')"
      />
      <div class="companion-workspace-actions">
        <button type="button" class="btn btn-primary" :disabled="saving" @click="emit('save')">
          {{ saving ? '保存中…' : '保存并重启网关' }}
        </button>
        <button type="button" class="btn btn-ghost" @click="emit('close')">关闭</button>
      </div>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { useFluidDialog } from '@/composables/useFluidDialog'

const props = defineProps<{
  open: boolean
  modelValue: string
  saving: boolean
  returnFocusEl?: HTMLElement | null
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'save'): void
  (event: 'update:modelValue', value: string): void
}>()

const dialogEl = ref<HTMLDialogElement | null>(null)
onUnmounted(registerMaintenanceParticipant(() => { if (props.open || props.saving) throw new Error('OPEN_WORKSPACE_SETTINGS') }))
const inputEl = ref<HTMLInputElement | null>(null)
const fluid = useFluidDialog(dialogEl)
watch(() => props.open, (open) => {
  if (open) { fluid.open(props.returnFocusEl); inputEl.value?.focus() }
  else fluid.close()
}, { flush: 'post' })

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value
}
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.companion-workspace-settings { @apply tw:box-border; width: min(420px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); @apply tw:p-s-4 tw:m-auto tw:overflow-auto tw:text-primary; background: var(--bg-elevated); border: 1px solid var(--border-soft); @apply tw:rounded-lg; box-shadow: var(--shadow-lg); }
.companion-workspace-settings[open] { @apply tw:grid tw:gap-s-4; }
.companion-workspace-settings::backdrop { background: var(--art-backdrop); }
.companion-workspace-settings > div:first-child { @apply tw:grid tw:gap-s-2; }
.companion-workspace-settings span { @apply tw:text-label-sm tw:text-secondary tw:leading-body; }
input { @apply tw:w-full tw:min-w-0 tw:min-h-[44px] tw:p-s-2; border: 1px solid var(--border-strong); @apply tw:rounded-sm tw:text-primary; background: var(--bg-surface); }
.companion-workspace-actions { @apply tw:flex tw:flex-wrap tw:gap-s-2; }
</style>
