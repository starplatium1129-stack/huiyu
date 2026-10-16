<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, useId } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import type { SmartAlbumRule } from '@/application/artwork/smartAlbums'
import { UNASSIGNED_CHARACTER_ID } from '@/composables/gallery/galleryAlbumRules'
import { emptyGenerationConditions, GENERATION_FILTER_FIELDS, generationConditionLabel, type GalleryFilterSnapshot, type GenerationFilterField } from '@/composables/gallery/galleryGenerationConditions'

const GalleryCollectionFilters = defineAsyncComponent(() => import('./GalleryCollectionFilters.vue'))
const GalleryGenerationFilters = defineAsyncComponent(() => import('./GalleryGenerationFilters.vue'))
const props = defineProps<{
  filters: GalleryFilterSnapshot
  projects: { value: string; label: string }[]
  characters: { value: string; label: string }[]
  tags: { value: string; label: string }[]
  generationOptions: Record<GenerationFilterField, { value: string; label: string }[]>
  smartRule?: SmartAlbumRule
  characterName: (id: string) => string
  disabled: boolean
  projectUnavailable: boolean
}>()
const emit = defineEmits<{ apply: [filters: GalleryFilterSnapshot]; reset: []; save: []; edit: [] }>()
const panelId = `gallery-refinement-${useId()}`
const expanded = ref(false), visited = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const activeFilters = ref<HTMLElement | null>(null)
const generationLabels: Record<GenerationFilterField, string> = {
  engine: '引擎', model: '模型', outfit: '服装', seed: 'Seed', size: '尺寸', reviewState: '候选状态',
}
type FilterKey = Exclude<keyof GalleryFilterSnapshot, 'generation'> | GenerationFilterField
const chips = computed(() => {
  const filters = props.filters
  const items: { key: FilterKey; label: string }[] = []
  if (filters.favoriteOnly) items.push({ key: 'favoriteOnly', label: '仅收藏' })
  if (filters.projectFilter) items.push({ key: 'projectFilter', label: `画册：${props.projects.find(item => item.value === filters.projectFilter)?.label || '画册未找到'}` })
  if (filters.characterFilter) items.push({ key: 'characterFilter', label: `角色：${filters.characterFilter === UNASSIGNED_CHARACTER_ID ? '未标注角色' : props.characterName(filters.characterFilter)}` })
  if (filters.tagFilter) items.push({ key: 'tagFilter', label: `标签：${filters.tagFilter}` })
  if (filters.searchQuery) items.push({ key: 'searchQuery', label: `搜索：${filters.searchQuery}` })
  for (const key of GENERATION_FILTER_FIELDS) {
    if (filters.generation[key]) items.push({ key, label: `${generationLabels[key]}：${generationConditionLabel(key, filters.generation[key])}` })
  }
  return items
})
const generationCount = computed(() => GENERATION_FILTER_FIELDS.filter(field => props.filters.generation[field]).length)
function update<K extends keyof GalleryFilterSnapshot>(key: K, value: GalleryFilterSnapshot[K]) {
  emit('apply', { ...props.filters, generation: { ...props.filters.generation }, [key]: value })
}
function toggle() {
  expanded.value = !expanded.value
  if (expanded.value) visited.value = true
}
function close(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return
  event.preventDefault(); event.stopPropagation()
  expanded.value = false
  trigger.value?.focus({ preventScroll: true })
}
async function remove(key: FilterKey) {
  const index = chips.value.findIndex(chip => chip.key === key)
  if (GENERATION_FILTER_FIELDS.includes(key as GenerationFilterField)) {
    update('generation', { ...props.filters.generation, [key]: '' })
  } else if (key === 'favoriteOnly') update(key, false)
  else update(key as Exclude<keyof GalleryFilterSnapshot, 'generation' | 'favoriteOnly'>, '')
  await nextTick()
  const buttons = activeFilters.value?.querySelectorAll<HTMLButtonElement>('[data-filter-key]')
  ;(buttons?.[Math.min(index, buttons.length - 1)] || trigger.value)?.focus({ preventScroll: true })
}
async function reset() {
  emit('reset')
  await nextTick()
  trigger.value?.focus({ preventScroll: true })
}
function focusTag() {
  activeFilters.value?.querySelector<HTMLButtonElement>('[data-filter-key="tagFilter"]')?.focus({ preventScroll: true })
}
defineExpose({ focusTag })
</script>

<template>
  <!-- The controls share the toolbar's layout, without adding a second surface. -->
  <div class="gallery-refinement">
    <button ref="trigger" class="gallery-refine-toggle" type="button" :aria-expanded="expanded" :aria-controls="panelId" @click="toggle">
      <ArchiveIcon name="pin" /><span class="studio-control-label">筛选作品</span><span v-if="chips.length" class="gallery-refine-count">{{ chips.length }}</span><ArchiveIcon name="chevron-down" />
    </button>
    <div v-if="chips.length" ref="activeFilters" class="gallery-active-filters" role="group" aria-label="已选筛选条件">
      <span class="gallery-active-label">已选</span>
      <button v-for="chip in chips" :key="chip.key" type="button" class="gallery-filter-chip" :data-filter-key="chip.key" :aria-label="`移除筛选：${chip.label}`" @click="remove(chip.key)">
        <span class="studio-control-label">{{ chip.label }}</span><ArchiveIcon name="close" />
      </button>
      <button class="btn btn-quiet btn-sm gallery-filter-reset" type="button" @click="reset">清除全部</button>
    </div>
    <section v-show="expanded" :id="panelId" class="gallery-refine-panel" aria-label="作品筛选条件" @keydown.esc="close">
      <template v-if="visited">
      <div class="gallery-library-fields">
        <label class="gallery-project-field"><span>画册</span><StudioSelect :model-value="filters.projectFilter" label="按画册筛选" :options="projects" @update:model-value="update('projectFilter', String($event))" /></label>
        <GalleryCollectionFilters :character="filters.characterFilter" :tag="filters.tagFilter" :characters="characters" :tags="tags"
          :smart-rule="smartRule" :character-name="characterName" :disabled="disabled"
          @update:character="update('characterFilter', $event)" @update:tag="update('tagFilter', $event)" @save="emit('save')" @edit="emit('edit')" />
      </div>
      <p v-if="projectUnavailable" class="gallery-filter-warning" role="status">当前画册已不存在，可移除上方的画册条件或选择其他画册。</p>
      <GalleryGenerationFilters :conditions="filters.generation" :options="generationOptions" :filter-count="generationCount"
        :snapshot="filters" :has-active="!!chips.length" @update:conditions="update('generation', $event)"
        @apply="emit('apply', $event)" @clear="update('generation', emptyGenerationConditions())" />
      </template>
    </section>
  </div>
</template>

<style scoped>
.gallery-refinement { display:contents; }
.gallery-refine-toggle { display:flex; align-items:center; gap:var(--s-2); flex-shrink:0; min-height:var(--control-height); padding:0 var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); color:var(--text-primary); background:var(--bg-surface); font:500 var(--fs-label-sm)/var(--lh-label) var(--font-sans); cursor:pointer; }
.gallery-refine-toggle[aria-expanded='true'] { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }
.gallery-refine-toggle > .archive-icon { width:16px; height:16px; }
.gallery-refine-toggle[aria-expanded='true'] > .archive-icon:last-child { transform:rotate(180deg); }
.gallery-refine-count { min-width:var(--s-5); color:var(--accent); font-variant-numeric:tabular-nums; text-align:center; }
.gallery-active-filters { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); flex:1 0 100%; min-width:0; }
.gallery-active-label { color:var(--text-secondary); font-size:var(--fs-label-sm); }
.gallery-filter-chip { display:flex; align-items:center; gap:var(--s-2); min-width:0; max-width:100%; min-height:var(--control-height-sm); padding:var(--s-1) var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-pill); background:var(--accent-soft); color:var(--text-primary); font:500 var(--fs-label-sm)/var(--lh-label) var(--font-sans); cursor:pointer; text-align:left; }
.gallery-filter-chip > span { overflow-wrap:anywhere; }
.gallery-filter-chip > .archive-icon { flex-shrink:0; width:14px; height:14px; color:var(--text-secondary); }
.gallery-filter-reset { margin-left:auto; }
.gallery-refine-toggle:focus-visible,.gallery-filter-chip:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.gallery-refine-panel { display:grid; flex:1 0 100%; min-width:0; gap:var(--s-4); padding-top:var(--s-4); border-top:1px solid var(--border-soft); }
.gallery-library-fields { display:flex; flex-wrap:wrap; align-items:flex-start; gap:var(--s-3); }
.gallery-project-field { display:grid; gap:var(--s-1); flex:0 1 200px; min-width:0; color:var(--text-secondary); font-size:var(--fs-label-sm); }
.gallery-library-fields > :deep(.collection-filters) { flex:1 1 28rem; }
.gallery-filter-warning { margin:0; color:var(--warning-text); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
@media (hover:hover) and (pointer:fine) {
  .gallery-refine-toggle:hover,.gallery-filter-chip:hover { border-color:var(--accent); color:var(--accent); }
}
@media (max-width:768px) {
  .gallery-project-field { flex:1 1 100%; }
  .gallery-filter-chip,.gallery-refine-toggle { min-height:44px; }
}
</style>
