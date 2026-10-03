<template>
  <article class="page scene-discovery">
    <section class="scene-atlas" :data-companion="companionId" aria-labelledby="sceneAtlasTitle">
      <div class="scene-atlas-copy">
        <div class="page-kicker eyebrow">场景手帖 · {{ activeThemeLabel }}</div>
        <h1 id="sceneAtlasTitle" class="title">灵感场景</h1>
      </div>
      <div class="curation-intro">
        <span class="companion-label">陪你翻阅</span>
        <div class="companion-switch" role="group" aria-label="看板娘陪伴选择">
          <AnimatedSelection />
          <button type="button" class="companion-pill nene" :class="{ active: companionId === 'nene' }" :aria-pressed="companionId === 'nene'" @click="manualCompanion = 'nene'">
            <span class="dot"></span>绫地宁宁
          </button>
          <button type="button" class="companion-pill natsume" :class="{ active: companionId === 'natsume' }" :aria-pressed="companionId === 'natsume'" @click="manualCompanion = 'natsume'">
            <span class="dot"></span>四季夏目
          </button>
        </div>
      </div>
      <figure class="scene-atlas-portrait" aria-label="陪伴角色">
        <template v-for="character in ['nene', 'natsume']" :key="character">
          <img :crossorigin="runtimeResourceCors()" v-if="!companionFailed[character]"
            :src="resolveRuntimeUrl('/assets/characters/' + character + '-home-cg-1024.webp')"
            :class="[character, { current: companionId === character }]"
            :alt="companionId === character ? (character === 'nene' ? '绫地宁宁' : '四季夏目') : ''"
            :aria-hidden="companionId !== character" width="1024" height="1344" decoding="async"
            @error="companionFailed[character] = true" />
          <div v-else class="companion-fallback" :class="[character, { current: companionId === character }]"
            role="status" :aria-hidden="companionId !== character">
            <ArchiveIcon name="image" />
            <span class="companion-fallback-text">{{ character === 'nene' ? '绫地宁宁' : '四季夏目' }}的主视觉暂未加载</span>
          </div>
        </template>
        <figcaption aria-live="polite">{{ companionId === 'nene' ? '「想和你一起，留住这一刻。」' : '「今天的故事，由你来选。」' }}</figcaption>
      </figure>
      <InspirationDeck :rails="moodRails" :scenes="scenes" @select="applyMoodRail" />

    <!-- 筛选随页面滚动，避免多行浮层遮住场景封面。 -->
    <div class="scene-toolbar" :class="{ 'filters-expanded': filtersOpen }">
      <div class="toolbar-primary">
        <label class="sr-only" for="sceneSearch">搜索场景</label>
        <div class="scene-search-wrap">
          <input ref="searchInput" v-model="searchQuery" type="search" class="scene-search" id="sceneSearch"
            placeholder="搜索场景、情绪或镜头，如：雨夜、夏目经典感" />
          <button v-if="searchQuery" class="scene-search-clear" type="button" aria-label="清空搜索" @click="searchQuery = ''; searchInput?.focus()"><ArchiveIcon name="close" /></button>
        </div>
        <button
          class="filter-toggle" type="button"
          :class="{ active: filtersOpen || activeFacetCount > 0 }"
          :aria-expanded="filtersOpen ? 'true' : 'false'"
          aria-controls="sceneFacetPanel"
          @click="filtersOpen = !filtersOpen"
        >
          精细筛选<span v-if="activeFacetCount" class="facet-badge">{{ activeFacetCount }}</span>
        </button>
      </div>

      <div id="scenePersonalViews" class="scene-personal-nav" aria-label="我的场景视图">
        <span class="scene-personal-label">浏览范围</span>
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

      <div class="scene-cats" role="group" aria-label="场景主题">
        <button v-for="d in THEME_DEFS" :key="d.id" type="button" class="scene-cat"
          :class="{ active: activeTheme === d.id }"
          :aria-pressed="activeTheme === d.id ? 'true' : 'false'"
          @click="activeTheme = d.id"><ArchiveIcon :name="d.iconName" /> {{ d.id === 'all' ? '全部分类' : d.label }} {{ themeCount(d.id) }}</button>
      </div>

      <div v-if="activeFilters.length" class="scene-active-filters" aria-label="已选筛选">
        <span>已选</span>
        <button v-for="filter in activeFilters" :key="filter.label" type="button" :aria-label="'移除筛选：' + filter.label" @click="filter.clear()">{{ filter.label }}<ArchiveIcon name="close" /></button>
      </div>

      <div v-if="searchQuery && intentHtml" class="search-intent" aria-live="polite" v-html="intentHtml"></div>

      <!-- 精细筛选默认收起 -->
      <div v-show="filtersOpen" v-content-motion="filtersOpen" id="sceneFacetPanel" class="scene-facet-panel">
        <div class="scene-facet-grid">
          <label class="scene-filter-field">角色<StudioSelect v-model="fChar" label="角色" :options="[{ value: 'all', label: '全部角色' }, { value: 'nene', label: '宁宁' }, { value: 'natsume', label: '夏目' }, { value: 'triad', label: '双人' }]" /></label>
          <label class="scene-filter-field">季节<StudioSelect v-model="fSeason" label="季节" :options="[{ value: 'all', label: '全部季节' }, { value: '春', label: '春' }, { value: '夏', label: '夏' }, { value: '秋', label: '秋' }, { value: '冬', label: '冬' }]" /></label>
          <label class="scene-filter-field">时段<StudioSelect v-model="fTime" label="时段" :options="[{ value: 'all', label: '全部时段' }, { value: 'morning', label: '清晨' }, { value: 'afternoon', label: '午后' }, { value: 'sunset', label: '黄昏' }, { value: 'night', label: '夜晚与深夜' }, { value: 'dawn', label: '黎明' }]" /></label>
          <label class="scene-filter-field">系列<StudioSelect v-model="fSeries" label="系列" :options="[{ value: 'all', label: '全部系列' }, { value: 'after', label: 'After Story' }, { value: 'fanwork', label: '同人' }, { value: 'active', label: 'Active Sync' }]" /></label>
          <label class="scene-filter-field">分级<StudioSelect v-model="fRating" label="分级" :options="[{ value: 'all', label: '全部分级' }, { value: 'All', label: '全年龄' }, { value: 'R15', label: 'R15' }, { value: 'R18', label: 'R18' }]" /></label>
          <label class="scene-filter-field">层级<StudioSelect v-model="fTier" label="层级" :options="[{ value: 'personal', label: '我的常用' }, { value: 'core', label: '人设核心' }, { value: 'featured', label: '招牌与精选' }, { value: 'signature', label: '只看招牌' }, { value: 'curated', label: '只看精选' }, { value: 'all', label: '完整库' }]" /></label>
          <label class="scene-filter-field">排序<StudioSelect v-model="sortBy" label="排序" :options="[{ value: 'smart', label: '智能推荐' }, { value: 'used', label: '最近常用' }, { value: 'curated', label: '主理人精选' }, { value: 'favorite', label: '我的收藏' }, { value: 'newest', label: '最新加入' }, { value: 'title', label: '名称A-Z' }]" /></label>
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
      <div><h2>{{ sortBy === 'favorite' && !showHidden ? '我的收藏' : tierLabel }}<span v-if="activeTheme !== 'all'"> · {{ activeThemeLabel }}</span></h2><p>先看画面与故事，再选一幕开始绘制</p></div>
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
      <SceneCard v-for="s in paged" :key="s.id" :scene="s" mode="grid" :clickable="false" suppressTags
          :class="flashId === s.id ? 'scene-flash' : ''" :data-scene-id="s.id">
          <template #band>
            <div class="ex-scene-badges">
            <span v-if="usageFor(s)" class="sc-tier personal">常用 {{ usageFor(s)?.uses }}</span>
            <span v-if="isCore(s)" class="sc-tier signature">人设核心</span>
            <span v-else-if="tier(s) === 'signature'" class="sc-tier signature">招牌</span>
            <span v-else-if="tier(s) === 'curated'" class="sc-tier curated">精选</span>
            </div>
          </template>
          <template #body="{ scene: s2 }">
            <div class="ex-scene-line">
              <span><strong>{{ charName(s2) }}</strong></span>
              <span>{{ s2.emotion || '情绪待定' }}</span>
              <span>{{ [seasonLabel(s2.season), timeLabel(s2.timeOfDay)].filter(Boolean).join(' · ') || '时间不限' }}</span>
            </div>
            <div class="ex-actions">
              <RouterLink :to="'/prompt-builder?scene=' + encodeURIComponent(s2.id)" class="btn btn-primary scene-draw-action"><ArchiveIcon name="spark" /> 开始绘制</RouterLink>
              <button class="btn btn-ghost btn-sm" type="button" @click.stop="drawerScene = s2"><ArchiveIcon name="book" /> 故事</button>
              <StudioTooltip :content="favs.has(s2.id) ? '取消收藏' : '收藏场景'">
              <button class="btn btn-ghost btn-sm scene-fav" :class="{ saved: favs.has(s2.id) }" type="button" :aria-label="(favs.has(s2.id) ? '取消收藏：' : '收藏：') + s2.title" :aria-pressed="favs.has(s2.id)" @click.stop="toggleFav(s2.id)"><ArchiveIcon :name="favs.has(s2.id) ? 'love' : 'star'" /></button>
              </StudioTooltip>
            </div>
            <details class="ex-more" @toggle="rememberDetails(s2.id, $event)"><summary>镜头与更多</summary>
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

    <!-- 故事抽屉（Teleport 渲染到 body；放在根元素内保持单根，
         否则多根组件不会继承 AppLayout 注入的 route-view class） -->
    <Teleport to="body">
      <FluidTransition>
        <div v-show="drawerScene" ref="drawerEl" class="story-drawer" role="dialog" aria-modal="true" :aria-hidden="!drawerScene" aria-label="场景故事"
          @click.self="drawerScene = null">
          <div class="story-card" v-if="displayedDrawerScene">
            <div class="story-card-head">
              <h3><ArchiveIcon name="cherry" /> {{ displayedDrawerScene.title }}</h3>
              <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="关闭故事" @click="drawerScene = null"><ArchiveIcon name="close" /></button>
            </div>
            <div class="story-meta">{{ charName(displayedDrawerScene) }} · {{ seasonLabel(displayedDrawerScene.season) }} · {{ timeLabel(displayedDrawerScene.timeOfDay) }} · {{ displayedDrawerScene.emotion }}</div>
            <div class="story-body">{{ displayedDrawerScene.story || '' }}</div>
            <div class="story-actions">
              <RouterLink class="btn btn-primary" :to="quickCreateUrl(displayedDrawerScene.id)"><ArchiveIcon name="lightning" /> 快速出图</RouterLink>
              <RouterLink class="btn btn-ghost" :to="'/prompt-builder?scene=' + encodeURIComponent(displayedDrawerScene.id)"><ArchiveIcon name="clap" /> 进入工作台调整</RouterLink>
              <button class="btn btn-ghost" type="button" @click="drawerScene = null">关闭</button>
            </div>
          </div>
        </div>
      </FluidTransition>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import CharacterContextNav from '@/components/library/CharacterContextNav.vue'
import InspirationDeck from '@/components/scene/InspirationDeck.vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import FluidTransition from "@/components/visual/FluidTransition.vue"
import { computed, ref, reactive, watch } from 'vue'
import DeferredPanel from '@/components/director/DeferredPanel.vue'
const openedDetails = reactive(new Set<string>())
function rememberDetails(id: string, event: Event) {
  if ((event.target as HTMLDetailsElement).open) openedDetails.add(id)
}
const searchInput = ref<HTMLInputElement | null>(null)
import SceneCard from '@/components/SceneCard.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import { useSceneExplorerWorkspace } from "@/composables/scene/useSceneExplorerWorkspace"
const {
drawerEl,companionId,
activeThemeLabel,
scenes,
manualCompanion,
moodRails,
applyMoodRail,
searchQuery,
visible,
filtered,
tierLabel,
filtersOpen,
activeFacetCount,
fTier,
showHidden,
showPersonalScenes,
showRecommendedScenes,
usedCount,
sortBy,
showFavoriteScenes,
favoriteCount,
showHiddenScenes,
hiddenCount,
showAllScenes,
availableCount,
THEME_DEFS,
activeTheme,
themeCount,
intentHtml,
fChar,
fSeason,
fTime,
fSeries,
fRating,
matureCount,
adultEnabled,
resetFilters,
loading,
loadError,
init,
paged,
flashId,
usageFor,
isCore,
tier,
charName,
seasonLabel,
timeLabel,
personalReason,
drawerScene,
dv,
quickCreateUrl,
toggleHidden,
hiddenIds,
favs,
toggleFav,
PAGE_SIZE
} = useSceneExplorerWorkspace()
const activeFilters = computed(() => [
  ...(fChar.value === 'all' ? [] : [{ label: ({ nene: '宁宁', natsume: '夏目', triad: '双人' } as Record<string, string>)[fChar.value] || fChar.value, clear: () => { fChar.value = 'all' } }]),
  ...(fSeason.value === 'all' ? [] : [{ label: `${fSeason.value}季`, clear: () => { fSeason.value = 'all' } }]),
  ...(fTime.value === 'all' ? [] : [{ label: timeLabel(fTime.value), clear: () => { fTime.value = 'all' } }]),
  ...(fSeries.value === 'all' ? [] : [{ label: ({ after: 'After Story', fanwork: '同人', active: 'Active Sync' } as Record<string, string>)[fSeries.value] || fSeries.value, clear: () => { fSeries.value = 'all' } }]),
  ...(fRating.value === 'all' ? [] : [{ label: fRating.value === 'All' ? '全年龄' : fRating.value, clear: () => { fRating.value = 'all' } }]),
])
const displayedDrawerScene = ref(drawerScene.value)
watch(drawerScene, value => { if (value) displayedDrawerScene.value = value }, { flush: 'sync' })

// ── 陪伴图失败回退：两位角色各记一个失败态，互不牵连 ──
// 失败即撤下对应 img 换占位；切回该角色时重置失败态让 img 重挂重试一次（用户驱动、有界，非递归）。
// error 处理按 v-for 槽位闭包写入自己的键，旧请求的迟到事件不会污染另一位角色的状态。
const companionFailed = reactive<Record<string, boolean>>({})
watch(companionId, (id) => { companionFailed[id] = false })
</script>



<style scoped src="@/assets/css/scene-discovery-browse.css"></style>
