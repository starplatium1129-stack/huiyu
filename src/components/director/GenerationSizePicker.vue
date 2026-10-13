<script setup lang="ts">
import { computed } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect, { type StudioSelectGroup } from '@/components/ui/StudioSelect.vue'
import type { DrawEngine } from '@/storage/settingsRepository'
const props = defineProps<{ engine: DrawEngine; size: string; animaSizes: string[]; busy: boolean; compact?: boolean }>()
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
      <button v-for="card in cards" :key="card.value" type="button" :aria-pressed="size === card.value" :disabled="busy" @click="change(card.value)">
        <i :style="{ aspectRatio: card.ratio }" aria-hidden="true"></i><span>{{ card.label }}</span><small>{{ card.value.replace('x', ' × ') }}</small>
        <ArchiveIcon v-if="size === card.value" name="success" />
      </button>
    </div>
    <p v-if="!compact">画幅影响下一次输出，参考图保持原始比例。</p>
  </div>
</template>
<style scoped>
.generation-size-picker { min-width:0; }
.size-picker-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; }
.size-picker-heading strong { font-size:14px; font-weight:600; color:var(--text-primary); }
.size-picker-heading>span { font:11px var(--font-mono); color:var(--text-muted); }
.size-picker-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
.size-picker-grid button { position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; min-width:0; min-height:72px; padding:8px 4px; border:1px solid var(--border-soft); border-radius:var(--r-md); color:var(--text-secondary); background:transparent; font:12px var(--font-sans); cursor:pointer; }
.size-picker-grid button:hover:not(:disabled) { border-color:var(--border-strong); background:var(--bg-hover); }
.size-picker-grid button[aria-pressed=true] { color:var(--accent); border-color:var(--accent); background:var(--accent-soft); }
.size-picker-grid button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.size-picker-grid button:disabled { color:var(--text-disabled); cursor:not-allowed; }
.size-picker-grid i { height:21px; max-width:28px; border:1.4px solid currentColor; border-radius:2px; }
.size-picker-grid small { font-size:11px; font-variant-numeric:tabular-nums; }
.size-picker-grid .archive-icon { position:absolute; top:6px; right:6px; width:12px; height:12px; }
.generation-size-picker p { margin:10px 0 0; font-size:12px; line-height:1.7; color:var(--text-muted); }
.is-compact { display:flex; align-items:center; gap:12px; }
.is-compact .size-picker-heading { margin:0; }.is-compact .size-picker-heading>span { display:none; }
.is-compact .studio-select-wrapper { flex:1; min-width:0; }
@media (forced-colors:active) { .size-picker-grid button[aria-pressed=true] { outline:2px solid Highlight; } }
</style>
