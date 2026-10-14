<script setup lang="ts">
import { computed, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { conditionText, normalizeGalleryFilterSnapshot, recordedCondition, recordedSeed, UNRECORDED_CONDITION, type GalleryFilterSnapshot, type GalleryGenerationConditions, type GenerationFilterField } from '@/composables/gallery/galleryGenerationConditions'
import { useGallerySavedFilters } from '@/composables/gallery/useGallerySavedFilters'
import { GALLERY_FILTER_NAME_LIMIT } from '@/storage/galleryFilterPreferences'

const conditions = defineModel<GalleryGenerationConditions>('conditions', { required: true })
const props = defineProps<{
  options: Record<GenerationFilterField, { value: string; label: string }[]>
  filterCount: number
  snapshot: GalleryFilterSnapshot
  hasActive: boolean
}>()
const emit = defineEmits<{ apply: [filters: GalleryFilterSnapshot]; clear: [] }>()
const presetName = ref('')
const fields: { key: Exclude<GenerationFilterField, 'seed'>; label: string; all: string }[] = [
  { key: 'engine', label: '引擎', all: '全部引擎' }, { key: 'model', label: '模型 / Checkpoint', all: '全部模型' },
  { key: 'outfit', label: '角色 · 服装', all: '全部服装' }, { key: 'size', label: '生成尺寸', all: '全部尺寸' },
  { key: 'reviewState', label: '候选状态', all: '全部状态' },
]
const seedInput = computed({
  get: () => conditionText(conditions.value.seed),
  set: (value: string) => { conditions.value = { ...conditions.value, seed: value.trim() ? recordedCondition(recordedSeed(value) || value.trim()) : '' } },
})
function updateCondition(field: GenerationFilterField, value: string | number) {
  conditions.value = { ...conditions.value, [field]: String(value) }
}
function toggleMissingSeed() { updateCondition('seed', conditions.value.seed === UNRECORDED_CONDITION ? '' : UNRECORDED_CONDITION) }
const { presets, matchedPresetId, busy, error, message, savePreset, applyPreset, removePreset } = useGallerySavedFilters({
  snapshot: () => normalizeGalleryFilterSnapshot(props.snapshot), apply: filters => emit('apply', filters),
})
const presetOptions = computed(() => [{ value: '', label: '选择常用组合' }, ...presets.value.map(preset => ({ value: preset.id, label: preset.name }))])
async function save() { if (await savePreset(presetName.value)) presetName.value = '' }
</script>

<template>
  <section class="gallery-generation-filters" aria-label="生成条件与常用组合">
    <div class="generation-heading"><h3>生成条件</h3><button class="btn btn-quiet btn-sm" type="button" :disabled="!filterCount" @click="emit('clear')">清除生成条件</button></div>
      <div class="generation-fields">
        <label v-for="field in fields" :key="field.key" class="generation-field"><span>{{ field.label }}</span>
          <StudioSelect :model-value="conditions[field.key]" :label="`按${field.label}筛选`" :options="[{ value: '', label: field.all }, ...options[field.key]]" @update:model-value="updateCondition(field.key, $event)" />
        </label>
        <div class="generation-field">
          <label for="gallery-seed-filter">Seed（精确匹配）</label>
          <div class="generation-seed"><input id="gallery-seed-filter" v-model="seedInput" inputmode="numeric" autocomplete="off" placeholder="输入保存的 Seed" :disabled="conditions.seed === UNRECORDED_CONDITION" />
            <button class="btn btn-ghost btn-sm" type="button" :aria-pressed="conditions.seed === UNRECORDED_CONDITION" @click="toggleMissingSeed">{{ conditions.seed === UNRECORDED_CONDITION ? '取消未记录' : '未记录' }}</button>
          </div>
        </div>
      </div>
    <details class="generation-presets">
      <summary><ArchiveIcon name="book" /><span>常用筛选组合</span><span v-if="presets.length">{{ presets.length }}</span><ArchiveIcon name="chevron-down" /></summary>
      <div data-disclosure-content>
      <div class="generation-actions">
        <StudioSelect v-if="presets.length" :model-value="matchedPresetId" label="沿用常用筛选组合" :options="presetOptions" :disabled="busy" @update:model-value="applyPreset(String($event))" />
        <button v-if="matchedPresetId" class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="removePreset(matchedPresetId)">移除此组合</button>
      </div>
      <form class="generation-save" @submit.prevent="save">
        <label for="gallery-filter-name">组合名称</label>
        <input id="gallery-filter-name" v-model="presetName" :maxlength="GALLERY_FILTER_NAME_LIMIT" :disabled="busy" autocomplete="off" placeholder="例如：Anima 收藏竖图" required />
        <button class="btn btn-ghost btn-sm" type="submit" :disabled="busy || !hasActive || !presetName.trim()">{{ busy ? '正在保存…' : '保存当前组合' }}</button>
      </form>
      <p v-if="message" class="generation-note" role="status">{{ message }}</p>
      <p v-if="error" class="generation-error" role="alert">{{ error }}</p>
      </div>
    </details>
  </section>
</template>

<style scoped>
@reference "../../assets/css/tailwind.css";
.gallery-generation-filters { @apply tw:min-w-0 tw:text-primary tw:text-label-sm; }
.generation-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); min-height:var(--control-height-sm); }
.generation-heading h3 { margin:0; font:600 var(--fs-label-sm)/var(--lh-label) var(--font-sans); }
details { margin-top:var(--s-4); border:0; border-top:1px solid var(--border-soft); background:transparent; }
summary { @apply tw:flex tw:items-center tw:gap-s-2 tw:min-h-[40px]; padding-inline:var(--s-2); cursor:pointer; list-style:none; }
summary .archive-icon { width:16px; height:16px; flex-shrink:0; }
details[open] summary > :last-child { transform:rotate(180deg); }
summary::-webkit-details-marker { display:none; }
summary > :last-child { margin-left:auto; }
summary:focus-visible,input:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.generation-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr)); gap:var(--s-3); margin-top:var(--s-3); }
.generation-field { @apply tw:grid tw:min-w-0 tw:gap-s-1; align-content:start; color:var(--text-secondary); }
.generation-seed,.generation-actions,.generation-save { @apply tw:flex tw:items-center tw:flex-wrap tw:gap-s-2; }
.generation-seed input { flex:1; min-width:0; width:0; }
.generation-actions { margin-top:var(--s-3); }
.generation-actions :deep(.studio-select-wrapper) { flex:1; max-width:24rem; min-width:min(14rem,100%); }
.generation-save { margin-top:var(--s-3); }
.generation-save input { flex:1; min-width:min(14rem,100%); }
input { @apply tw:rounded-md tw:text-primary; min-height:40px; border:1px solid var(--border-soft); background:var(--bg-surface); padding:var(--s-2) var(--s-3); font:inherit; }
input::placeholder,.generation-note { color:var(--text-secondary); }
input:disabled { color:var(--text-disabled); }
.generation-note,.generation-error { margin:var(--s-2) 0 0; line-height:var(--lh-body); }
.generation-error { color:var(--warning-text); }
</style>
