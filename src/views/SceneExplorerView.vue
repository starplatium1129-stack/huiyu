<template>
  <article class="page scene-discovery">
    <section class="scene-atlas" :data-companion="companionId" aria-labelledby="sceneAtlasTitle">
      <div class="scene-atlas-copy">
        <span class="scene-chapter" aria-hidden="true">SCENE / 01</span>
        <h1 id="sceneAtlasTitle" class="title">灵感场景</h1>
        <p class="scene-atlas-note">挑一幕心动，让故事从这里开始。</p>
      </div>
      <div class="curation-intro">
        <figure class="scene-atlas-portrait" aria-label="陪伴角色">
          <template v-for="character in companions" :key="character">
            <img v-if="companionPortraits[character].src && !companionPortraits[character].failed"
              v-bind="companionPortraits[character].image"
              :class="[character, { current: companionId === character }]"
              :alt="companionId === character ? (character === 'nene' ? '绫地宁宁' : '四季夏目') : ''"
              :aria-hidden="companionId !== character" width="1024" height="1344" decoding="async" />
            <div v-else class="companion-fallback" :class="[character, { current: companionId === character }]"
              role="status" :aria-hidden="companionId !== character">
              <ArchiveIcon name="image" />
              <span class="companion-fallback-text">{{ character === 'nene' ? '绫地宁宁' : '四季夏目' }}的主视觉暂未加载</span>
            </div>
          </template>
          <figcaption class="sr-only" aria-live="polite">{{ companionId === 'nene' ? '「想和你一起，留住这一刻。」' : '「今天的故事，由你来选。」' }}</figcaption>
        </figure>
        <div class="companion-choices">
          <span class="companion-label">陪你翻阅<span v-if="companionPortraits[companionId].failed"> · 角色图片暂未加载</span></span>
          <div class="companion-switch studio-segments" role="group" aria-label="看板娘陪伴选择">
            <AnimatedSelection />
            <button type="button" class="companion-pill nene" :class="{ active: companionId === 'nene' }" :aria-pressed="companionId === 'nene'" @click="manualCompanion = 'nene'">
              <span class="dot"></span>绫地宁宁
            </button>
            <button type="button" class="companion-pill natsume" :class="{ active: companionId === 'natsume' }" :aria-pressed="companionId === 'natsume'" @click="manualCompanion = 'natsume'">
              <span class="dot"></span>四季夏目
            </button>
          </div>
        </div>
      </div>
      <InspirationDeck :rails="moodRails" :scenes="scenes" @select="applyMoodRail" @open="drawerScene = $event" />

    <!-- 筛选随页面滚动，避免多行浮层遮住场景封面。 -->
    <div class="scene-toolbar" :class="{ 'filters-expanded': filtersOpen }">
      <div id="scenePersonalViews" class="scene-personal-nav studio-segments studio-segments--compact" role="group" aria-label="我的场景视图">
        <AnimatedSelection />
        <button type="button" :class="{ active: fTier === 'core' && !showHidden }"
          :aria-pressed="fTier === 'core' && !showHidden"
          @click="showRecommendedScenes">人设核心</button>
        <button type="button" :class="{ active: fTier === 'personal' && !showHidden }"
          :aria-pressed="fTier === 'personal' && !showHidden"
          @click="showPersonalScenes">常用 {{ usedCount }}</button>
        <button type="button" :class="{ active: sortBy === 'favorite' && !showHidden }"
          :aria-pressed="sortBy === 'favorite' && !showHidden"
          @click="showFavoriteScenes">收藏 {{ favoriteCount }}</button>
        <button type="button" :class="{ active: showHidden }"
          :aria-pressed="showHidden"
          @click="showHiddenScenes">已隐藏 {{ hiddenCount }}</button>
        <button type="button" :class="{ active: fTier === 'all' && sortBy === 'smart' && !showHidden }"
          :aria-pressed="fTier === 'all' && sortBy === 'smart' && !showHidden"
          @click="showAllScenes">完整库 {{ availableCount }}</button>
      </div>

      <div class="toolbar-primary">
        <label class="sr-only" for="sceneSearch">搜索场景</label>
        <div class="scene-search-wrap">
          <input ref="searchInput" v-model="searchQuery" type="search" class="scene-search" id="sceneSearch"
            placeholder="寻找雨夜、夏日，或一个心动的镜头…" />
          <button v-if="searchQuery" class="scene-search-clear" type="button" aria-label="清空搜索" @click="searchQuery = ''; searchInput?.focus()"><ArchiveIcon name="close" /></button>
        </div>
        <button
          class="filter-toggle" type="button"
          :class="{ active: filtersOpen || activeFacetCount > 0 }"
          :aria-expanded="filtersOpen ? 'true' : 'false'"
          aria-controls="sceneFacetPanel"
          @click="filtersOpen = !filtersOpen"
        >
          <ArchiveIcon name="filter" />精细筛选<span v-if="activeFacetCount" class="facet-badge">{{ activeFacetCount }}</span>
        </button>
      </div>

      <div class="scene-cats" role="group" aria-label="场景主题">
        <button v-for="d in THEME_DEFS" :key="d.id" type="button" class="scene-cat"
          :class="{ active: activeTheme === d.id }"
          :aria-pressed="activeTheme === d.id ? 'true' : 'false'"
          @click="activeTheme = d.id"><ArchiveIcon :name="d.iconName" /> {{ d.id === 'all' ? '全部分类' : d.label }} {{ themeCount(d.id) }}</button>
      </div>

      <div v-if="activeFilters.length" class="scene-active-filters" aria-label="已选筛选">
        <span>已选</span>
        <button v-for="filter in activeFilters" :key="filter.key" type="button" :aria-label="'移除筛选：' + filter.label" @click="filter.clear()">{{ filter.label }}<ArchiveIcon name="close" /></button>
      </div>

      <div v-if="searchQuery" class="search-intent" aria-live="polite">
        {{ searchIntent.expansion }}<template v-if="searchIntent.intents.length">已理解为：<strong>{{ searchIntent.intents.join(' · ') }}</strong>。</template><template v-else>{{ searchIntent.description }}</template>{{ searchIntent.personal }}
      </div>

      <!-- 精细筛选默认收起 -->
      <div v-show="filtersOpen" v-content-motion="filtersOpen" id="sceneFacetPanel" class="scene-facet-panel">
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
          <span class="mature-hint"><template v-if="adultEnabled">成人 <em>{{ matureCount }}</em> · 已展示</template><template v-else>成人场景 · 仅限本机</template></span>
          <ToggleSwitch v-model="showHidden" class="mature-toggle"><span>管理已隐藏 <em>({{ hiddenCount }})</em></span></ToggleSwitch>
          <button class="scene-reset" type="button" @click="resetFilters">重置全部筛选</button>
        </div>
      </div>
    </div>

    </section>

    <CharacterContextNav v-if="fChar === 'nene' || fChar === 'natsume'" :character-id="fChar" active="scenes" scene-path="/scene-explorer" class="tw:mb-s-3" />

    <header class="scene-results-heading">
      <div><h2>{{ sortBy === 'favorite' && !showHidden ? '我的收藏' : tierLabel }}<span v-if="activeTheme !== 'all'"> · {{ activeThemeLabel }}</span></h2></div>
      <div class="scene-results-meta"><span class="scene-count" role="status" aria-live="polite">{{ loading ? '正在读取…' : loadError ? '读取失败' : `已显示 ${Math.min(visible, filtered.length)} / ${filtered.length} 个场景` }}</span><button v-if="searchQuery || activeTheme !== 'all' || activeFacetCount" class="scene-reset" type="button" @click="resetFilters">重置筛选</button></div>
    </header>

    <ArchiveStatePanel
      v-if="loading"
      kind="loading"
      title="正在读取场景档案"
      message="正在载入角色场景、策展层级和本机偏好。"
    />
    <ArchiveStatePanel
      v-else-if="loadError"
      kind="error"
      title="场景档案读取失败"
      :message="loadError"
    >
      <button class="btn btn-primary" type="button" @click="init">重新读取</button>
    </ArchiveStatePanel>
    <ArchiveStatePanel
      v-else-if="scenes.length === 0"
      kind="empty"
      title="场景档案目前为空"
      message="本地场景数据已读取，但还没有可浏览的场景记录。"
    />
    <ArchiveStatePanel
      v-else-if="paged.length === 0"
      kind="filtered"
      title="没有符合当前条件的场景"
      message="可尝试更换关键词或重置筛选，浏览完整场景档案。"
    >
      <button class="btn btn-primary" type="button" @click="resetFilters">重置筛选</button>
    </ArchiveStatePanel>
    <div v-else v-content-motion="`${activeTheme}:${fTier}:${sortBy}:${showHidden}`" class="scene-grid">
      <SceneCard v-for="s in paged" :key="s.id" :scene="s" mode="grid" completePreview suppressTags
          :class="{ 'scene-flash': flashId === s.id, 'scene-selected': drawerScene?.id === s.id }" :data-scene-id="s.id"
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
              <RouterLink :to="'/prompt-builder?scene=' + encodeURIComponent(s2.id)" class="btn btn-primary scene-draw-action"><ArchiveIcon name="spark" /> 开始绘制</RouterLink>
              <button class="btn btn-quiet btn-sm" type="button" @click.stop="drawerScene = s2"><ArchiveIcon name="book" /> 故事</button>
              <StudioTooltip :content="favs.has(s2.id) ? '取消收藏' : '收藏场景'">
              <button class="btn btn-quiet btn-sm scene-fav" :class="{ saved: favs.has(s2.id) }" type="button" :aria-label="(favs.has(s2.id) ? '取消收藏：' : '收藏：') + s2.title" :aria-pressed="favs.has(s2.id)" @click.stop="toggleFav(s2.id)"><ArchiveIcon :name="favs.has(s2.id) ? 'love' : 'star'" /></button>
              </StudioTooltip>
            </div>
            <details class="ex-more" @click.stop @toggle="rememberDetails(s2.id, $event)"><summary>镜头与更多</summary>
              <DeferredPanel :active="openedDetails.has(s2.id)">
              <div v-if="personalReason(s2)" class="ex-curation">{{ personalReason(s2) }}</div>
              <div class="ex-decision">
                <span>镜头 <strong>{{ dv(s2).shot }}</strong></span>
                <span>光线 <strong>{{ dv(s2).lighting }}</strong></span>
                <span>色调 <strong>{{ dv(s2).color }}</strong></span>
              </div>
              <div class="ex-secondary">
                <RouterLink class="btn btn-ghost btn-sm" :to="quickCreateUrl(s2.id)"><ArchiveIcon name="lightning" /> 直接出图</RouterLink>
              <button class="btn btn-ghost scene-hide-action" type="button" @click.stop="toggleHidden(s2.id)">
                {{ hiddenIds.has(s2.id) ? '↩ 恢复' : '隐藏' }}
              </button>
              </div>
              </DeferredPanel>
            </details>
          </template>
      </SceneCard>
    </div>
    <div v-show="!loading && !loadError && visible < filtered.length" class="scene-load">
      <button class="btn btn-ghost" type="button" @click="visible += PAGE_SIZE">
        加载更多（剩余 {{ filtered.length - visible }}）
      </button>
    </div>

    <SceneStoryDialog v-model="drawerScene" />
  </article>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import SceneCard from '@/components/SceneCard.vue'
import CharacterContextNav from '@/components/library/CharacterContextNav.vue'
import DeferredPanel from '@/components/director/DeferredPanel.vue'
import InspirationDeck from '@/components/scene/InspirationDeck.vue'
import SceneStoryDialog from '@/components/scene/SceneStoryDialog.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import { useRuntimeImage } from '@/composables/useRuntimeImage'
import { SCENE_FILTER_OPTIONS } from '@/composables/scene/useSceneExplorerFilters'
import { useSceneExplorerWorkspace } from '@/composables/scene/useSceneExplorerWorkspace'

const {
  companionId, activeFilters, activeThemeLabel, scenes, manualCompanion, moodRails, applyMoodRail,
  searchQuery, visible, filtered, tierLabel, filtersOpen, activeFacetCount, fTier, showHidden,
  showPersonalScenes, showRecommendedScenes, usedCount, sortBy, showFavoriteScenes, favoriteCount,
  showHiddenScenes, hiddenCount, showAllScenes, availableCount, THEME_DEFS, activeTheme, themeCount,
  searchIntent, fChar, fSeason, fTime, fSeries, fRating, matureCount, adultEnabled, resetFilters,
  loading, loadError, init, paged, flashId, usageFor, isCore, tier, charName, seasonLabel, timeLabel,
  personalReason, drawerScene, dv, quickCreateUrl, toggleHidden, hiddenIds, favs, toggleFav, PAGE_SIZE,
} = useSceneExplorerWorkspace()
const searchInput = ref<HTMLInputElement | null>(null)
const openedDetails = reactive(new Set<string>())
function rememberDetails(id: string, event: Event) {
  if ((event.target as HTMLDetailsElement).open) openedDetails.add(id)
}
const companions = ['nene', 'natsume'] as const
const companionPortraits = reactive({
  nene: useRuntimeImage('/assets/characters/nene-home-cg-1024.webp'),
  natsume: useRuntimeImage('/assets/characters/natsume-home-cg-1024.webp'),
})
// A user-driven switch retries only the selected failed portrait, never a retry loop.
watch(companionId, id => { if (companionPortraits[id].failed) companionPortraits[id].retry() })
</script>

<style scoped src="@/assets/css/scene-discovery-browse.css"></style>
