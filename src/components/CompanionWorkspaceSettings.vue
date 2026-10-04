<template>
  <Teleport to="body">
    <dialog
      id="companion-workspace-settings"
      ref="dialogEl"
      class="companion-workspace-settings"
      aria-label="AI 工作区设置"
      aria-describedby="companion-workspace-description"
      @keydown.esc.stop
      @cancel.prevent.stop="close"
    >
      <div>
        <strong>AI 工作区</strong>
        <span id="companion-workspace-description">存放 ComfyUI、训练数据与配音资源的目录（例如 E:\AI）。保存后需完全退出并重启绘遇才生效，不会移动已有文件。</span>
      </div>
      <input
        ref="inputEl"
        autofocus
        :value="modelValue"
        :disabled="saving || picking"
        type="text"
        placeholder="目录路径"
        aria-label="AI 工作区目录路径"
        @input="emit('update:modelValue', inputValue($event))"
        @keydown.enter.prevent="save"
      />
      <span v-if="error || pickerError" role="alert">{{ error || pickerError }}</span>
      <div class="companion-workspace-actions">
        <button v-if="desktopBridge" type="button" class="btn btn-ghost" :disabled="saving || picking" @click="pickDirectory">
          {{ picking ? '选择中…' : '选择文件夹' }}
        </button>
        <button type="button" class="btn btn-primary" :disabled="saving || picking || !modelValue.trim()" @click="save">
          {{ saving ? '保存中…' : '保存目录' }}
        </button>
        <button type="button" class="btn btn-ghost" :disabled="saving" @click="close">关闭</button>
      </div>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { useFluidDialog } from '@/composables/useFluidDialog'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'

const props = defineProps<{
  open: boolean
  modelValue: string
  saving: boolean
  error?: string
  returnFocusEl?: HTMLElement | null
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'save'): void
  (event: 'update:modelValue', value: string): void
}>()

const desktopBridge = getDesktopCapabilities()
const picking = ref(false)
const pickerError = ref('')
let pickerRevision = 0
const dialogEl = ref<HTMLDialogElement | null>(null)
onUnmounted(registerMaintenanceParticipant(() => { if (props.open || props.saving || picking.value) throw new Error('OPEN_WORKSPACE_SETTINGS') }))
const inputEl = ref<HTMLInputElement | null>(null)
const fluid = useFluidDialog(dialogEl)
watch(() => props.open, (open) => {
  pickerRevision++
  pickerError.value = ''
  if (open) { fluid.open(props.returnFocusEl); inputEl.value?.focus() }
  else fluid.close()
}, { flush: 'post' })

onUnmounted(() => { pickerRevision++ })
function close() {
  if (props.saving) return
  pickerRevision++
  emit('close')
}
function save() {
  if (!props.saving && !picking.value && props.modelValue.trim()) emit('save')
}
async function pickDirectory() {
  if (!desktopBridge || picking.value || props.saving) return
  const revision = ++pickerRevision
  picking.value = true
  pickerError.value = ''
  try {
    const root = await desktopBridge.pickWorkspace(props.modelValue.trim())
    if (props.open && revision === pickerRevision && root !== null) emit('update:modelValue', root)
  } catch (error) {
    if (props.open && revision === pickerRevision) pickerError.value = error instanceof Error ? error.message : '目录选择失败，请重试或手动输入路径'
  } finally { picking.value = false }
}

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
