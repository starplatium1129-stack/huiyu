<template>
  <FluidTransition>
    <div
      v-if="open"
      id="companion-workspace-settings"
      ref="dialogEl"
      class="companion-workspace-settings"
      role="dialog"
      aria-modal="true"
      aria-label="AI 工作区设置"
      aria-describedby="companion-workspace-description"
      @keydown.esc.stop.prevent="emit('close')"
    >
      <div>
        <strong>AI 工作区</strong>
        <span id="companion-workspace-description">存放样张、训练数据与配音资源的目录（例如 E:\AI）。设置后网关重启生效。</span>
      </div>
      <input
        ref="inputEl"
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
    </div>
  </FluidTransition>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import FluidTransition from '@/components/visual/FluidTransition.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'

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

const dialogEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const { returnFocus } = useFocusTrap(dialogEl, () => props.open, { initialFocus: inputEl, onEscape: () => emit('close') })
watch(() => props.open, (open) => {
  if (open && props.returnFocusEl) returnFocus.value = props.returnFocusEl
}, { flush: 'post' })

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value
}
</script>
