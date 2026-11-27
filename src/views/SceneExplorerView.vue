<template>
  <article class="page scene-discovery" :style="companionThemeStyle" @click.capture="storyDialog?.capture($event)">
    <section class="scene-atlas" data-route-arrive :data-companion="companionId" aria-labelledby="sceneAtlasTitle">
      <div class="scene-atlas-copy">
        <h1 id="sceneAtlasTitle" class="title" data-screentone-furniture>灵感场景</h1>
      </div>
      <div class="curation-intro">
        <figure class="scene-atlas-portrait" aria-label="陪伴角色">
          <template v-for="character in companions" :key="character">
            <img v-if="!companionArtwork[character].failed"
              :src="companionArtwork[character].illustration"
              :class="[character, { current: companionId === character }]"
              :alt="companionId === character ? companionArtwork[character].description : ''"
              :aria-hidden="companionId !== character" width="1024" height="1024" decoding="async" draggable="false"
              @error="companionArtwork[character].failed = true" />
            <div v-else class="companion-fallback" :class="[character, { current: companionId === character }]"
              role="status" :aria-hidden="companionId !== character">
              <ArchiveIcon name="image" />
              <span class="companion-fallback-text">{{ companionArtwork[character].name }}的插画暂未加载</span>
            </div>
          </template>
        </figure>
        <div class="companion-choices">
          <p class="scene-atlas-caption companion-speech" aria-live="polite">{{ companionId === 'nene' ? '「想和你一起，留住这一刻。」' : '「今天的故事，由你来选。」' }}</p>
          <div class="companion-switch studio-segments" data-fluid-glass role="group" aria-label="看板娘陪伴选择">
            <AnimatedSelection />
            <button v-for="character in companions" :key="character" type="button" class="companion-pill" :aria-pressed="companionId === character" @click="manualCompanion = character">
              <img v-if="!companionArtwork[character].avatarFailed" class="companion-avatar" :src="companionArtwork[character].avatar" width="256" height="256" alt="" aria-hidden="true" decoding="async" draggable="false" @error="companionArtwork[character].avatarFailed = true" />
              <ArchiveIcon v-else :name="character" class="companion-avatar" />
              {{ companionArtwork[character].name }}
            </button>
          </div>
        </div>
      </div>
      <InspirationDeck :rails="moodRails" :scenes="scenes" @select="applyMoodRail" @open="drawerScene = $event" @reset="resetFilters" />

    <!-- 单行主工具栏：常用视图直露 + 即时搜索 + 次级筛选进 StudioPopover，首次打开无需懂分类就能找场景。 -->
    <div class="browse-toolbar scene-toolbar">
      <div id="scenePersonalViews" class="scene-personal-nav studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="我的场景视图">
        <AnimatedSelection />
        <button type="button"
          :aria-pressed="fTier === 'core' && !showHidden"
          @click="showRecommendedScenes">人设核心</button>
        <button type="button"
          :aria-pressed="fTier === 'personal' && !showHidden"
          @click="showPersonalScenes">常用 {{ usedCount }}</button>
        <button type="button"
          :aria-pressed="fTier === 'all' && sortBy === 'favorite' && !showHidden"
          @click="showFavoriteScenes">收藏 {{ loading ? '…' : loadError ? '—' : favoriteCount ?? '' }}</button>
        <button type="button"
          :aria-pressed="fTier === 'all' && sortBy === 'smart' && !showHidden"
          @click="showAllScenes">完整库 {{ loading ? '…' : loadError ? '—' : availableCount ?? '' }}</button>
      </div>

      <div class="toolbar-primary">
        <StudioSearch v-model="searchQuery" class="scene-search-wrap" id="sceneSearch" label="搜索场景" placeholder="搜索场景名称、情绪或地点…" />
        <StudioPopover v-model:open="filtersOpen" label="筛选场景" align="end" content-class="scene-filter-popover">
          <template #trigger>
            <button
              class="btn btn-ghost filter-toggle" type="button"
              :class="{ active: filtersOpen || popoverFacetCount > 0 }"
              :aria-expanded="filtersOpen ? 'true' : 'false'"
            >
              <ArchiveIcon name="filter" /><span>{{ showHidden ? '已隐藏 ' + hiddenCount : '筛选与分类' }}</span><span v-if="popoverFacetCount" class="facet-badge">{{ popoverFacetCount }}</span>
            </button>
          </template>
          <div id="sceneFacetPanel" class="scene-facet-panel">
            <div class="scene-popover-section">
              <span class="scene-popover-label">场景主题</span>
              <div class="scene-cats" role="group" aria-label="场景主题">
                <button v-for="d in THEME_DEFS" :key="d.id" type="button" class="scene-cat-btn"
                  :class="{ active: activeTheme === d.id }"
                  :aria-pressed="activeTheme === d.id ? 'true' : 'false'"
                  @click="activeTheme = d.id"><ArchiveIcon :name="d.iconName" /><span>{{ d.id === 'all' ? '全部分类' : d.label }}</span><em>{{ loading ? '…' : loadError ? '—' : themeCount(d.id) }}</em></button>
              </div>
            </div>
            <div class="scene-facet-grid">
              <label class="scene-filter-field">角色<StudioSelect v-model="fChar" label="角色" :options="SCENE_FILTER_OPTIONS.character" /></label>
              <label class="scene-filter-field">季节<StudioSelect v-model="fSeason" label="季节" :options="SCENE_FILTER_OPTIONS.season" /></label>
              <label class="scene-filter-field">时段<StudioSelect v-model="fTime" label="时段" :options="SCENE_FILTER_OPTIONS.time" /></label>
              <label class="scene-filter-field">系列<StudioSelect v-model="fSeries" label="系列" :options="SCENE_FILTER_OPTIONS.series" /></label>
              <label class="scene-filter-field">分级<StudioSelect v-model="fRating" label="分级" :options="SCENE_FILTER_OPTIONS.rating" /></label>
              <label class="scene-filter-field">层级<StudioSelect v-model="fTier" label="层级" :options="SCENE_FILTER_OPTIONS.tier" /></label>
              <label class="scene-filter-field">排序<StudioSelect v-model="sortBy" label="排序" :options="SCENE_FILTER_OPTIONS.sort" /></label>
            </div>
            <div class="scene-filter-meta">
              <span class="mature-hint">成人 <em>{{ matureCount }}</em> · R18 模糊遮罩</span>
              <ToggleSwitch v-model="showHidden" :character="companionId" class="mature-toggle"><span>管理已隐藏 <em>({{ hiddenCount }})</em></span></ToggleSwitch>
              <button class="btn btn-quiet btn-sm scene-reset" type="button" @click="resetFilters">重置全部筛选</button>
            </div>
          </div>
        </StudioPopover>
      </div>

      <div v-if="displayedActiveFilters.length" class="scene-active-filters" aria-label="已选筛选">
        <span>已选</span>
        <button v-for="filter in displayedActiveFilters" :key="filter.key" class="btn btn-ghost btn-sm" type="button" :aria-label="'移除筛选：' + filter.label" @click="filter.clear()">{{ filter.label }}<ArchiveIcon name="close" /></button>
      </div>

      <div v-if="searchQuery && searchIntent.intents.length" class="search-intent" aria-live="polite">
        匹配：<strong>{{ searchIntent.intents.join(' · ') }}</strong>
      </div>
    </div>

    </section>

    <CharacterContextNav v-if="fChar === 'nene' || fChar === 'natsume'" :character-id="fChar" active="scenes" scene-path="/scene-explorer" class="tw:mb-s-3" />

    <header class="scene-results-heading">
      <div><h2>{{ sortBy === 'favorite' && !showHidden ? '我的收藏' : tierLabel }}<span v-if="activeTheme !== 'all'"> · {{ activeThemeLabel }}</span></h2></div>
      <div class="scene-results-meta"><span class="scene-count" role="status" aria-live="polite">{{ loading ? '正在读取…' : loadError ? '读取失败' : `${Math.min(visible, filtered.length)} / ${filtered.length}` }}</span><button v-if="searchQuery || activeTheme !== 'all' || activeFacetCount" class="btn btn-quiet btn-sm scene-reset" type="button" @click="resetFilters">重置筛选</button></div>
    </header>

    <ArchiveStatePanel
      v-if="loading && !scenes.length"
      kind="loading"
      heading-level="h3"
      :character="companionId"
      title="正在加载场景档案…"
    />
    <ArchiveStatePanel
      v-else-if="loadError"
      kind="error"
      heading-level="h3"
      :character="companionId"
      title="场景档案加载失败"
      :message="loadError"
    >
      <button class="btn btn-primary" type="button" @click="init">重新加载</button>
    </ArchiveStatePanel>
    <ArchiveStatePanel
      v-else-if="scenes.length === 0"
      kind="empty"
      heading-level="h3"
      :character="companionId"
      title="暂无收录的场景"
    >
      <template #chibi><AtelierEmptyArt :character="companionId" variant="chibi" /></template>
      <button class="btn btn-primary" type="button" @click="init">重新加载场景库</button>
    </ArchiveStatePanel>
    <ArchiveStatePanel
      v-else-if="!loading && paged.length === 0"
      kind="filtered"
      heading-level="h3"
      :character="companionId"
      :title="sortBy === 'favorite' && !showHidden && !searchQuery ? '还没有收藏的场景' : '没有符合当前条件的场景'"
      :message="sortBy === 'favorite' && !showHidden && !searchQuery ? '在心动的场景卡片上点击爱心即可收藏。' : undefined"
    >
      <template #chibi><AtelierEmptyArt :character="companionId" variant="chibi" /></template>
      <button class="btn btn-primary" type="button" @click="sortBy === 'favorite' && !showHidden && !searchQuery ? showAllScenes() : resetFilters()">{{ sortBy === 'favorite' && !showHidden && !searchQuery ? '浏览全部场景' : '重置筛选' }}</button>
    </ArchiveStatePanel>
    <div v-else ref="listRoot" data-route-arrive class="scene-grid" :aria-busy="loading">
      <SceneCard v-for="(s, index) in paged" :key="s.id" :scene="s" mode="grid" completePreview suppressTags :eager="index < 6"
          data-reveal :data-reveal-key="`scene:${s.id}`"
          :thumb-url="thumbUrl(s.id)" :image-url="imageUrl(s.id)" :preview-pending="samplesPending" :preview-dimensions="thumbDimensions(s.id)" :sample-rating="entryFor(s.id)?.rating"
          :class="{ 'scene-selected': drawerScene?.id === s.id }" :data-scene-id="s.id" :data-list-key="s.id"
          :aria-label="'查看场景故事：' + s.title" :aria-expanded="drawerScene?.id === s.id" @pick="drawerScene = s">
          <template #body="{ scene: s2 }">
            <div class="ex-scene-line">
              <span><strong>{{ charName(s2) }}</strong></span>
              <span>{{ s2.category }}</span>
              <span>{{ [seasonLabel(s2.season), timeLabel(s2.timeOfDay)].filter(Boolean).join(' · ') || '时间不限' }}</span>
              <span v-if="usageFor(s2)" class="scene-curation-note">常用 {{ usageFor(s2)?.uses }}</span>
              <span v-else-if="isCore(s2)" class="scene-curation-note">人设核心</span>
              <span v-else-if="tier(s2) === 'signature' || tier(s2) === 'curated'" class="scene-curation-note">{{ tier(s2) === 'signature' ? '招牌' : '精选' }}</span>
            </div>
            <div class="ex-actions" @click.stop>
              <RouterLink :to="'/prompt-builder?scene=' + encodeURIComponent(s2.id)" class="btn btn-primary btn-sm scene-draw-action"><ArchiveIcon name="spark" /> 开始绘制</RouterLink>
              <button class="btn btn-quiet btn-sm" type="button" @click.stop="drawerScene = s2"><ArchiveIcon name="book" /> 故事</button>
              <StudioTooltip :content="favs.has(s2.id) ? '取消收藏' : '收藏场景'">
                <StudioFavoriteButton
                  class="btn btn-quiet btn-sm btn-icon scene-fav"
                  :class="{ saved: favs.has(s2.id) }"
                  :active="favs.has(s2.id)"
                  :label="(favs.has(s2.id) ? '取消收藏：' : '收藏：') + s2.title"
                  @click.stop="toggleFav(s2.id)"
                />
              </StudioTooltip>
            </div>
            <details class="ex-more" @click.stop @toggle="rememberDetails(s2.id, $event)"><StudioDisclosureSummary>镜头与更多</StudioDisclosureSummary>
              <div data-disclosure-content>
              <DeferredPanel :active="openedDetails.has(s2.id)">
              <div v-if="personalReason(s2)" class="ex-curation">{{ personalReason(s2) }}</div>
              <div class="ex-decision">
                <span>镜头 <strong>{{ dv(s2).shot }}</strong></span>
                <span>光线 <strong>{{ dv(s2).lighting }}</strong></span>
                <span>色调 <strong>{{ dv(s2).color }}</strong></span>
              </div>
              <div class="ex-secondary">
                <RouterLink class="btn btn-ghost btn-sm" :to="quickCreateUrl(s2.id)"><ArchiveIcon name="lightning" /> 直接出图</RouterLink>
              <button class="btn btn-ghost btn-sm" type="button" @click.stop="toggleHidden(s2.id)">
                {{ hiddenIds.has(s2.id) ? '恢复' : '隐藏' }}
              </button>
              </div>
              </DeferredPanel>
              </div>
            </details>
          </template>
      </SceneCard>
    </div>
    <p v-if="!loading && !loadError && paged.length" ref="loadSentinel" class="scene-load">
      {{ visible < filtered.length ? '继续向下浏览，自动加载更多场景' : '已显示全部场景' }}
    </p>

    <SceneStoryDialog ref="storyDialog" v-model="drawerScene" :scenes="filtered" @after-close="finishSceneClose" />
  </article>
</template>

<script setup lang="ts">
import { computed, ref, reactive, watch } from 'vue'
import { useShowcaseAssets } from '@/composables/scene/useShowcaseAssets'
import { useCharacterAtmosphere } from '@/composables/useCharacterAtmosphere'
import SceneCard from '@/components/SceneCard.vue'
import CharacterContextNav from '@/components/library/CharacterContextNav.vue'
import DeferredPanel from '@/components/director/DeferredPanel.vue'
import InspirationDeck from '@/components/scene/InspirationDeck.vue'
import SceneStoryDialog from '@/components/scene/SceneStoryDialog.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioPopover from '@/components/ui/StudioPopover.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import StudioFavoriteButton from '@/components/ui/StudioFavoriteButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import AtelierEmptyArt from '@/components/visual/AtelierEmptyArt.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import neneCompanion from '@/assets/illustrations/nene-companion-512.webp'
import natsumeCompanion from '@/assets/illustrations/natsume-companion-512.webp'
import neneAvatar from '@/assets/illustrations/nene-avatar-256.webp'
import natsumeAvatar from '@/assets/illustrations/natsume-avatar-256.webp'
import { SCENE_FILTER_OPTIONS } from '@/composables/scene/useSceneExplorerFilters'
import { useSceneExplorerWorkspace } from '@/composables/scene/useSceneExplorerWorkspace'
import { useListTransition } from '@/composables/useListTransition'
import { useScrollReveal } from '@/composables/useScrollReveal'

const {
  companionId, activeFilters, activeThemeLabel, scenes, manualCompanion, moodRails, applyMoodRail,
  searchQuery, visible, filtered, listRoot, loadSentinel, tierLabel, filtersOpen, activeFacetCount, fTier, showHidden,
  showPersonalScenes, showRecommendedScenes, usedCount, sortBy, showFavoriteScenes, favoriteCount,
  hiddenCount, showAllScenes, availableCount, THEME_DEFS, activeTheme, themeCount,
  searchIntent, fChar, fSeason, fTime, fSeries, fRating, matureCount, resetFilters,
  loading, loadError, init, paged, usageFor, isCore, tier, charName, seasonLabel, timeLabel,
  personalReason, drawerScene, finishSceneClose, dv, quickCreateUrl, toggleHidden, hiddenIds, favs, toggleFav,
} = useSceneExplorerWorkspace()
const companionThemeStyle = useCharacterAtmosphere(() => companionId.value, () => [])
const displayedActiveFilters = computed(() => {
  if (activeTheme.value === 'all') return activeFilters.value
  return [
    { key: 'theme', label: `主题：${activeThemeLabel.value}`, clear: () => { activeTheme.value = 'all' } },
    ...activeFilters.value,
  ]
})
const popoverFacetCount = computed(() => activeFacetCount.value + Number(activeTheme.value !== 'all'))
const { entryFor, thumbUrl, imageUrl, thumbDimensions, initialLoading: samplesPending } = useShowcaseAssets()
useListTransition(listRoot, () => paged.value.map(scene => scene.id))
useScrollReveal()
const storyDialog = ref<InstanceType<typeof SceneStoryDialog> | null>(null)
const openedDetails = reactive(new Set<string>())
function rememberDetails(id: string, event: Event) {
  if ((event.target as HTMLDetailsElement).open) openedDetails.add(id)
}
const companions = ['nene', 'natsume'] as const
const companionArtwork = reactive({
  nene: { name: '绫地宁宁', description: 'Q版宁宁抱着灵感画册，陪你挑选场景', illustration: neneCompanion, avatar: neneAvatar, failed: false, avatarFailed: false },
  natsume: { name: '四季夏目', description: 'Q版夏目拿着咖啡与书签，陪你翻阅灵感', illustration: natsumeCompanion, avatar: natsumeAvatar, failed: false, avatarFailed: false },
})
// A new selection may retry its bundled illustration; failures never trigger a loop.
watch(companionId, id => { companionArtwork[id].failed = false; companionArtwork[id].avatarFailed = false })
</script>

<style scoped src="@/assets/css/scene-discovery-browse.css"></style>
