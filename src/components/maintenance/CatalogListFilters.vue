<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import type { CatalogPage } from '@/api/catalogApi'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { catalogCategory, catalogRating } from '@/composables/scene/catalogPresentation'

const props = defineProps<{
  facets?: CatalogPage['facets']
  characterNames: Record<string, string>
  visible: boolean
}>()
const search = defineModel<string>('search', { required: true })
const sort = defineModel<string>('sort', { required: true })
const character = defineModel<string>('character', { required: true })
const category = defineModel<string>('category', { required: true })
const rating = defineModel<string>('rating', { required: true })
const searchField = ref<InstanceType<typeof StudioSearch> | null>(null)
const filterButton = ref<HTMLButtonElement | null>(null)
const open = ref(false)
const prefix = useId()
const sortOptions = [
  { value: 'order', label: '整理顺序' }, { value: 'title', label: '按名称' },
  { value: 'newest', label: '最近加入' }, { value: 'updated', label: '最近编辑' },
]
const fields = computed(() => [
  { key: 'character', label: '角色', model: character, values: props.facets?.characters, format: (id: string) => props.characterNames[id] || id },
  { key: 'category', label: '分类', model: category, values: props.facets?.categories, format: catalogCategory },
  { key: 'rating', label: '分级', model: rating, values: props.facets?.ratings, format: catalogRating },
].filter(field => field.model.value || field.values?.length))
const active = computed(() => fields.value.filter(field => field.model.value))
watch(() => props.visible, visible => { if (!visible) open.value = false })

function focusSearch() { searchField.value?.focus() }
function clearFilters() { character.value = ''; category.value = ''; rating.value = '' }
async function clearAll() {
  search.value = ''
  clearFilters()
  await nextTick()
  focusSearch()
}
async function removeFilter(field: typeof fields.value[number]) {
  field.model.value = ''
  await nextTick()
  if (document.activeElement === document.body) filterButton.value?.focus()
}
defineExpose({ clearAll, focusSearch })
</script>

<template>
  <div class="catalog-filter-bar">
    <StudioSearch ref="searchField" v-model="search" label="搜索当前分类" placeholder="搜索名称、编号或关键词" />
    <StudioSelect v-model="sort" label="排列方式" :options="sortOptions" />
    <StudioPopover v-if="fields.length" v-model:open="open" label="筛选内容">
      <template #trigger>
        <button ref="filterButton" class="btn btn-ghost catalog-filter-button" type="button" :aria-label="active.length ? '筛选，已用 ' + active.length + ' 项' : '筛选'">
          <ArchiveIcon name="filter" />筛选<span v-if="active.length">{{ active.length }}</span>
        </button>
      </template>
      <div class="catalog-filter-fields">
        <div v-for="field in fields" :key="field.key" class="catalog-filter-field">
          <label :for="prefix + field.key">{{ field.label }}</label>
          <StudioSelect :id="prefix + field.key" :model-value="field.model.value" :label="field.label"
            :options="[{ value: '', label: '全部' + field.label }, ...(field.values ?? []).map(value => ({ value, label: field.format(value) || value }))]"
            @update:model-value="field.model.value = String($event)" />
        </div>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="!active.length" @click="clearFilters">清除筛选</button>
      </div>
    </StudioPopover>
  </div>
  <div v-if="active.length" class="catalog-applied-filters" role="group" aria-label="已用筛选">
    <button v-for="field in active" :key="field.key" type="button" class="btn btn-quiet btn-sm"
      :aria-label="'移除' + field.label + '筛选 ' + (field.format(field.model.value) || field.model.value)" @click="removeFilter(field)">
      <span>{{ field.format(field.model.value) || field.model.value }}</span><ArchiveIcon name="close" />
    </button>
  </div>
</template>
