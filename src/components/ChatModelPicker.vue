<script setup lang="ts">
import { computed, onDeactivated, ref, watch } from 'vue'
import { ComboboxAnchor, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxItemIndicator,
  ComboboxPortal, ComboboxRoot, ComboboxTrigger, ComboboxViewport } from 'reka-ui'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import '@/assets/css/components/ui/StudioSelect-0.css'

const props = withDefaults(defineProps<{
  options: readonly { value: string; label: string }[]
  label: string
  placeholder?: string
  disabled?: boolean
  allowCustom?: boolean
}>(), { placeholder: '搜索并选择模型', disabled: false, allowCustom: false })
const value = defineModel<string>({ required: true })
const open = ref(false)
const root = ref<HTMLElement>()
const portalTarget = computed(() => root.value?.closest('dialog, [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]') as HTMLElement || undefined)
const customValue = computed(() => props.allowCustom && value.value.trim()
  && !props.options.some(option => option.value === value.value.trim()) ? value.value.trim() : '')
function displayValue(selected: unknown) {
  return props.options.find(option => option.value === selected)?.label ?? (typeof selected === 'string' ? selected : '')
}
function onInput(event: Event) {
  if (props.allowCustom && !(event as InputEvent).isComposing) value.value = (event.target as HTMLInputElement).value.trim()
}
function onEscape(event: KeyboardEvent) {
  if (!open.value || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  open.value = false
}
function onDismissEscape(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) event.preventDefault()
}
onDeactivated(() => { open.value = false })
watch(() => props.disabled, disabled => { if (disabled) open.value = false })
</script>

<template>
  <div ref="root" class="chat-model-picker" @keydown.esc.capture="onEscape">
    <ComboboxRoot v-model="value" v-model:open="open" :disabled="disabled" :open-on-click="true">
      <ComboboxAnchor class="studio-select-trigger chat-model-picker-anchor" :data-disabled="disabled ? '' : undefined" data-fluid-glass>
        <ComboboxInput class="chat-model-picker-input" :display-value="displayValue" :aria-label="label"
          :placeholder="placeholder" :disabled="disabled" maxlength="200" spellcheck="false" @input="onInput" />
        <ComboboxTrigger class="chat-model-picker-trigger" :aria-label="`展开${label}`" :disabled="disabled">
          <ArchiveIcon name="chevron-down" class="studio-select-icon" />
        </ComboboxTrigger>
      </ComboboxAnchor>
      <ComboboxPortal :to="portalTarget">
        <ComboboxContent class="studio-select-content chat-model-picker-content" position="popper" align="start" :side-offset="6" :collision-padding="12" data-fluid-glass
          @keydown.esc.capture="onEscape" @escape-key-down="onDismissEscape">
          <ComboboxViewport class="studio-select-viewport">
            <ComboboxEmpty class="chat-model-picker-empty">{{ allowCustom ? '可直接输入模型名' : '没有匹配的模型' }}</ComboboxEmpty>
            <ComboboxItem v-for="option in options" :key="option.value" :value="option.value" class="studio-select-item">
              <span class="studio-select-item-text">{{ option.label }}</span>
              <ComboboxItemIndicator class="studio-select-check"><ArchiveIcon name="success" /></ComboboxItemIndicator>
            </ComboboxItem>
            <ComboboxItem v-if="customValue" :value="customValue" class="studio-select-item">
              <span class="studio-select-item-text">使用「{{ customValue }}」</span>
              <ComboboxItemIndicator class="studio-select-check"><ArchiveIcon name="success" /></ComboboxItemIndicator>
            </ComboboxItem>
          </ComboboxViewport>
        </ComboboxContent>
      </ComboboxPortal>
    </ComboboxRoot>
  </div>
</template>

<style scoped>
.chat-model-picker { width:100%; min-width:0; }
.chat-model-picker-anchor { padding:0 var(--s-2) 0 var(--s-3); min-height:var(--control-height); cursor:text; }
.chat-model-picker-anchor:focus-within { border-color:var(--border-strong); outline:none; box-shadow:var(--focus-shadow); }
.chat-model-picker .chat-model-picker-input { flex:1; width:100%; min-width:0; min-height:0; height:calc(var(--control-height) - 2px); padding:0; border:0; border-radius:0; background:transparent; color:var(--text-primary); font:inherit; }
.chat-model-picker .chat-model-picker-input:focus { outline:none; box-shadow:none; }
.chat-model-picker .chat-model-picker-input:disabled { color:var(--text-disabled); }
.chat-model-picker-input::placeholder { color:var(--text-secondary); }
.chat-model-picker-trigger { display:grid; place-items:center; flex:0 0 32px; width:32px; min-height:32px; padding:0; border:0; background:transparent; color:var(--text-secondary); cursor:pointer; }
.chat-model-picker-trigger:focus-visible { outline:none; box-shadow:var(--focus-shadow); border-radius:var(--r-sm); }
.chat-model-picker-trigger[aria-expanded='true'] .studio-select-icon { transform:rotate(180deg); }
.chat-model-picker-trigger:disabled { color:var(--text-disabled); cursor:not-allowed; }
@media (pointer:coarse) {
  /* The input and trigger keep 44px targets inside the 1px control frame. */
  .chat-model-picker-anchor { min-height:calc(44px + 2px); }
  .chat-model-picker .chat-model-picker-input { height:44px; }
  .chat-model-picker-trigger { flex-basis:44px; width:44px; min-height:44px; }
}
</style>

<style>
/* Reka's portalled content does not retain the root component's scoped attribute. */
.studio-select-content.chat-model-picker-content { width:var(--reka-combobox-trigger-width); --reka-select-content-available-height:var(--reka-combobox-content-available-height,320px); --reka-select-content-transform-origin:var(--reka-combobox-content-transform-origin); }
.chat-model-picker-content .chat-model-picker-empty { padding:var(--s-3); color:var(--text-secondary); font-size:var(--fs-label-sm); }
</style>
