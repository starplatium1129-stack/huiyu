<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ToggleGroupItem, ToggleGroupRoot, type AcceptableValue } from 'reka-ui'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import { useDrawingNavigation } from '@/composables/prompt/useDrawingNavigation'
import { isActiveDrawEngine } from '@/storage/settingsRepository'

const props = defineProps<{
  modelValue: string
  disabled?: boolean
  animaDisabled?: boolean
  kreaDisabled?: boolean
  beforeSwitch?: () => Promise<boolean>
}>()
const emit = defineEmits<{ selectNative: [engine: 'anima' | 'krea2'] }>()
const navigation = useDrawingNavigation()
const switching = ref(false)
const field = ref<HTMLElement | null>(null)
function focusSelection() { field.value?.querySelector<HTMLButtonElement>('[data-engine][aria-pressed="true"]')?.focus({ preventScroll: true }) }
const options = computed(() => [
  ...(props.modelValue === 'sd' ? [{ value: 'sd', label: 'SD', name: 'SD · 历史配方', disabled: true }] : []),
  { value: 'anima', label: 'Anima', name: 'Anima · 动漫绘图', disabled: props.animaDisabled },
  { value: 'krea2', label: 'Krea 2', name: 'Krea 2 · 自然语言绘图', disabled: props.kreaDisabled },
  { value: 'moss', label: 'MOSS', name: 'MiaoMiao MOSS · 绘图' },
  { value: 'qwen', label: 'Qwen', name: 'Qwen · 文生图' },
])
async function select(value: AcceptableValue | AcceptableValue[]) {
  if (props.disabled || switching.value || navigation.importing.value || value === props.modelValue) return
  if (!isActiveDrawEngine(value) && value !== 'moss' && value !== 'qwen') return
  const ownedFocus = field.value?.contains(document.activeElement)
  switching.value = true
  try {
    if (props.beforeSwitch && !await props.beforeSwitch()) return
    if (isActiveDrawEngine(value)) {
      emit('selectNative', value)
      if (navigation.mode.value) await navigation.selectEngine(value)
    } else await navigation.selectEngine(value)
  } finally {
    switching.value = false
    await nextTick()
    if (ownedFocus && document.activeElement === document.body) focusSelection()
  }
}
</script>

<template>
  <div ref="field" class="drawing-engine-field">
    <span id="drawing-engine-label" class="drawing-engine-label">出图引擎</span>
    <ToggleGroupRoot id="drawing-engine" type="single" :model-value="modelValue" orientation="horizontal" aria-labelledby="drawing-engine-label"
      class="drawing-engine-switch studio-segments studio-segments--compact" data-fluid-glass data-segment-keyboard="managed"
      :disabled="disabled || switching || navigation.importing.value" @update:model-value="select">
      <AnimatedSelection />
      <ToggleGroupItem v-for="option in options" :key="option.value" :value="option.value" :data-engine="option.value" :disabled="option.disabled" :aria-label="option.name"><span class="studio-control-label">{{ option.label }}</span></ToggleGroupItem>
    </ToggleGroupRoot>
    <p v-if="navigation.error.value" class="drawing-engine-error" role="alert">{{ navigation.error.value }}</p>
  </div>
</template>

<style scoped>
.drawing-engine-field { display:grid; gap:var(--s-2); min-width:0; margin-bottom:var(--s-3); }
.drawing-engine-label { color:var(--text-primary); font-size:var(--fs-label); }
.drawing-engine-switch.studio-segments[role] > button { flex:1 1 0; min-width:0; }
.drawing-engine-error { margin:0; color:var(--danger-text); font-size:var(--fs-label-sm); overflow-wrap:anywhere; }
</style>
