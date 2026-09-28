<template>
  <article class="page scene-discovery" style="--page-max: 1100px;">
    <section class="scene-atlas" :data-companion="companionId" aria-labelledby="sceneAtlasTitle">
      <div class="scene-atlas-copy">
        <div class="page-kicker eyebrow">场景手帖 · {{ activeThemeLabel }}</div>
        <h1 id="sceneAtlasTitle" class="title">灵感场景</h1>
        <p class="subtitle">挑一个想走进的瞬间，<strong>{{ scenes.length }} 个场景</strong>等你翻阅。</p>
      </div>
      <div class="curation-intro">
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
      <div class="mood-rails" aria-live="polite">
        <button v-for="rail in moodRails" :key="rail.title" type="button" class="mood-rail"
          :class="[rail.character === 'nene' || rail.character === 'natsume' ? rail.character : '']"
          @click="applyMoodRail(rail)">
          <span class="mood-icon"><ArchiveIcon :name="railIconName(rail.icon)" /></span>
          <strong>{{ rail.title }}</strong><small>{{ rail.subtitle }}</small>
        </button>
      </div>
    </section>

    <!-- 筛选随页面滚动，避免多行浮层遮住场景封面。 -->
    <div class="scene-toolbar" :class="{ 'filters-expanded': filtersOpen }">
      <div class="toolbar-primary">
        <label class="sr-only" for="sceneSearch">搜索场景</label>
        <div class="scene-search-wrap">
          <input ref="searchInput" v-model="searchQuery" type="search" class="scene-search" id="sceneSearch"
            placeholder="搜索场景、镜头、时段或关键词（如：雨夜、围围巾、夏目经典感）" />
          <button v-if="searchQuery" class="scene-search-clear" type="button" aria-label="清空搜索" @click="searchQuery = ''; searchInput?.focus()">×</button>
        </div>
        <span class="scene-count" role="status" aria-live="polite">
          已显示 <strong>{{ Math.min(visible, filtered.length) }}</strong>
          <span aria-hidden="true">·</span>
          {{ tierLabel }} {{ filtered.length }}
        </span>
        <button
          class="filter-toggle" type="button"
          :class="{ active: filtersOpen || activeFacetCount > 0 }"
          :aria-expanded="filtersOpen ? 'true' : 'false'"
          aria-controls="sceneFacetPanel scenePersonalViews"
          @click="filtersOpen = !filtersOpen"
        >
          筛选与收藏<span v-if="activeFacetCount" class="facet-badge">{{ activeFacetCount }}</span>
        </button>
      </div>

      <div id="scenePersonalViews" class="scene-personal-nav" aria-label="我的场景视图">
        <span class="scene-personal-label">我的场景</span>
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

      <div class="scene-cats">
        <button v-for="d in THEME_DEFS" :key="d.id" type="button" class="scene-cat"
          :class="{ active: activeTheme === d.id }"
          :aria-pressed="activeTheme === d.id ? 'true' : 'false'"
          @click="activeTheme = d.id"><ArchiveIcon :name="d.iconName" /> {{ d.label }} {{ themeCount(d.id) }}</button>
      </div>

      <div v-if="searchQuery && intentHtml" class="search-intent" aria-live="polite" v-html="intentHtml"></div>

      <!-- 精细筛选默认收起 -->
      <div v-show="filtersOpen" id="sceneFacetPanel" class="scene-facet-panel">
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
    <div v-else v-content-motion="`${activeTheme}:${fTier}:${sortBy}:${showHidden}`" class="scene-grid stagger-container">
      <SceneCard v-for="s in paged" :key="s.id" :scene="s" mode="grid" :clickable="false" suppressTags
          class="stagger-item"
          :class="flashId === s.id ? 'scene-flash' : ''" :data-scene-id="s.id">
          <template #band>
            <span v-if="usageFor(s)" class="sc-tier personal">常用 {{ usageFor(s)?.uses }}</span>
            <span v-if="isCore(s)" class="sc-tier signature">人设核心</span>
            <span v-else-if="tier(s) === 'signature'" class="sc-tier signature">招牌</span>
            <span v-else-if="tier(s) === 'curated'" class="sc-tier curated">精选</span>
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
                <button class="btn btn-ghost btn-sm scene-fav" :class="{ saved: favs.has(s2.id) }"
                  type="button" @click.stop="toggleFav(s2.id)"><ArchiveIcon :name="favs.has(s2.id) ? 'love' : 'star'" /> {{ favs.has(s2.id) ? '已收' : '收藏' }}</button>
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
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import FluidTransition from "@/components/visual/FluidTransition.vue"
import { ref, reactive, watch } from 'vue'
import DeferredPanel from '@/components/director/DeferredPanel.vue'
const openedDetails = reactive(new Set<string>())
function rememberDetails(id: string, event: Event) {
  if ((event.target as HTMLDetailsElement).open) openedDetails.add(id)
}
const searchInput = ref<HTMLInputElement | null>(null)
import SceneCard from '@/components/SceneCard.vue'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useSceneExplorerWorkspace } from "@/composables/scene/useSceneExplorerWorkspace"
const {
drawerEl,companionId,
activeThemeLabel,
scenes,
manualCompanion,
moodRails,
applyMoodRail,
railIconName,
searchQuery,
visible,
filtered,
tierLabel,
filtersOpen,
activeFacetCount,
fTier,
showHidden,
showPersonalScenes,
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
const displayedDrawerScene = ref(drawerScene.value)
watch(drawerScene, value => { if (value) displayedDrawerScene.value = value }, { flush: 'sync' })

useFocusTrap(drawerEl, () => Boolean(drawerScene.value), {
  onEscape: () => { drawerScene.value = null },
})

// ── 陪伴图失败回退：两位角色各记一个失败态，互不牵连 ──
// 失败即撤下对应 img 换占位；切回该角色时重置失败态让 img 重挂重试一次（用户驱动、有界，非递归）。
// error 处理按 v-for 槽位闭包写入自己的键，旧请求的迟到事件不会污染另一位角色的状态。
const companionFailed = reactive<Record<string, boolean>>({})
watch(companionId, (id) => { companionFailed[id] = false })
</script>

<style scoped>@reference "../assets/css/tailwind.css";
.page { --page-max: 1100px; @apply tw:pt-s-5; }
.subtitle { @apply tw:mb-0; }

.scene-atlas { @apply tw:relative tw:overflow-hidden tw:grid; grid-template-columns:minmax(0,1fr) auto 200px; grid-template-areas:'copy choices portrait' 'moods moods portrait'; gap:var(--s-3) var(--s-4); @apply tw:mb-s-4 tw:p-s-4; border:1px solid var(--border-soft); @apply tw:rounded-xl; background:var(--bg-surface); box-shadow:none; }
/* contrast-exempt: 装饰性巨型水印（SCENE 底噪，4% 透明度、pointer-events:none、无信息含义），
   不是可阅读文本，不适用 WCAG 1.4.3；若日后让它承载信息，删掉本标记并按 4.5:1 选色。 */
.scene-atlas::before { content:none; @apply tw:absolute tw:left-[-.04em] tw:bottom-[-.22em]; color:color-mix(in srgb,var(--text-primary) 4%,transparent); font:800 clamp(4rem,10vw,8rem) var(--font-mono); letter-spacing:-.08em; @apply tw:pointer-events-none; }
.scene-atlas .page-kicker::before { @apply tw:hidden; }
.scene-atlas-copy { grid-area:copy; @apply tw:relative; z-index:var(--z-raised); @apply tw:min-w-0; }
.scene-atlas .title { @apply tw:mb-s-2; font:500 clamp(1.5rem,2.6vw,2rem)/var(--lh-tight) var(--font-display); letter-spacing:-.03em; }
.scene-atlas .subtitle { @apply tw:max-w-[38rem] tw:text-secondary tw:leading-loose; }
.scene-atlas[data-companion="nene"] { --accent: var(--nene-violet); }
.scene-atlas[data-companion="natsume"] { --accent: var(--natsume-amber); }
.scene-atlas-portrait { grid-area:portrait; @apply tw:relative tw:min-h-[180px] tw:m-0 tw:overflow-hidden tw:rounded-lg; background: var(--bg-deep); }
.scene-atlas-portrait img { @apply tw:absolute; inset: 0; @apply tw:w-full tw:h-full tw:object-cover; object-position: center 30%; opacity: 0; transition: opacity var(--motion-atmosphere); }
.scene-atlas-portrait img.current { opacity: 1; }
.scene-atlas-portrait figcaption { @apply tw:absolute; inset: auto 0 0; @apply tw:p-s-2; background: var(--bg-deep); @apply tw:text-primary tw:text-center; font: 400 var(--fs-label-sm)/var(--lh-body) var(--font-serif); }
/* 缺图占位：透明底 + z-index 抬到 figcaption 渐变罩之上，占位文字不会被台词底部渐变压淡；
   台词 figcaption 在其下方照常可读。非当前角色的占位与 img 同样以 opacity 隐藏。 */
.scene-atlas-portrait .companion-fallback { @apply tw:absolute; z-index: var(--z-raised); inset: 0; @apply tw:grid; place-content: center; justify-items: center; @apply tw:gap-s-2 tw:pb-s-8 tw:text-muted; opacity: 0; transition: opacity var(--motion-atmosphere); }
.scene-atlas-portrait .companion-fallback.current { opacity: 1; }
.companion-fallback .archive-icon { @apply tw:w-[40px] tw:h-[40px]; }
.companion-fallback-text { max-width: 32ch; padding: 0 var(--s-3); @apply tw:text-center tw:text-label-sm; letter-spacing: .04em; }
@media (prefers-reduced-motion: reduce) { .scene-atlas-portrait img, .scene-atlas-portrait .companion-fallback { transition: none; } }
.curation-intro { grid-area:choices; @apply tw:min-w-0 tw:self-center; }
.companion-switch { --selection-radius:var(--r-pill); --selection-shadow:inset 0 1px var(--glass-highlight); @apply tw:relative tw:isolate tw:flex tw:items-center; width:fit-content; @apply tw:max-w-full tw:gap-s-1 tw:mt-s-3 tw:p-s-1; border:1px solid var(--workspace-edge); @apply tw:rounded-pill; background:var(--bg-surface); }
.companion-pill { @apply tw:relative; z-index:var(--z-raised); @apply tw:inline-flex tw:items-center tw:gap-s-2; padding:var(--s-2) var(--s-3); @apply tw:min-h-[44px] tw:rounded-pill; border:1px solid transparent; background:transparent; @apply tw:text-muted; font:500 var(--fs-label)/var(--lh-label) var(--font-sans); @apply tw:cursor-pointer; box-shadow:none; transition:color var(--motion-hover); }
.companion-pill .dot { @apply tw:w-[6px] tw:h-[6px]; border-radius:50%; background:var(--cp-accent); }
.companion-pill.nene { --cp-accent:var(--nene-violet); }
.companion-pill.natsume { --cp-accent:var(--natsume-amber); }
.companion-pill:hover, .companion-pill.active { @apply tw:text-primary; }
.companion-switch :deep(.animated-selection) { background:color-mix(in srgb,var(--accent) 12%,var(--bg-surface)); border-color:color-mix(in srgb,var(--accent) 32%,var(--border-soft)); }
.mood-rails { grid-area:moods; @apply tw:min-w-0 tw:relative; z-index:var(--z-raised); @apply tw:grid; grid-template-columns:repeat(3,minmax(0,1fr)); @apply tw:gap-s-2; }
.mood-rail { @apply tw:relative tw:overflow-hidden tw:min-h-[64px]; padding:var(--s-2) var(--s-3); border:1px solid var(--border-soft); @apply tw:rounded-md tw:text-primary tw:text-left; background:var(--bg-elevated); @apply tw:cursor-pointer; box-shadow:none; transition:transform var(--motion-hover) var(--ease-out); }
.mood-rail.nene { background:linear-gradient(135deg,color-mix(in srgb,var(--nene-violet) 8%,transparent),color-mix(in srgb,var(--accent) 8%,transparent)),var(--bg-elevated); }
.mood-rail.natsume { background:linear-gradient(135deg,color-mix(in srgb,var(--natsume-amber) 8%,transparent),color-mix(in srgb,var(--text-primary) 10%,transparent)),var(--bg-elevated); }
.mood-rail:hover { @apply tw:border-accent; box-shadow:var(--shadow-sm); }
.mood-rail:active { transform:translateY(0) scale(.97); }
@media (hover: hover) and (pointer: fine) {
  .mood-rail:hover { transform:translateY(-3px); }
}
.mood-icon { float:left; margin:var(--s-1) var(--s-2) 0 0; }
.mood-rail strong { @apply tw:block tw:text-body-sm; }
.mood-rail small { @apply tw:text-muted tw:text-mono-sm; }

.scene-search-wrap { @apply tw:relative tw:mb-s-4; }
.scene-search { @apply tw:w-full; padding:var(--s-3) 42px var(--s-3) var(--s-4); background:var(--bg-deep); border:1px solid var(--border-soft); @apply tw:rounded-lg tw:text-primary tw:text-body; outline:none; transition:border-color var(--motion-hover); }
.scene-search:focus { @apply tw:border-accent; }
.scene-search:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.scene-search::placeholder { @apply tw:text-muted; }
.scene-search-clear { @apply tw:absolute tw:top-[50%] tw:right-[9px]; transform:translateY(-50%); @apply tw:w-[28px] tw:h-[28px]; border:0; border-radius:50%; background:transparent; @apply tw:text-muted tw:cursor-pointer tw:text-body-lg; }
.scene-search-clear:hover { @apply tw:text-accent; background:var(--accent-soft); }
.search-intent { @apply tw:min-h-[22px]; margin:-10px var(--s-1) var(--s-3); @apply tw:text-muted tw:text-label-sm; }
:deep(.search-intent strong) { @apply tw:text-accent; }

.scene-toolbar { @apply tw:relative tw:grid tw:gap-s-3 tw:mb-s-4; }
.toolbar-primary { @apply tw:flex tw:items-center tw:gap-s-2 tw:flex-wrap; }
.toolbar-primary .scene-search-wrap { flex:1 1 260px; @apply tw:min-w-0 tw:m-0; }
.toolbar-primary .scene-count { @apply tw:text-muted; font:600 var(--fs-mono-sm) var(--font-mono); @apply tw:whitespace-nowrap; }
.toolbar-primary .scene-count strong { @apply tw:text-accent; }
.scene-personal-nav { @apply tw:flex tw:items-center tw:gap-s-2 tw:overflow-x-auto tw:pb-[2px]; scrollbar-width:thin; }
.scene-personal-label { flex:0 0 auto; @apply tw:mr-[2px] tw:text-muted; font:700 var(--fs-mono-xs) var(--font-mono); letter-spacing:.08em; @apply tw:uppercase; }
.scene-personal-nav button { flex:0 0 auto; @apply tw:min-h-[34px]; padding:0 13px; border:1px solid var(--border-soft); @apply tw:rounded-md; background:var(--bg-elevated); @apply tw:text-secondary; font:650 var(--fs-label-sm) var(--font-sans); @apply tw:cursor-pointer; transition:border-color var(--motion-hover),background var(--motion-hover),color var(--motion-hover); }
.scene-personal-nav button:hover { border-color:color-mix(in srgb,var(--accent) 45%,var(--border-soft)); @apply tw:text-accent; }
.scene-personal-nav button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.scene-personal-nav button.active { @apply tw:border-accent; background:var(--accent-soft); @apply tw:text-accent tw:font-bold; }
.filter-toggle { @apply tw:inline-flex tw:items-center tw:gap-[6px] tw:min-h-[36px]; padding:0 14px; border:1px solid var(--border-soft); @apply tw:rounded-md; background:transparent; @apply tw:text-secondary; font:650 var(--fs-label-sm) var(--font-sans); @apply tw:cursor-pointer; transition:border-color var(--motion-hover),background var(--motion-hover),color var(--motion-hover); }
.filter-toggle:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.filter-toggle:hover, .filter-toggle.active { border-color:color-mix(in srgb,var(--accent) 40%,var(--border-soft)); background:var(--accent-soft); @apply tw:text-accent; }
.facet-badge { @apply tw:inline-grid; place-items:center; @apply tw:min-w-[18px] tw:h-[18px]; padding:0 5px; @apply tw:rounded-pill; background:var(--accent); @apply tw:text-inverse; font:700 var(--fs-mono-xs) var(--font-mono); }
.scene-facet-panel { @apply tw:grid tw:gap-s-3 tw:p-s-3; border:var(--line-hairline) solid var(--border-soft); border-radius:var(--r-terminal); background:color-mix(in srgb,var(--bg-deep) 54%,transparent); animation:facetIn .22s var(--ease-out) both; }
@keyframes facetIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
@media (prefers-reduced-motion:reduce) { .scene-facet-panel { animation:none; } }
.scene-filter-label { @apply tw:text-label-xs tw:text-muted tw:font-bold; letter-spacing:.08em; @apply tw:uppercase tw:mb-s-2; }
.scene-cats { @apply tw:flex tw:flex-wrap tw:gap-s-1; }
.scene-cat { appearance:none; @apply tw:relative; padding:7px 15px; border:0; background:transparent; @apply tw:text-secondary tw:cursor-pointer; font:500 var(--fs-body-sm) var(--font-sans); transition:background var(--motion-hover),color var(--motion-hover); }
.scene-cat:hover { @apply tw:border-accent tw:text-accent; }
.scene-cat.active { background:var(--accent-soft); @apply tw:text-accent; box-shadow:inset 0 0 0 1px var(--accent); @apply tw:font-semibold; }
/* 合并后一个面板里有 7 个字段，4 列更紧凑 */
.scene-facet-grid { @apply tw:grid; grid-template-columns:repeat(4,minmax(0,1fr)); @apply tw:gap-s-3; }
.scene-filter-field { @apply tw:grid tw:gap-s-1 tw:text-muted tw:text-label-xs tw:font-semibold; }
.scene-filter-field :deep(.studio-select-wrapper) { @apply tw:w-full; }
.scene-more-filters { border:1px solid var(--border-soft); @apply tw:rounded-md; background:var(--bg-surface); @apply tw:overflow-hidden; }
.scene-more-filters summary { list-style:none; @apply tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:p-s-3 tw:text-secondary tw:cursor-pointer tw:text-label; font-weight:650; }
.scene-more-filters summary::-webkit-details-marker { @apply tw:hidden; }
.scene-more-filters summary:hover { @apply tw:text-primary; background:var(--accent-soft); }
.scene-more-filters summary::after { content:'＋'; @apply tw:text-muted; }
.scene-more-filters[open] summary::after { content:'−'; }
.scene-more-filters .scene-facet-grid { padding:0 var(--s-3) var(--s-3); grid-template-columns:repeat(4,minmax(0,1fr)); }
.scene-filter-meta { @apply tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:flex-wrap tw:p-s-3; border:1px solid var(--border-soft); @apply tw:rounded-md; background:var(--bg-surface); }
.mature-toggle { @apply tw:inline-flex tw:items-center tw:gap-s-2 tw:text-secondary tw:cursor-pointer tw:text-body-sm; }
.mature-toggle em { @apply tw:not-italic; opacity:.6; }
.scene-count { @apply tw:text-secondary tw:text-label; }
:deep(.scene-count strong) { @apply tw:text-accent; }
.scene-reset { border:0; background:transparent; @apply tw:text-muted tw:cursor-pointer; font:600 var(--fs-label-sm) var(--font-sans); }
.scene-reset:hover { @apply tw:text-accent; }

.scene-grid { @apply tw:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,20rem),1fr)); @apply tw:gap-s-4; }
.scene-grid :deep(.sc) { @apply tw:rounded-xl; }
.scene-grid :deep(.sc-body) { flex:1; @apply tw:gap-s-2 tw:p-s-4; }
.scene-grid :deep(.sc-title) { @apply tw:whitespace-normal tw:min-h-[2.6em]; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; @apply tw:overflow-hidden; line-height:1.3; }
.scene-grid :deep(.sc-story) { min-height:calc(2em * var(--lh-body)); }
.scene-grid :deep(.sc-meta) { @apply tw:hidden; }
.scene-load { @apply tw:flex tw:justify-center tw:mt-s-5; }
.scene-fav.saved { @apply tw:text-accent tw:border-accent; background:var(--accent-soft); }
.scene-flash { outline:3px solid var(--accent); outline-offset:var(--s-1); }

.ex-scene-line { @apply tw:flex tw:items-center tw:flex-wrap tw:gap-s-1; margin:0 0 var(--s-2); @apply tw:text-muted tw:text-mono-sm; }
.ex-scene-line strong { @apply tw:text-accent; font-weight:750; }
.ex-scene-line span+span::before { content:'·'; @apply tw:mr-s-1; /* 审计修复：分隔符原用 --border-strong(2.73:1)，改 --text-muted */ @apply tw:text-muted; }
.ex-curation { margin:0 0 var(--s-2); @apply tw:text-secondary tw:text-label-sm tw:leading-body; }
.ex-actions { @apply tw:flex tw:gap-s-2 tw:mt-auto tw:pt-s-2; }
.ex-actions .btn { flex:1; @apply tw:justify-center tw:font-bold; }
.ex-actions .scene-draw-action {
  border-color:color-mix(in srgb,var(--accent) 44%,var(--border-soft));
  background:var(--accent-soft);
  @apply tw:text-accent;
  box-shadow:none;
}
.ex-actions .scene-draw-action:hover,
.ex-actions .scene-draw-action:focus-visible {
  @apply tw:border-accent;
  background:var(--accent);
  @apply tw:text-inverse;
  box-shadow:var(--glow-sm);
}
.ex-actions .scene-hide-action { flex:0 0 auto; @apply tw:font-semibold; }
/* Explicit disclosure keeps story actions discoverable without hover. */
.ex-more { @apply tw:mt-s-2 tw:text-secondary; }
.ex-more > summary { @apply tw:cursor-pointer; padding:var(--s-2) 0; @apply tw:text-label; }
.ex-more[open] .ex-secondary { @apply tw:mt-s-2; }

.ex-decision { @apply tw:flex tw:items-center tw:flex-wrap tw:gap-s-2; padding:var(--s-2) var(--s-3); border:1px solid var(--border-soft); @apply tw:rounded-md; background:var(--bg-deep); @apply tw:text-secondary tw:text-mono-sm; }
.ex-decision::before { content:'镜头'; @apply tw:text-muted; font:750 var(--fs-mono-xs) var(--font-mono); letter-spacing:.08em; }
.ex-decision span+span::before { content:'·'; @apply tw:mr-s-1; /* 审计修复：分隔符原用 --border-strong(2.73:1)，改 --text-muted */ @apply tw:text-muted; }
.ex-decision strong { @apply tw:text-primary; font-weight:650; }
.ex-secondary { @apply tw:flex tw:gap-s-1 tw:flex-wrap; }
.ex-secondary .btn { flex:1; @apply tw:justify-center tw:min-w-0; }

.story-drawer { @apply tw:fixed; inset:0; z-index:var(--z-overlay); @apply tw:flex tw:items-center tw:justify-center tw:p-s-4; background:var(--art-backdrop); backdrop-filter:blur(6px); }
.story-card { transform-origin:center; @apply tw:w-full tw:max-w-[480px] tw:p-s-5; border:1px solid var(--accent); @apply tw:rounded-xl; background:var(--bg-elevated); box-shadow:var(--shadow-lg); }
.story-card-head { @apply tw:flex tw:items-start tw:justify-between tw:gap-s-3 tw:mb-s-2; }
.story-card-head h3 { @apply tw:m-0 tw:text-primary tw:text-title-sm tw:font-extrabold; }
.story-meta { @apply tw:mb-s-3 tw:text-muted tw:text-label-sm; }
.story-body { @apply tw:mb-s-4 tw:text-secondary tw:text-body tw:leading-loose; }
.story-actions { @apply tw:flex tw:gap-s-2; }
.story-actions .btn { flex:1; }

:deep(.sc-tier) { flex:0 0 auto; padding:1px var(--s-2); border:1px solid var(--accent); @apply tw:rounded-pill; background:var(--bg-surface); @apply tw:text-accent tw:text-mono-sm tw:font-extrabold; box-shadow:none; }
:deep(.sc-tier.personal) { @apply tw:text-success; border-color:color-mix(in srgb,var(--success) 70%,var(--border-soft)); }
:deep(.sc-tier.signature) { color:var(--natsume-amber); border-color:var(--natsume-amber); }

@media (max-width:768px) {
  .scene-grid { grid-template-columns:minmax(0,1fr); }

  .ex-decision { @apply tw:hidden; }
  .scene-facet-grid { grid-template-columns:1fr 1fr; }
  .scene-more-filters .scene-facet-grid { grid-template-columns:1fr 1fr; }
  .scene-atlas { grid-template-columns:minmax(0,1fr) 140px; grid-template-areas:'copy portrait' 'choices portrait' 'moods moods'; @apply tw:gap-s-3; }
  .scene-atlas .title { max-width:none; }
  .scene-atlas-portrait { @apply tw:min-h-[160px]; }
  .mood-rails { @apply tw:flex tw:overflow-x-auto tw:pb-[3px]; }
  .mood-rail { flex:0 0 200px; }
  .scene-cats { @apply tw:flex-nowrap tw:overflow-x-auto tw:pb-[4px]; }
  .scene-cat { flex:none; }
}
@media (max-width: 480px) {
  .scene-discovery { @apply tw:pt-s-5; }
  .scene-atlas { grid-template-columns:minmax(0,1fr) 100px; grid-template-areas:'copy portrait' 'choices choices' 'moods moods'; @apply tw:p-s-3; }
  .scene-atlas-portrait { @apply tw:min-h-[140px]; }
  .companion-switch { @apply tw:mt-0; }
  .scene-facet-grid { grid-template-columns:1fr; }
}
@media (prefers-reduced-transparency:reduce) {
  .scene-atlas { background:var(--bg-surface); }
}
</style>

<style scoped src="@/assets/css/scene-discovery-browse.css"></style>
