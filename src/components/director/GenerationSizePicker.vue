<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import StudioSelect, { type StudioSelectGroup } from '@/components/ui/StudioSelect.vue'
import { validCustomSize } from '@/composables/generation/animaSessionContract'
import type { AnimaSizeLimits } from '@/types/anima'
const props = defineProps<{ engine: string; size: string; animaSizes: string[]; busy: boolean; compact?: boolean; customSize?: AnimaSizeLimits }>()
const emit = defineEmits<{ 'update:size': [value: string] }>()
const sizeGroups: StudioSelectGroup[] = [
  { label: '竖图 Portrait', options: [
    { value: '768x1344', label: '768×1344' },
    { value: '832x1216', label: '832×1216' },
    { value: '896x1344', label: '896×1344' },
    { value: '1024x1344', label: '1024×1344 · WAI 推荐' },
    { value: '1024x1536', label: '1024×1536' },
    { value: '1152x1536', label: '1152×1536' },
  ] },
  { label: '方图 Square', options: [
    { value: '896x896', label: '896×896' },
    { value: '1024x1024', label: '1024×1024' },
    { value: '1280x1280', label: '1280×1280' },
  ] },
  { label: '横图 Landscape', options: [
    { value: '1216x832', label: '1216×832' },
    { value: '1344x896', label: '1344×896' },
    { value: '1536x1024', label: '1536×1024' },
  ] },
  { label: '16:9 官方 CG', options: [
    { value: '1344x768', label: '1344×768' },
  ] },
]
const mossSizeLabels: Record<string, string> = {
  '768x1280': '标准竖幅',
  '1280x768': '标准横幅',
  '1280x1280': '标准方形',
  '960x1536': '大尺寸竖幅',
  '1536x960': '大尺寸横幅',
  '1536x1536': '大尺寸方形',
}
const cards = computed(() => props.animaSizes.map(value => {
  const [width, height] = value.split('x').map(Number)
  const shape = width === height ? '方形' : width < height ? '竖幅' : '横幅'
  return { value, label: props.engine === 'moss' ? mossSizeLabels[value] || shape : shape, ratio: width / height }
}))
const sizeOptions = computed(() => cards.value.map(({ value, label }) => ({ value,
  label: props.engine === 'moss' ? `${label} · ${value.replace('x', ' × ')}` : value.replace('x', ' × '),
})))
function change(value: string | number) { if (value !== '') emit('update:size', String(value)) }

const fieldId = useId()
const customOpen = ref(false)
const customWidth = ref<number | string>('')
const customHeight = ref<number | string>('')
const attempted = ref(false)
const validSize = computed(() => !!props.customSize && validCustomSize(Number(customWidth.value), Number(customHeight.value), props.customSize))
const showError = computed(() => attempted.value && !validSize.value)
watch(() => props.busy || !props.customSize, blocked => { if (blocked) customOpen.value = false })

function openCustom(open: boolean) {
  if (open) {
    const [width, height] = props.size.split('x').map(Number)
    customWidth.value = width
    customHeight.value = height
    attempted.value = false
  }
  customOpen.value = open
}

function applyCustom() {
  if (props.busy) return
  attempted.value = true
  if (!validSize.value) return
  change(`${customWidth.value}x${customHeight.value}`)
  customOpen.value = false
}
</script>
<template>
  <div class="generation-size-picker" :class="{ 'is-compact': compact }" role="group" aria-label="画幅比例">
    <div class="size-picker-heading">
      <strong>画幅</strong>
      <div class="size-picker-heading-right">
        <span class="size-picker-current">{{ size.replace('x', ' × ') }}</span>
        <StudioPopover v-if="customSize && !compact" label="自定义画幅" :open="customOpen" side="bottom" @update:open="openCustom">
          <template #trigger>
            <button type="button" class="btn btn-quiet btn-sm size-picker-custom" aria-label="自定义画幅" :disabled="busy">自定义</button>
          </template>
          <form class="size-picker-form" novalidate @submit.prevent="applyCustom">
            <div class="size-picker-fields">
              <label :for="fieldId + '-width'">宽度（px）
                <input :id="fieldId + '-width'" v-model.number="customWidth" class="input" type="number" inputmode="numeric"
                  :min="customSize.min" :max="customSize.max" :step="customSize.step" :aria-invalid="showError || undefined"
                  :aria-describedby="fieldId + '-help'">
              </label>
              <label :for="fieldId + '-height'">高度（px）
                <input :id="fieldId + '-height'" v-model.number="customHeight" class="input" type="number" inputmode="numeric"
                  :min="customSize.min" :max="customSize.max" :step="customSize.step" :aria-invalid="showError || undefined"
                  :aria-describedby="fieldId + '-help'">
              </label>
            </div>
            <p :id="fieldId + '-help'">每边 {{ customSize.min }}–{{ customSize.max }} px，为 {{ customSize.step }} 的倍数，总面积最多 {{ customSize.maxPixels.toLocaleString('zh-CN') }} 像素。</p>
            <p v-if="showError" class="size-picker-error" role="alert">宽度或高度超出画幅范围，请调整后应用。</p>
            <button type="submit" class="btn btn-primary" :disabled="busy">应用尺寸</button>
          </form>
        </StudioPopover>
      </div>
    </div>
    <StudioSelect v-if="compact || engine === 'sd'" label="画幅比例" :model-value="size" :disabled="busy"
      :groups="engine === 'sd' ? sizeGroups : undefined" :options="engine === 'sd' ? undefined : sizeOptions" @update:model-value="change" />
    <div v-else class="size-picker-grid">
      <button v-for="card in cards" :key="card.value" type="button" class="size-ratio-chip" data-spring-button :aria-pressed="size === card.value" :disabled="busy" @click="change(card.value)">
        <i :style="{ aspectRatio: card.ratio }" data-press-content aria-hidden="true"></i>
        <span class="size-chip-copy">
          <span class="size-chip-label">{{ card.label }}</span>
          <small class="size-chip-res">{{ card.value.replace('x', '×') }}</small>
        </span>
        <ArchiveIcon v-if="size === card.value" name="success" class="size-chip-check" />
      </button>
    </div>
    <StudioPopover v-if="customSize && compact" label="自定义画幅" :open="customOpen" side="top" @update:open="openCustom">
      <template #trigger>
        <button type="button" class="btn btn-quiet size-picker-custom" aria-label="自定义画幅" :disabled="busy">自定义</button>
      </template>
      <form class="size-picker-form" novalidate @submit.prevent="applyCustom">
        <div class="size-picker-fields">
          <label :for="fieldId + '-width'">宽度（px）
            <input :id="fieldId + '-width'" v-model.number="customWidth" class="input" type="number" inputmode="numeric"
              :min="customSize.min" :max="customSize.max" :step="customSize.step" :aria-invalid="showError || undefined"
              :aria-describedby="fieldId + '-help'">
          </label>
          <label :for="fieldId + '-height'">高度（px）
            <input :id="fieldId + '-height'" v-model.number="customHeight" class="input" type="number" inputmode="numeric"
              :min="customSize.min" :max="customSize.max" :step="customSize.step" :aria-invalid="showError || undefined"
              :aria-describedby="fieldId + '-help'">
          </label>
        </div>
        <p :id="fieldId + '-help'">每边 {{ customSize.min }}–{{ customSize.max }} px，为 {{ customSize.step }} 的倍数，总面积最多 {{ customSize.maxPixels.toLocaleString('zh-CN') }} 像素。</p>
        <p v-if="showError" class="size-picker-error" role="alert">宽度或高度超出画幅范围，请调整后应用。</p>
        <button type="submit" class="btn btn-primary" :disabled="busy">应用尺寸</button>
      </form>
    </StudioPopover>
  </div>
</template>
<style scoped>
.generation-size-picker { min-width:0; }
.size-picker-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-2); margin-bottom:var(--s-2); }
.size-picker-heading strong { font-size:var(--fs-label); font-weight:600; color:var(--text-primary); }
.size-picker-heading-right { display:inline-flex; align-items:center; gap:var(--s-2); }
.size-picker-current { font:400 var(--fs-label-xs)/var(--lh-label) var(--font-mono); color:var(--text-secondary); }
.size-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.5rem), 1fr));
  gap: var(--s-2);
}
.size-ratio-chip {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 13px;
  align-items: center;
  gap: var(--s-1);
  min-inline-size: 0;
  min-block-size: var(--control-height);
  padding: var(--s-1) var(--s-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  color: var(--text-secondary);
  background: var(--bg-base);
  font: 500 var(--fs-label-xs)/var(--lh-label) var(--font-sans);
  text-align: start;
  cursor: pointer;
}
.size-ratio-chip[aria-pressed='true'] { color:var(--text-primary); border-color:var(--border-strong); background:var(--bg-elevated); box-shadow:var(--shadow-sm); }
.size-ratio-chip:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.size-ratio-chip:disabled { color:var(--text-disabled); cursor:not-allowed; }
.size-ratio-chip i { justify-self:center; block-size:14px; max-inline-size:18px; border:1.35px solid currentColor; border-radius:2px; }
.size-chip-copy { display:grid; min-inline-size:0; overflow-wrap:anywhere; }
.size-chip-label { font-weight:600; }
.size-chip-res { color:var(--text-secondary); font:400 var(--fs-mono-xs)/var(--lh-label) var(--font-mono); font-variant-numeric:tabular-nums; }
.size-ratio-chip:disabled .size-chip-res { color:inherit; }
.size-chip-check { inline-size:100%; block-size:auto; }
.size-picker-custom { min-height:28px; padding:2px var(--s-2); font-size:var(--fs-label-xs); flex-shrink:0; white-space:nowrap; }
.size-picker-form { display:grid; gap:var(--s-3); }
.size-picker-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-3); }
.size-picker-fields label { display:grid; gap:var(--s-1); font-size:var(--fs-label); }
.size-picker-fields input { min-width:0; width:100%; }
.size-picker-form p { margin:0; font-size:var(--fs-label-xs); line-height:var(--lh-body); color:var(--text-secondary); }
.size-picker-form .size-picker-error { color:var(--danger); }
.size-picker-form button { justify-self:end; }
.is-compact { display:flex; align-items:center; gap:var(--s-3); }
.is-compact .size-picker-custom { margin:0; }
.is-compact .size-picker-heading { margin:0; }
.is-compact .size-picker-heading-right { display:none; }
.is-compact .studio-select-wrapper { flex:1; min-width:0; }
@media (hover:hover) and (pointer:fine) { .size-ratio-chip:hover:not(:disabled) { border-color:var(--border-strong); background:var(--bg-hover); } }
@media (forced-colors:active) { .size-ratio-chip[aria-pressed='true'] { outline:2px solid Highlight; } }
</style>
