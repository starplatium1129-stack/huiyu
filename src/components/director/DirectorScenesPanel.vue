<template>
  <div class="panel step-panel" id="stepScene">
    <template v-if="pb.isPopular">
      <!-- Blueprint 是内部数据结构的名字，不该出现在用户看得见的标题上 -->
      <div class="panel-title">场景建议<span class="scene-count-badge">{{ popularBlueprintPool.length }}</span></div>
      <PopularBlueprintPicker
        :pool="popularBlueprintPool"
        :categories="blueprintCategories"
        :recommended="recommendedBlueprints"
        :filtered="filteredPopularBlueprints"
        :category="popularCategory"
        :show-all="showAllBlueprints"
        :data-ready="pb.dataReady"
        :selected-blueprint-id="pb.subject.kind === 'popular' ? pb.subject.blueprintId ?? '' : ''"
        @update:category="$emit('update:popularCategory', $event)"
        @update:show-all="$emit('update:showAllBlueprints', $event)"
        @select="$emit('selectBlueprint', $event)"
        @rotate="$emit('rotateBlueprintSet')"
        @toggle="$emit('toggleBlueprintList')"
      />
    </template>
    <template v-else>
      <div class="panel-title">Scene · <span class="scene-count-badge">{{ availableScenes.length }}</span></div>
      <div class="scene-scope" role="group" aria-label="场景库范围">
        <button type="button" :class="{ active: sceneCollection === 'core' }"
          :aria-pressed="sceneCollection === 'core'"
          @click="$emit('update:sceneCollection', 'core')">人设核心 {{ personaCoreCount }}</button>
        <button type="button" :class="{ active: sceneCollection === 'curated' }"
          :aria-pressed="sceneCollection === 'curated'"
          @click="$emit('update:sceneCollection', 'curated')">精选 {{ curatedCount }}</button>
        <button type="button" :class="{ active: sceneCollection === 'all' }"
          :aria-pressed="sceneCollection === 'all'"
          @click="$emit('update:sceneCollection', 'all')">完整库</button>
      </div>
      <div class="scene-search-wrap">
        <input type="search" class="scene-search" v-model="pb.sceneSearch"
          aria-label="搜索场景"
          placeholder="试试：安静的夏目雨夜">
        <button class="scene-search-clear" type="button" aria-label="清空"
          @click="pb.sceneSearch = ''">×</button>
      </div>
      <div class="scene-filter-summary">
        <span class="scene-result-count" role="status" aria-live="polite">
          {{ availableScenes.length }} 个场景
        </span>
        <button class="scene-filter-reset" type="button" @click="pb.sceneSearch = ''; pb.sceneTheme = 'all'">重置筛选</button>
      </div>
      <div class="scene-filter-label advanced-decision">主题</div>
      <div class="scene-cats advanced-decision" role="group" aria-label="场景主题">
        <button v-for="t in SCENE_THEMES" :key="t.id"
          class="scene-cat-btn" type="button"
          :aria-pressed="pb.sceneTheme === t.id"
          :class="{ active: pb.sceneTheme === t.id }"
          @click="pb.sceneTheme = t.id"><ArchiveIcon :name="t.iconName" /> {{ t.label }}</button>
      </div>
      <div class="scene-list">
        <div v-if="!pb.dataReady" class="scene-loading">正在加载场景库…</div>
        <div v-else-if="!availableScenes.length" class="scene-empty">未找到匹配场景</div>
        <button v-for="scene in visibleScenes" :key="scene.id"
          class="scene-card"
          :class="{ active: pb.sceneId === scene.id }"
          :aria-pressed="pb.sceneId === scene.id"
          type="button"
          @click="$emit('selectScene', scene)">
          <div class="scene-card-title">
            {{ scene.title }}
            <span v-if="personaCoreIds.has(scene.id)" class="scene-core-mark">人设核心</span>
          </div>
          <div v-if="scene.story" class="scene-card-story">{{ scene.story }}</div>
          <div class="scene-card-meta">
            <span v-if="scene.category" class="scene-cat-tag">{{ scene.category }}</span>
            <span v-if="scene.rating && scene.rating !== 'All'" class="scene-rating-tag">{{ scene.rating }}</span>
          </div>
        </button>
        <button v-if="availableScenes.length > sceneLimit" class="btn btn-ghost scene-more"
          type="button" @click="$emit('update:sceneLimit', sceneLimit + 20)">
          显示更多 ({{ availableScenes.length - sceneLimit }} 个)
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { SCENE_THEMES } from '@/config/promptConstants'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import PopularBlueprintPicker from '@/components/popular/PopularBlueprintPicker.vue'
import type { Scene } from '@/stores/promptBuilderStore'
import type { SceneBlueprint } from '@/utils/popularContent'
import '@/assets/css/director/components/DirectorSceneLibrary.css'
import '@/assets/css/director/components/DirectorScenesPanel.css'

const pb = usePromptBuilderStore()

defineProps<{
  popularBlueprintPool: SceneBlueprint[]
  blueprintCategories: string[]
  recommendedBlueprints: SceneBlueprint[]
  filteredPopularBlueprints: SceneBlueprint[]
  popularCategory: string
  showAllBlueprints: boolean
  availableScenes: Scene[]
  visibleScenes: Scene[]
  sceneCollection: 'core' | 'curated' | 'all'
  personaCoreCount: number
  curatedCount: number
  personaCoreIds: Set<string>
  sceneLimit: number
}>()

defineEmits<{
  'update:popularCategory': [value: string]
  'update:showAllBlueprints': [value: boolean]
  selectBlueprint: [blueprint: SceneBlueprint]
  rotateBlueprintSet: []
  toggleBlueprintList: []
  'update:sceneCollection': [value: 'core' | 'curated' | 'all']
  selectScene: [scene: Scene]
  'update:sceneLimit': [value: number]
}>()
</script>
