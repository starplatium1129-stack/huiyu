<script setup lang="ts">
import { computed, ref } from 'vue'
import StudioPagination from '@/components/ui/StudioPagination.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioSkeleton from '@/components/ui/StudioSkeleton.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import type { CatalogItem, GuestRatingFilter } from './useGuestCatalog'

const RATING_FILTERS: readonly { value: GuestRatingFilter; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'SFW', label: '全年龄' },
  { value: 'R18', label: 'R18' },
]

const props = withDefaults(defineProps<{
  items: readonly CatalogItem[]
  total: number
  page: number
  pages: number
  loading: boolean
  error: string
  search: string
  rating: GuestRatingFilter
  filterCharacter?: CatalogItem
  connected: boolean
  checking: boolean
  selectedSceneId?: string
  selectedCharacter?: CatalogItem
  showBack?: boolean
  allowCharacterScopeToggle?: boolean
  searchLabel: string
  searchPlaceholder: string
  emptyHint?: string
  offlineHint?: string
}>(), {
  showBack: false,
  allowCharacterScopeToggle: false,
  emptyHint: '没有找到匹配的场景蓝图。',
  offlineHint: '连上房主画室后可挑现成的场景蓝图。',
})

const emit = defineEmits<{
  'update:search': [value: string]
  'update:rating': [value: GuestRatingFilter]
  loadPage: [page: number]
  choose: [item: CatalogItem]
  back: []
  toggleCharacterScope: []
  reconnect: []
  switchToFree: []
  resetFilters: []
}>()

const searchBox = ref<InstanceType<typeof StudioSearch>>()
const searchModel = computed({
  get: () => props.search,
  set: value => emit('update:search', value),
})

const hasActiveFilter = computed(() =>
  Boolean(props.search || props.rating || (props.allowCharacterScopeToggle && props.filterCharacter)),
)

defineExpose({
  focusSearch: () => searchBox.value?.focus({ preventScroll: true }),
})
</script>

<template>
  <div v-if="showBack && filterCharacter" class="guest-paneBar">
    <button
      class="btn btn-quiet btn-sm guest-backBtn"
      type="button"
      @click="emit('back')"
    >
      <ArchiveIcon name="chevron-down" />全部角色
    </button>
    <span class="guest-paneTitle">{{ filterCharacter.title }}的场景</span>
  </div>

  <StudioSearch
    ref="searchBox"
    v-model="searchModel"
    size="sm"
    :label="searchLabel"
    :placeholder="searchPlaceholder"
  >
    <template #input="{ inputProps }">
      <input v-bind="inputProps" v-model="searchModel" maxlength="160" />
    </template>
  </StudioSearch>

  <div class="guest-ratingRow" role="group" aria-label="场景筛选">
    <button
      v-for="option in RATING_FILTERS"
      :key="option.value || 'all'"
      type="button"
      class="guest-pillFilter"
      :aria-pressed="rating === option.value"
      @click="emit('update:rating', option.value)"
    >
      {{ option.label }}
    </button>
    <button
      v-if="allowCharacterScopeToggle && selectedCharacter"
      type="button"
      class="guest-pillFilter"
      :aria-pressed="filterCharacter?.id === selectedCharacter.id"
      @click="emit('toggleCharacterScope')"
    >
      仅看{{ selectedCharacter.title }}
    </button>
    <span v-if="total > 0" class="guest-countHint">{{ showBack ? `共 ${total} 幕` : `${total} 幕` }}</span>
  </div>

  <div v-if="!connected && checking" class="guest-skeletonList">
    <StudioSkeleton v-for="n in 5" :key="n" variant="line" height="44px" />
  </div>
  <div v-else-if="!connected" class="guest-inlineState">
    <p>{{ offlineHint }}</p>
    <div class="guest-inlineActions">
      <button class="btn btn-ghost btn-sm" type="button" @click="emit('reconnect')">重新连接</button>
      <button class="btn btn-quiet btn-sm" type="button" @click="emit('switchToFree')">看自由画灵感</button>
    </div>
  </div>
  <div v-else-if="error" class="guest-inlineState is-error" role="alert">
    <p>{{ error }}</p>
    <button class="btn btn-ghost btn-sm" type="button" @click="emit('loadPage', page)">重试</button>
  </div>
  <div v-else-if="loading" class="guest-skeletonList">
    <StudioSkeleton v-for="n in 5" :key="n" variant="line" height="44px" />
  </div>
  <div v-else-if="!items.length" class="guest-inlineState">
    <p>{{ emptyHint }}</p>
    <button
      v-if="hasActiveFilter"
      class="btn btn-quiet btn-sm"
      type="button"
      @click="emit('resetFilters')"
    >
      {{ showBack ? '显示全部场景' : '重置筛选' }}
    </button>
  </div>
  <div v-else class="guest-sceneList">
    <button
      v-for="item in items"
      :key="`${item.kind}:${item.id}`"
      type="button"
      class="guest-sceneItem"
      :aria-pressed="selectedSceneId === item.id"
      @click="emit('choose', item)"
    >
      <span class="guest-sceneIcon" aria-hidden="true">
        <ArchiveIcon name="scene" />
      </span>
      <span class="guest-sceneText">
        <strong>{{ item.title }}</strong>
        <small v-if="item.category || item.rating === 'R18'">
          {{ [item.category, item.rating === 'R18' ? 'R18' : ''].filter(Boolean).join(' · ') }}
        </small>
      </span>
      <ArchiveIcon
        v-if="selectedSceneId === item.id"
        name="success"
        class="guest-itemCheck"
      />
    </button>
  </div>

  <StudioPagination
    v-if="pages > 1"
    compact
    label="场景分页"
    :model-value="page"
    :pages="pages"
    :disabled="loading"
    @update:model-value="emit('loadPage', $event)"
  />
</template>
