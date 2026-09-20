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
          <img v-if="!companionFailed[character]"
            :src="'/assets/characters/' + character + '-home-cg-1024.webp'"
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
          <label class="scene-filter-field">角色<select v-model="fChar"><option value="all">全部角色</option><option value="nene">宁宁</option><option value="natsume">夏目</option><option value="triad">双人</option></select></label>
          <label class="scene-filter-field">季节<select v-model="fSeason"><option value="all">全部季节</option><option value="春">春</option><option value="夏">夏</option><option value="秋">秋</option><option value="冬">冬</option></select></label>
          <label class="scene-filter-field">时段<select v-model="fTime"><option value="all">全部时段</option><option value="morning">清晨</option><option value="afternoon">午后</option><option value="sunset">黄昏</option><option value="night">夜晚与深夜</option><option value="dawn">黎明</option></select></label>
          <label class="scene-filter-field">系列<select v-model="fSeries"><option value="all">全部系列</option><option value="after">After Story</option><option value="fanwork">同人</option><option value="active">Active Sync</option></select></label>
          <label class="scene-filter-field">分级<select v-model="fRating"><option value="all">全部分级</option><option value="All">全年龄</option><option value="R15">R15</option><option value="R18">R18</option></select></label>
          <label class="scene-filter-field">层级<select v-model="fTier"><option value="personal">我的常用</option><option value="core">人设核心</option><option value="featured">招牌与精选</option><option value="signature">只看招牌</option><option value="curated">只看精选</option><option value="all">完整库</option></select></label>
          <label class="scene-filter-field">排序<select v-model="sortBy"><option value="smart">智能推荐</option><option value="used">最近常用</option><option value="curated">主理人精选</option><option value="favorite">我的收藏</option><option value="newest">最新加入</option><option value="title">名称A-Z</option></select></label>
        </div>
        <div class="scene-filter-meta">
          <span class="mature-hint" title="本机个人使用，成人内容已常驻展示，仅用模糊遮罩区分">成人 <em>{{ matureCount }}</em> · 已展示</span>
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
    <div v-else class="scene-grid stagger-container">
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
            <details class="ex-more"><summary>镜头与更多</summary>
              <div v-if="personalReason(s2)" class="ex-curation">{{ personalReason(s2) }}</div>
              <div class="ex-decision">
                <span>镜头 <strong>{{ dv(s2).shot }}</strong></span>
                <span>光线 <strong>{{ dv(s2).lighting }}</strong></span>
                <span>色调 <strong>{{ dv(s2).color }}</strong></span>
              </div>
              <div class="ex-secondary">
                <a class="btn btn-ghost btn-sm" :href="quickCreateUrl(s2.id)"><ArchiveIcon name="lightning" /> 直接出图</a>
              <button class="btn btn-ghost scene-hide-action" type="button" @click.stop="toggleHidden(s2.id)">
                {{ hiddenIds.has(s2.id) ? '↩ 恢复' : '隐藏' }}
              </button>
                <button class="btn btn-ghost btn-sm scene-fav" :class="{ saved: favs.has(s2.id) }"
                  type="button" @click.stop="toggleFav(s2.id)"><ArchiveIcon :name="favs.has(s2.id) ? 'love' : 'star'" /> {{ favs.has(s2.id) ? '已收' : '收藏' }}</button>
              </div>
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
              <a class="btn btn-primary" :href="quickCreateUrl(displayedDrawerScene.id)"><ArchiveIcon name="lightning" /> 快速出图</a>
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
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import FluidTransition from "@/components/visual/FluidTransition.vue"
import { ref, reactive, watch } from 'vue'
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

<style scoped>
.page { --page-max: 1100px; padding-top:var(--s-5); }
.subtitle { margin-bottom:0; }

.scene-atlas { position:relative; overflow:hidden; display:grid; grid-template-columns:minmax(0,1fr) auto 200px; grid-template-areas:'copy choices portrait' 'moods moods portrait'; gap:var(--s-3) var(--s-4); margin-bottom:var(--s-4); padding:var(--s-4); border:1px solid var(--border-soft); border-radius:var(--r-xl); background:var(--bg-surface); box-shadow:none; }
/* contrast-exempt: 装饰性巨型水印（SCENE 底噪，4% 透明度、pointer-events:none、无信息含义），
   不是可阅读文本，不适用 WCAG 1.4.3；若日后让它承载信息，删掉本标记并按 4.5:1 选色。 */
.scene-atlas::before { content:none; position:absolute; left:-.04em; bottom:-.22em; color:color-mix(in srgb,var(--text-primary) 4%,transparent); font:800 clamp(4rem,10vw,8rem) var(--font-mono); letter-spacing:-.08em; pointer-events:none; }
.scene-atlas .page-kicker::before { display: none; }
.scene-atlas-copy { grid-area:copy; position:relative; z-index:var(--z-raised); min-width:0; }
.scene-atlas .title { margin-bottom:var(--s-2); font:500 clamp(1.5rem,2.6vw,2rem)/var(--lh-tight) var(--font-display); letter-spacing:-.03em; }
.scene-atlas .subtitle { max-width:38rem; color:var(--text-secondary); line-height:var(--lh-loose); }
.scene-atlas[data-companion="nene"] { --accent: var(--nene-violet); }
.scene-atlas[data-companion="natsume"] { --accent: var(--natsume-amber); }
.scene-atlas-portrait { grid-area:portrait; position: relative; min-height: 180px; margin:0; overflow: hidden; border-radius: var(--r-lg); background: var(--bg-deep); }
.scene-atlas-portrait img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 30%; opacity: 0; transition: opacity var(--motion-atmosphere); }
.scene-atlas-portrait img.current { opacity: 1; }
.scene-atlas-portrait figcaption { position: absolute; inset: auto 0 0; padding: var(--s-2); background: var(--bg-deep); color: var(--text-primary); text-align:center; font: 400 var(--fs-label-sm)/var(--lh-body) var(--font-serif); }
/* 缺图占位：透明底 + z-index 抬到 figcaption 渐变罩之上，占位文字不会被台词底部渐变压淡；
   台词 figcaption 在其下方照常可读。非当前角色的占位与 img 同样以 opacity 隐藏。 */
.scene-atlas-portrait .companion-fallback { position: absolute; z-index: var(--z-raised); inset: 0; display: grid; place-content: center; justify-items: center; gap: var(--s-2); padding-bottom: var(--s-8); color: var(--text-muted); opacity: 0; transition: opacity var(--motion-atmosphere); }
.scene-atlas-portrait .companion-fallback.current { opacity: 1; }
.companion-fallback .archive-icon { width: 40px; height: 40px; }
.companion-fallback-text { max-width: 32ch; padding: 0 var(--s-3); text-align: center; font-size: var(--fs-label-sm); letter-spacing: .04em; }
@media (prefers-reduced-motion: reduce) { .scene-atlas-portrait img, .scene-atlas-portrait .companion-fallback { transition: none; } }
.curation-intro { grid-area:choices; min-width:0; align-self:center; }
.companion-switch { --selection-radius:var(--r-pill); --selection-shadow:inset 0 1px var(--glass-highlight); position:relative; isolation:isolate; display:flex; align-items:center; width:fit-content; max-width:100%; gap:var(--s-1); margin-top:var(--s-3); padding:var(--s-1); border:1px solid var(--workspace-edge); border-radius:var(--r-pill); background:var(--bg-surface); }
.companion-pill { position:relative; z-index:var(--z-raised); display:inline-flex; align-items:center; gap:var(--s-2); padding:var(--s-2) var(--s-3); min-height:44px; border-radius:var(--r-pill); border:1px solid transparent; background:transparent; color:var(--text-muted); font:500 var(--fs-label)/var(--lh-label) var(--font-sans); cursor:pointer; box-shadow:none; transition:color var(--motion-hover); }
.companion-pill .dot { width:6px; height:6px; border-radius:50%; background:var(--cp-accent); }
.companion-pill.nene { --cp-accent:var(--nene-violet); }
.companion-pill.natsume { --cp-accent:var(--natsume-amber); }
.companion-pill:hover, .companion-pill.active { color:var(--text-primary); }
.companion-switch :deep(.animated-selection) { background:color-mix(in srgb,var(--accent) 12%,var(--bg-surface)); border-color:color-mix(in srgb,var(--accent) 32%,var(--border-soft)); }
.mood-rails { grid-area:moods; min-width:0; position:relative; z-index:var(--z-raised); display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--s-2); }
.mood-rail { position:relative; overflow:hidden; min-height:64px; padding:var(--s-2) var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); color:var(--text-primary); text-align:left; background:var(--bg-elevated); cursor:pointer; box-shadow:none; transition:transform var(--motion-hover) var(--ease-out); }
.mood-rail.nene { background:linear-gradient(135deg,color-mix(in srgb,var(--nene-violet) 8%,transparent),color-mix(in srgb,var(--accent) 8%,transparent)),var(--bg-elevated); }
.mood-rail.natsume { background:linear-gradient(135deg,color-mix(in srgb,var(--natsume-amber) 8%,transparent),color-mix(in srgb,var(--text-primary) 10%,transparent)),var(--bg-elevated); }
.mood-rail:hover { border-color:var(--accent); box-shadow:var(--shadow-sm); }
.mood-rail:active { transform:translateY(0) scale(.97); }
@media (hover: hover) and (pointer: fine) {
  .mood-rail:hover { transform:translateY(-3px); }
}
.mood-icon { float:left; margin:var(--s-1) var(--s-2) 0 0; }
.mood-rail strong { display:block; font-size:var(--fs-body-sm); }
.mood-rail small { color:var(--text-muted); font-size:var(--fs-mono-sm); }

.scene-search-wrap { position:relative; margin-bottom:var(--s-4); }
.scene-search { width:100%; padding:var(--s-3) 42px var(--s-3) var(--s-4); background:var(--bg-deep); border:1px solid var(--border-soft); border-radius:var(--r-lg); color:var(--text-primary); font-size:var(--fs-body); outline:none; transition:border-color var(--motion-hover); }
.scene-search:focus { border-color:var(--accent); }
.scene-search::placeholder { color:var(--text-muted); }
.scene-search-clear { position:absolute; top:50%; right:9px; transform:translateY(-50%); width:28px; height:28px; border:0; border-radius:50%; background:transparent; color:var(--text-muted); cursor:pointer; font-size:var(--fs-body-lg); }
.scene-search-clear:hover { color:var(--accent); background:var(--accent-soft); }
.search-intent { min-height:22px; margin:-10px var(--s-1) var(--s-3); color:var(--text-muted); font-size:var(--fs-label-sm); }
:deep(.search-intent strong) { color:var(--accent); }

.scene-toolbar { position:relative; display:grid; gap:var(--s-3); margin-bottom:var(--s-4); }
.toolbar-primary { display:flex; align-items:center; gap:var(--s-2); flex-wrap:wrap; }
.toolbar-primary .scene-search-wrap { flex:1 1 260px; min-width:0; margin:0; }
.toolbar-primary .scene-count { color:var(--text-muted); font:600 var(--fs-mono-sm) var(--font-mono); white-space:nowrap; }
.toolbar-primary .scene-count strong { color:var(--accent); }
.scene-personal-nav { display:flex; align-items:center; gap:var(--s-2); overflow-x:auto; padding-bottom:2px; scrollbar-width:thin; }
.scene-personal-label { flex:0 0 auto; margin-right:2px; color:var(--text-muted); font:700 var(--fs-mono-xs) var(--font-mono); letter-spacing:.08em; text-transform:uppercase; }
.scene-personal-nav button { flex:0 0 auto; min-height:34px; padding:0 13px; border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); color:var(--text-secondary); font:650 var(--fs-label-sm) var(--font-sans); cursor:pointer; transition:border-color var(--motion-hover),background var(--motion-hover),color var(--motion-hover); }
.scene-personal-nav button:hover { border-color:color-mix(in srgb,var(--accent) 45%,var(--border-soft)); color:var(--accent); }
.scene-personal-nav button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.scene-personal-nav button.active { border-color:var(--accent); background:var(--accent-soft); color:var(--accent); font-weight:700; }
.filter-toggle { display:inline-flex; align-items:center; gap:6px; min-height:36px; padding:0 14px; border:1px solid var(--border-soft); border-radius:var(--r-md); background:transparent; color:var(--text-secondary); font:650 var(--fs-label-sm) var(--font-sans); cursor:pointer; transition:border-color var(--motion-hover),background var(--motion-hover),color var(--motion-hover); }
.filter-toggle:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.filter-toggle:hover, .filter-toggle.active { border-color:color-mix(in srgb,var(--accent) 40%,var(--border-soft)); background:var(--accent-soft); color:var(--accent); }
.facet-badge { display:inline-grid; place-items:center; min-width:18px; height:18px; padding:0 5px; border-radius:var(--r-pill); background:var(--accent); color:var(--text-inverse); font:700 var(--fs-mono-xs) var(--font-mono); }
.scene-facet-panel { display:grid; gap:var(--s-3); padding:var(--s-3); border:var(--line-hairline) solid var(--border-soft); border-radius:var(--r-terminal); background:color-mix(in srgb,var(--bg-deep) 54%,transparent); animation:facetIn .22s var(--ease-out) both; }
@keyframes facetIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
@media (prefers-reduced-motion:reduce) { .scene-facet-panel { animation:none; } }
.scene-filter-label { font-size:var(--fs-label-xs); color:var(--text-muted); font-weight:700; letter-spacing:.08em; text-transform:uppercase; margin-bottom:var(--s-2); }
.scene-cats { display:flex; flex-wrap:wrap; gap:var(--s-1); }
.scene-cat { appearance:none; position:relative; padding:7px 15px; border:0; background:transparent; color:var(--text-secondary); cursor:pointer; font:500 var(--fs-body-sm) var(--font-sans); transition:background var(--motion-hover),color var(--motion-hover); }
.scene-cat:hover { border-color:var(--accent); color:var(--accent); }
.scene-cat.active { background:var(--accent-soft); color:var(--accent); box-shadow:inset 0 0 0 1px var(--accent); font-weight:600; }
/* 合并后一个面板里有 7 个字段，4 列更紧凑 */
.scene-facet-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--s-3); }
.scene-filter-field { display:grid; gap:var(--s-1); color:var(--text-muted); font-size:var(--fs-label-xs); font-weight:600; }
.scene-filter-field select { width:100%; padding:8px 10px; background:var(--bg-deep); border:1px solid var(--border-soft); border-radius:var(--r-md); color:var(--text-primary); font:500 var(--fs-label) var(--font-sans); outline:none; }
.scene-filter-field select:focus { border-color:var(--accent); }
.scene-more-filters { border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); overflow:hidden; }
.scene-more-filters summary { list-style:none; display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); padding:var(--s-3); color:var(--text-secondary); cursor:pointer; font-size:var(--fs-label); font-weight:650; }
.scene-more-filters summary::-webkit-details-marker { display:none; }
.scene-more-filters summary:hover { color:var(--text-primary); background:var(--accent-soft); }
.scene-more-filters summary::after { content:'＋'; color:var(--text-muted); }
.scene-more-filters[open] summary::after { content:'−'; }
.scene-more-filters .scene-facet-grid { padding:0 var(--s-3) var(--s-3); grid-template-columns:repeat(4,minmax(0,1fr)); }
.scene-filter-meta { display:flex; align-items:center; justify-content:space-between; gap:var(--s-3); flex-wrap:wrap; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); }
.mature-toggle { display:inline-flex; align-items:center; gap:var(--s-2); color:var(--text-secondary); cursor:pointer; font-size:var(--fs-body-sm); }
.mature-toggle em { font-style:normal; opacity:.6; }
.scene-count { color:var(--text-secondary); font-size:var(--fs-label); }
:deep(.scene-count strong) { color:var(--accent); }
.scene-reset { border:0; background:transparent; color:var(--text-muted); cursor:pointer; font:600 var(--fs-label-sm) var(--font-sans); }
.scene-reset:hover { color:var(--accent); }

.scene-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:var(--s-4); }
.scene-grid :deep(.sc) { border-radius:var(--r-xl); }
.scene-grid :deep(.sc-body) { flex:1; gap:var(--s-2); padding:var(--s-4); }
.scene-grid :deep(.sc-title) { white-space:normal; min-height:2.6em; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; line-height:1.3; }
.scene-grid :deep(.sc-story) { min-height:calc(2em * var(--lh-body)); }
.scene-grid :deep(.sc-meta) { display:none; }
.scene-load { display:flex; justify-content:center; margin-top:var(--s-5); }
.scene-fav.saved { color:var(--accent); border-color:var(--accent); background:var(--accent-soft); }
.scene-flash { outline:3px solid var(--accent); outline-offset:var(--s-1); }

.ex-scene-line { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-1); margin:0 0 var(--s-2); color:var(--text-muted); font-size:var(--fs-mono-sm); }
.ex-scene-line strong { color:var(--accent); font-weight:750; }
.ex-scene-line span+span::before { content:'·'; margin-right:var(--s-1); /* 审计修复：分隔符原用 --border-strong(2.73:1)，改 --text-muted */ color:var(--text-muted); }
.ex-curation { margin:0 0 var(--s-2); color:var(--text-secondary); font-size:var(--fs-label-sm); line-height:var(--lh-body); }
.ex-actions { display:flex; gap:var(--s-2); margin-top:auto; padding-top:var(--s-2); }
.ex-actions .btn { flex:1; justify-content:center; font-weight:700; }
.ex-actions .scene-draw-action {
  border-color:color-mix(in srgb,var(--accent) 44%,var(--border-soft));
  background:var(--accent-soft);
  color:var(--accent);
  box-shadow:none;
}
.ex-actions .scene-draw-action:hover,
.ex-actions .scene-draw-action:focus-visible {
  border-color:var(--accent);
  background:var(--accent);
  color:var(--text-inverse);
  box-shadow:var(--glow-sm);
}
.ex-actions .scene-hide-action { flex:0 0 auto; font-weight:600; }
/* Explicit disclosure keeps story actions discoverable without hover. */
.ex-more { margin-top:var(--s-2); color:var(--text-secondary); }
.ex-more > summary { cursor:pointer; padding:var(--s-2) 0; font-size:var(--fs-label); }
.ex-more[open] .ex-secondary { margin-top:var(--s-2); }

.ex-decision { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); padding:var(--s-2) var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-deep); color:var(--text-secondary); font-size:var(--fs-mono-sm); }
.ex-decision::before { content:'镜头'; color:var(--text-muted); font:750 var(--fs-mono-xs) var(--font-mono); letter-spacing:.08em; }
.ex-decision span+span::before { content:'·'; margin-right:var(--s-1); /* 审计修复：分隔符原用 --border-strong(2.73:1)，改 --text-muted */ color:var(--text-muted); }
.ex-decision strong { color:var(--text-primary); font-weight:650; }
.ex-secondary { display:flex; gap:var(--s-1); flex-wrap:wrap; }
.ex-secondary .btn { flex:1; justify-content:center; min-width:0; }

.story-drawer { position:fixed; inset:0; z-index:var(--z-overlay); display:flex; align-items:center; justify-content:center; padding:var(--s-4); background:var(--art-backdrop); backdrop-filter:blur(6px); }
.story-card { transform-origin:center; width:100%; max-width:480px; padding:var(--s-5); border:1px solid var(--accent); border-radius:var(--r-xl); background:var(--bg-elevated); box-shadow:var(--shadow-lg); }
.story-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--s-3); margin-bottom:var(--s-2); }
.story-card-head h3 { margin:0; color:var(--text-primary); font-size:var(--fs-title-sm); font-weight:800; }
.story-meta { margin-bottom:var(--s-3); color:var(--text-muted); font-size:var(--fs-label-sm); }
.story-body { margin-bottom:var(--s-4); color:var(--text-secondary); font-size:var(--fs-body); line-height:var(--lh-loose); }
.story-actions { display:flex; gap:var(--s-2); }
.story-actions .btn { flex:1; }

:deep(.sc-tier) { flex:0 0 auto; padding:1px var(--s-2); border:1px solid var(--accent); border-radius:var(--r-pill); background:var(--bg-surface); color:var(--accent); font-size:var(--fs-mono-sm); font-weight:800; box-shadow:none; }
:deep(.sc-tier.personal) { color:var(--success); border-color:color-mix(in srgb,var(--success) 70%,var(--border-soft)); }
:deep(.sc-tier.signature) { color:var(--natsume-amber); border-color:var(--natsume-amber); }

@media (max-width:768px) {
  .scene-grid { grid-template-columns:minmax(0,1fr); }

  .ex-decision { display:none; }
  .scene-facet-grid { grid-template-columns:1fr 1fr; }
  .scene-more-filters .scene-facet-grid { grid-template-columns:1fr 1fr; }
  .scene-atlas { grid-template-columns:minmax(0,1fr) 140px; grid-template-areas:'copy portrait' 'choices portrait' 'moods moods'; gap:var(--s-3); }
  .scene-atlas .title { max-width:none; }
  .scene-atlas-portrait { min-height:160px; }
  .mood-rails { display:flex; overflow-x:auto; padding-bottom:3px; }
  .mood-rail { flex:0 0 200px; }
  .scene-cats { flex-wrap:nowrap; overflow-x:auto; padding-bottom:4px; }
  .scene-cat { flex:none; }
}
@media (max-width: 480px) {
  .scene-discovery { padding-top: var(--s-5); }
  .scene-atlas { grid-template-columns:minmax(0,1fr) 100px; grid-template-areas:'copy portrait' 'choices choices' 'moods moods'; padding:var(--s-3); }
  .scene-atlas-portrait { min-height:140px; }
  .companion-switch { margin-top:0; }
  .scene-facet-grid { grid-template-columns:1fr; }
}
@media (prefers-reduced-transparency:reduce) {
  .scene-atlas { background:var(--bg-surface); }
}
</style>

<style scoped src="@/assets/css/scene-discovery-browse.css"></style>
