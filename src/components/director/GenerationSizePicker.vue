<script setup lang="ts">
import { computed } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect, { type StudioSelectGroup } from '@/components/ui/StudioSelect.vue'
const props = defineProps<{ engine: string; size: string; animaSizes: string[]; busy: boolean; compact?: boolean }>()
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
const sizeOptions = computed(() => props.animaSizes.map(value => ({ value, label: value.replace('x', ' × ') })))
const cards = computed(() => props.animaSizes.map(value => {
  const [width, height] = value.split('x').map(Number)
  return { value, label: width === height ? '方形' : width < height ? '竖幅' : '横幅', ratio: width / height }
}))
function change(value: string | number) { if (value !== '') emit('update:size', String(value)) }
</script>
<template>
  <div class="generation-size-picker" :class="{ 'is-compact': compact }" role="group" aria-label="画幅比例">
    <div class="size-picker-heading"><strong>画幅</strong><span>{{ size.replace('x', ' × ') }}</span></div>
    <StudioSelect v-if="compact || engine === 'sd'" label="画幅比例" :model-value="size" :disabled="busy"
      :groups="engine === 'sd' ? sizeGroups : undefined" :options="engine === 'sd' ? undefined : sizeOptions" @update:model-value="change" />
    <div v-else class="size-picker-grid">
      <button v-for="card in cards" :key="card.value" type="button" data-control-motion :aria-pressed="size === card.value" :disabled="busy" @click="change(card.value)">
        <i :style="{ aspectRatio: card.ratio }" aria-hidden="true"></i><span>{{ card.label }}</span><small>{{ card.value.replace('x', ' × ') }}</small>
        <ArchiveIcon v-if="size === card.value" class="size-picker-check" name="success" />
      </button>
    </div>
    <p v-if="!compact">画幅影响下一次输出，参考图保持原始比例。</p>
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
.size-picker-grid .size-picker-check { position:absolute; top:var(--s-2); right:var(--s-2); width:12px; height:12px; transform:none; transition:none; }
.generation-size-picker p { margin:var(--s-3) 0 0; font-size:var(--fs-label-xs); line-height:var(--lh-body); color:var(--text-secondary); }
.is-compact { display:flex; align-items:center; gap:var(--s-3); }
.is-compact .size-picker-heading { margin:0; }.is-compact .size-picker-heading>span { display:none; }
.is-compact .studio-select-wrapper { flex:1; min-width:0; }
/* Horizontal cards keep the size readable in narrow rails; a third column
   is useful only when each card has room for its icon and resolution. */
@container generation-size (min-width:440px) { .size-picker-grid { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media (hover:hover) and (pointer:fine) { .size-picker-grid button:hover:not(:disabled) { border-color:var(--border-strong); background:var(--bg-hover); } }
@media (forced-colors:active) { .size-picker-grid button[aria-pressed=true] { outline:2px solid Highlight; } }
</style>
