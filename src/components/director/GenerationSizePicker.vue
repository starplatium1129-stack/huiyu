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
    <div class="size-picker-heading"><strong>画幅</strong><span>{{ size.replace('x', ' × ') }}</span></div>
    <StudioSelect v-if="compact || engine === 'sd'" label="画幅比例" :model-value="size" :disabled="busy"
      :groups="engine === 'sd' ? sizeGroups : undefined" :options="engine === 'sd' ? undefined : sizeOptions" @update:model-value="change" />
    <div v-else class="size-picker-grid">
      <button v-for="card in cards" :key="card.value" type="button" data-spring-button :aria-pressed="size === card.value" :disabled="busy" @click="change(card.value)">
        <i :style="{ aspectRatio: card.ratio }" data-press-content aria-hidden="true"></i><span>{{ card.label }}</span><small>{{ card.value.replace('x', ' × ') }}</small>
        <span class="size-picker-check" aria-hidden="true"><ArchiveIcon name="success" /></span>
      </button>
    </div>
    <StudioPopover v-if="customSize" label="自定义画幅" :open="customOpen" :side="compact ? 'top' : 'bottom'" @update:open="openCustom">
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
    <p v-if="!compact">{{ engine === 'moss' ? '选择下一张图的竖幅、横幅或方形画布。' : '画幅影响下一次输出，参考图保持原始比例。' }}</p>
  </div>
</template>
<style scoped>
.generation-size-picker { min-width:0; }
.generation-size-picker:not(.is-compact) { container:generation-size / inline-size; }
.size-picker-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--s-2); margin-bottom:var(--s-3); }
.size-picker-heading strong { font-size:var(--fs-label); font-weight:600; color:var(--text-primary); }
.size-picker-heading>span { font:400 var(--fs-label-xs)/var(--lh-label) var(--font-mono); color:var(--text-secondary); }
.size-picker-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,128px),1fr)); gap:var(--s-2); }
.size-picker-grid button { position:relative; display:grid; grid-template-columns:28px minmax(0,1fr); align-content:center; align-items:center; column-gap:var(--s-2); row-gap:var(--s-1); min-width:0; min-height:calc(var(--control-height) + var(--s-4)); padding:var(--s-2); border:1px solid var(--border-soft); border-radius:var(--r-md); color:var(--text-secondary); background:var(--bg-base); font:400 var(--fs-label)/var(--lh-label) var(--font-sans); text-align:left; cursor:pointer; }
.size-picker-grid button[aria-pressed=true] { color:var(--text-primary); border-color:var(--border-strong); background:var(--bg-elevated); box-shadow:var(--shadow-sm); }
.size-picker-grid button:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.size-picker-grid button:disabled { color:var(--text-disabled); cursor:not-allowed; }
.size-picker-grid i { grid-row:1/3; justify-self:center; height:21px; max-width:28px; border:1.4px solid currentColor; border-radius:2px; }
.size-picker-grid small { grid-column:2; font:400 var(--fs-label-xs)/var(--lh-label) var(--font-mono); font-variant-numeric:tabular-nums; }
.size-picker-check {
  position:absolute; top:var(--s-1); right:var(--s-1);
  display:grid; place-items:center; width:17px; height:17px; border-radius:50%;
  background:var(--bg-surface); color:var(--text-primary);
  opacity:0; transform:translateY(2px) scale(.78);
  transition:transform var(--motion-control) var(--spring-soft),opacity var(--motion-hover) var(--ease-out);
}
.size-picker-check .archive-icon { width:12px; height:12px; }
.size-picker-grid button[aria-pressed="true"] .size-picker-check { opacity:1; transform:none; }
.size-picker-grid:has(:focus-visible) .size-picker-check { transition:none; }
.generation-size-picker p { margin:var(--s-3) 0 0; font-size:var(--fs-label-xs); line-height:var(--lh-body); color:var(--text-secondary); }
.size-picker-custom { margin-block-start:var(--s-2); flex-shrink:0; white-space:nowrap; }
.size-picker-form { display:grid; gap:var(--s-3); }
.size-picker-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s-3); }
.size-picker-fields label { display:grid; gap:var(--s-1); font-size:var(--fs-label); }
.size-picker-fields input { min-width:0; width:100%; }
.size-picker-form p { margin:0; font-size:var(--fs-label-xs); line-height:var(--lh-body); color:var(--text-secondary); }
.size-picker-form .size-picker-error { color:var(--danger); }
.size-picker-form button { justify-self:end; }
.is-compact { display:flex; align-items:center; gap:var(--s-3); }
.is-compact .size-picker-custom { margin:0; }
.is-compact .size-picker-heading { margin:0; }.is-compact .size-picker-heading>span { display:none; }
.is-compact .studio-select-wrapper { flex:1; min-width:0; }
/* Horizontal cards keep the size readable in narrow rails; a third column
   is useful only when each card has room for its icon and resolution. */
@container generation-size (min-width:440px) { .size-picker-grid { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media (hover:hover) and (pointer:fine) { .size-picker-grid button:hover:not(:disabled) { border-color:var(--border-strong); background:var(--bg-hover); } }
@media (prefers-reduced-motion:reduce) { :root:not([data-motion='full']) .size-picker-check { transition:none; transform:none; } }
:root:is([data-motion='reduce'],[data-motion='reduced']) .size-picker-check { transition:none; transform:none; }
@media (forced-colors:active) { .size-picker-grid button[aria-pressed=true] { outline:2px solid Highlight; } }
</style>
