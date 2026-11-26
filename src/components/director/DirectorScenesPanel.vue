<template>
  <div v-content-motion:fade="pb.isPopular" class="panel step-panel" id="stepScene">
    <template v-if="pb.isPopular">
      <!-- Blueprint 是内部数据结构的名字，不该出现在用户看得见的标题上 -->
      <div class="panel-title">场景建议<span v-if="pb.popularBlueprintReady && !pb.popularBlueprintLoading" class="scene-count-badge">{{ popularBlueprintPool.length }}</span></div>
      <PopularBlueprintPicker
        :pool="popularBlueprintPool"
        :categories="blueprintCategories"
        :recommended="recommendedBlueprints"
        :filtered="filteredPopularBlueprints"
        :category="popularCategory"
        :show-all="showAllBlueprints"
        :data-ready="pb.popularBlueprintReady"
        :loading="pb.popularBlueprintLoading"
        :error="pb.popularBlueprintError"
        :selected-blueprint-id="pb.subject.kind === 'popular' ? pb.subject.blueprintId ?? '' : ''"
        :outfit-names="popularOutfitNames"
        @update:category="$emit('update:popularCategory', $event)"
        @update:show-all="$emit('update:showAllBlueprints', $event)"
        @select="$emit('selectBlueprint', $event)"
        @rotate="$emit('rotateBlueprintSet')"
        @toggle="$emit('toggleBlueprintList')"
        @retry="retryBlueprints"
      />
    </template>
    <template v-else>
      <div class="scene-scope studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="场景库范围">
        <AnimatedSelection />
        <button type="button"
          :aria-pressed="sceneCollection === 'core'"
          @click="$emit('update:sceneCollection', 'core')">人设核心 {{ pb.dataReady ? personaCoreCount : '—' }}</button>
        <button type="button"
          :aria-pressed="sceneCollection === 'curated'"
          @click="$emit('update:sceneCollection', 'curated')">精选 {{ pb.dataReady ? curatedCount : '—' }}</button>
        <button type="button"
          :aria-pressed="sceneCollection === 'all'"
          @click="$emit('update:sceneCollection', 'all')">完整库</button>
      </div>
      <StudioSearch v-model="pb.sceneSearch" class="scene-search-wrap" label="搜索场景" placeholder="搜索场景名或关键词…" />
      <div class="scene-filter-summary">
        <span class="scene-result-count" role="status" aria-live="polite">
          {{ pb.dataLoading ? '正在读取…' : pb.dataError ? '读取失败' : pb.dataReady ? `${availableScenes.length} 个场景` : '尚未读取' }}
        </span>
        <button class="btn btn-quiet btn-sm" type="button" @click="pb.sceneSearch = ''; pb.sceneTheme = 'all'">重置筛选</button>
      </div>
      <details class="scene-theme-filter">
        <StudioDisclosureSummary>主题 · {{ currentThemeLabel }}</StudioDisclosureSummary>
        <div data-disclosure-content>
          <div class="scene-cats studio-segments studio-segments--compact" role="group" aria-label="场景主题">
            <AnimatedSelection />
            <button v-for="t in SCENE_THEMES" :key="t.id"
              class="scene-cat-btn" type="button"
              :aria-pressed="pb.sceneTheme === t.id"
              @click="pb.sceneTheme = t.id"><ArchiveIcon :name="t.iconName" /> {{ t.label }}</button>
          </div>
        </div>
      </details>
      <div ref="results" v-content-motion:right="pb.dataReady ? `${sceneCollection}:${pb.sceneTheme}` : false" class="scene-list" role="region" aria-label="工作室场景" tabindex="-1" :aria-busy="pb.dataLoading">
        <ArchiveStatePanel v-if="pb.dataError" compact kind="error" title="创作资料读取失败" :message="pb.dataError">
          <button class="btn btn-ghost btn-sm" type="button" :disabled="pb.dataLoading" :aria-busy="pb.dataLoading" @click="retryData">{{ pb.dataLoading ? '重试中…' : '重新读取' }}</button>
        </ArchiveStatePanel>
        <div v-else-if="!pb.dataReady" class="scene-loading" role="status">{{ pb.dataLoading ? '加载场景库…' : '场景库未就绪' }}</div>
        <div v-else-if="!availableScenes.length" class="scene-empty" role="status">未找到匹配场景</div>
        <button v-for="scene in visibleScenes" :key="scene.id"
          class="scene-card"
          :class="{ 'is-mature': isAdultScene(scene) }"
          data-control-motion
          :aria-pressed="pb.sceneId === scene.id"
          type="button"
          @click="$emit('selectScene', scene)">
          <span class="scene-card-thumb" aria-hidden="true">
            <img
              v-if="!failedThumbs.has(scene.id)"
              :src="sceneThumbSrc(scene.id)"
              :crossorigin="runtimeResourceCors()"
              alt=""
              width="56"
              height="72"
              loading="lazy"
              decoding="async"
              @error="failedThumbs.add(scene.id)"
            />
            <SensitivePreviewVeil
              v-if="isAdultScene(scene) && !failedThumbs.has(scene.id)"
              :src="sceneThumbSrc(scene.id)"
              :crossorigin="runtimeResourceCors()"
            />
            <span v-if="failedThumbs.has(scene.id)" class="scene-card-thumb-fallback">
              <ArchiveIcon name="scene" />
            </span>
          </span>
          <span class="scene-card-body">
            <span class="scene-card-title">
              <ArchiveIcon v-if="pb.sceneId === scene.id" name="success" class="scene-selection-check" />
              <span class="scene-card-name">{{ scene.title }}</span>
            </span>
            <span v-if="scene.story" class="scene-card-story">{{ scene.story }}</span>
            <span class="scene-card-meta">
              <span v-if="personaCoreIds.has(scene.id)" class="scene-core-mark">人设核心</span>
              <span v-if="scene.category" class="scene-cat-tag">{{ scene.category }}</span>
              <span v-if="scene.rating && scene.rating !== 'All'" class="scene-rating-tag">{{ scene.rating }}</span>
            </span>
          </span>
        </button>
        <button v-if="availableScenes.length > sceneLimit" class="btn btn-ghost scene-more"
          type="button" @click="$emit('update:sceneLimit', sceneLimit + 20)">
          加载更多 (+{{ availableScenes.length - sceneLimit }})
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import SensitivePreviewVeil from '@/components/visual/SensitivePreviewVeil.vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { SCENE_THEMES } from '@/config/promptConstants'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import PopularBlueprintPicker from '@/components/popular/PopularBlueprintPicker.vue'
import { useShowcaseAssets } from '@/composables/scene/useShowcaseAssets'
import type { Scene } from '@/stores/promptBuilderStore'
import type { SceneBlueprint } from '@/utils/popularContent'
import '@/assets/css/director/components/DirectorScenesPanel.css'

const pb = usePromptBuilderStore()
const results = ref<HTMLElement | null>(null)
const { entryFor, thumbUrl } = useShowcaseAssets()
const failedThumbs = reactive(new Set<string>())
function sceneThumbSrc(id: string): string {
  return resolveRuntimeUrl(thumbUrl(id) || `/scene-showcase/thumbs/${encodeURIComponent(id)}.jpg`)
}
function isAdultScene(scene: Scene): boolean {
  return scene.rating === 'R18' || entryFor(scene.id)?.rating === 'R18'
}
const currentThemeLabel = computed(() => SCENE_THEMES.find(theme => theme.id === pb.sceneTheme)?.label ?? '全部')
const popularOutfitNames = computed<Record<string, string>>(() => {
  const subject = pb.subject
  if (subject.kind !== 'popular') return {}
  const character = pb.popularCharacters.find(item => item.id === subject.characterId)
  if (!character) return {}
  return Object.fromEntries(character.outfits.map(outfit => [outfit.id, outfit.name]))
})
function retryBlueprints() {
  if (pb.subject.kind === 'popular') void pb.loadPopularCharacter(pb.subject.characterId).catch(() => {})
}
function retryData() {
  if (pb.dataLoading) return
  results.value?.focus({ preventScroll: true })
  emit('retry')
}

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

const emit = defineEmits<{
  retry: []
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
