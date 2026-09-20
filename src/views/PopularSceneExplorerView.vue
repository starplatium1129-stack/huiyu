<template>
  <article class="page library-page popular-scene-library" style="--page-max:1500px;" :style="{ '--character-ornament': portraitPalette.accent }">
    <header class="library-header"><div><div class="page-kicker">SCENE LIBRARY / 角色场景库</div><h1>角色场景</h1><p>选角色、挑场景，再带着完整设定进入绘图工作台。</p></div><RouterLink :to="'/character?character=' + encodeURIComponent(selectedId)" class="btn btn-ghost">查看角色档案</RouterLink></header>
    <div class="library-layout">
      <BrowsingCharacterDirectory :items="directoryItems" :selected-id="selectedId" @select="selectCharacter" />
      <div class="library-detail">
    <section class="pop-hero">
      <div class="pop-hero-copy">
        <div class="page-kicker">{{ franchiseLabel(franchiseKey(selectedCharacter?.franchise || '')) }}</div>
        <h2>{{ selectedCharacter?.displayName || '选择一个角色' }}</h2>
        <div class="pop-hero-stat" aria-label="场景统计">
          <strong>{{ totalScenes }}</strong><span>场景蓝图</span>
          <strong class="adult">{{ adultCount }}</strong><span>成人场景</span>
        </div>
      </div>
    </section>

    <ArchiveStatePanel v-if="loading" kind="loading" title="正在读取角色场景" message="正在载入热门角色档案与场景蓝图。" />
    <ArchiveStatePanel v-else-if="loadError" kind="error" title="角色场景读取失败" :message="loadError">
      <button class="btn btn-primary" type="button" @click="init">重新读取</button>
    </ArchiveStatePanel>

    <template v-else>
      <!-- 工具栏：第一行 搜索+结果数+分级筛选+成人开关，第二行 场景分类（全部最左、成人垫底独立样式） -->
      <div class="pop-toolbar">
        <div class="pop-toolbar-row">
          <label class="sr-only" for="popularSceneSearch">搜索场景</label>
          <input v-model="query" type="search" id="popularSceneSearch" class="pop-search"
            placeholder="搜索场景标题、描述、地点或氛围（如：浴、黑丝、月光）" />
          <div class="pop-rating-filters" role="group" aria-label="分级筛选">
            <button v-for="r in RATING_OPTS" :key="r.v" type="button" class="pop-rating-pill"
              :class="{ active: ratingFilter === r.v, ['rating-' + r.v]: r.v !== 'all' }"
              :aria-pressed="ratingFilter === r.v"
              @click="ratingFilter = r.v">{{ r.l }}</button>
          </div>
          <span class="pop-count" role="status">已显示 <strong>{{ filtered.length }}</strong> / {{ pool.length }}</span>
          <span class="pop-count mature-hint" :title="showMature ? '本机成人场景可浏览，R18 样张保留模糊遮罩' : '成人场景仅限本机访问'">{{ showMature ? `成人 ${adultCount} · 已展示` : '成人场景 · 仅限本机' }}</span>
        </div>
        <div class="pop-cats" role="group" aria-label="场景分类">
          <button v-for="cat in categories" :key="cat.id" type="button" class="pop-cat"
            :class="{ active: category === cat.id, adult: cat.id === '成人' }"
            :aria-pressed="category === cat.id"
            @click="category = cat.id">{{ cat.label }}<em>{{ cat.count }}</em></button>
        </div>
      </div>

      <div v-if="filtered.length === 0" class="pop-empty">
        <p>没有符合当前条件的场景，换个关键词或分类试试。</p>
        <button class="btn btn-ghost" type="button" @click="resetFilters">重置筛选</button>
      </div>

      <!-- 场景卡片网格 -->
      <div class="pop-grid">
        <article v-for="blueprint in filtered" :key="blueprint.id" class="pop-card"
          :class="{ adult: blueprint.adult }" :data-blueprint-id="blueprint.id">
          <!-- 样张缩略图：与灵感场景一致的真实样张预览；仅角色专属蓝图有样张 -->
          <RouterLink v-if="thumbSrc(blueprint)" class="pop-thumb" :class="{ 'is-missing': thumbFailed[thumbSrc(blueprint)] }" :to="drawUrl(blueprint)"
            :aria-label="`以「${blueprint.title}」开始绘制`">
            <span class="pop-thumb-skeleton" :class="{ visible: !thumbState[thumbSrc(blueprint)] && !thumbFailed[thumbSrc(blueprint)] }" aria-hidden="true"></span>
            <img :src="thumbSrc(blueprint)" alt="" loading="lazy" decoding="async"
              :class="{
                'pop-thumb-r18': sampleRatingOf(blueprint) === 'R18',
                'pop-thumb-missing': thumbFailed[thumbSrc(blueprint)],
                'pop-thumb-ready': thumbState[thumbSrc(blueprint)],
              }"
              @load="onThumbLoad(thumbSrc(blueprint))" @error="onThumbError(thumbSrc(blueprint))" />
            <span v-if="thumbFailed[thumbSrc(blueprint)]" class="pop-preview-missing">样张暂未就绪 · 可先查看场景</span>
            <span v-else-if="sampleRatingOf(blueprint) === 'R18'" class="pop-thumb-hint">R18 · 悬停预览</span>
          </RouterLink>
          <header class="pop-card-head">
            <h3>{{ blueprint.title }}</h3>
            <span v-if="sampleRatingOf(blueprint) !== 'All'" class="pop-rating" :class="'rating-' + sampleRatingOf(blueprint)">{{ sampleRatingOf(blueprint) }}</span>
          </header>
          <p class="pop-desc">{{ blueprint.description }}</p>
          <div class="pop-meta">
            <span>{{ blueprint.category }}</span>
            <span>{{ blueprint.location }}</span>
            <span>{{ timeLabel(blueprint.timeOfDay) }}</span>
            <span>{{ blueprint.recommendedSize.replace('x', '×') }}</span>
          </div>
          <div class="pop-decision">
            <span>镜头 <strong>{{ shotLabel(blueprint) }}</strong></span>
            <span>光线 <strong>{{ lightLabel(blueprint) }}</strong></span>
            <span>色调 <strong>{{ moodLabel(blueprint) }}</strong></span>
            <span v-if="blueprint.adult" class="pop-artist">画师 <strong>{{ artistLabel(blueprint) }}</strong></span>
          </div>
          <footer class="pop-card-actions">
            <RouterLink class="btn btn-primary pop-draw-action" :to="drawUrl(blueprint)">
              <ArchiveIcon name="spark" /> 开始绘制
            </RouterLink>
          </footer>
        </article>
      </div>
    </template>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSceneStore } from '@/stores/sceneStore'
import BrowsingCharacterDirectory from '@/components/library/BrowsingCharacterDirectory.vue'
import {
  inferBlueprintDecisions,
  type PopularCharacter,
  type SceneBlueprint,
} from '@/utils/popularContent'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { characterParticleTheme } from '@/utils/characterParticleTheme'
import { franchiseLabel, franchiseKey } from '@/utils/franchiseLabel'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

const route = useRoute()
const router = useRouter()
const sceneStore = useSceneStore()

const loading = ref(true)
const loadError = ref('')
const query = ref('')
const selectedId = ref('')
const category = ref('all')
const ratingFilter = ref<'all' | 'All' | 'R15' | 'R18'>('all')
const RATING_OPTS = [
  { v: 'all', l: '全部分级' },
  { v: 'All', l: '全年龄' },
  { v: 'R15', l: 'R15' },
  { v: 'R18', l: 'R18' }
] as const
/** 成人场景仅限本机，远程和未知来源默认拒绝。 */
const showMature = isLocalStudioHost()

const characters = computed<PopularCharacter[]>(() => sceneStore.popularCharacters)
const allBlueprints = computed<SceneBlueprint[]>(() => sceneStore.sceneBlueprints)

const directoryItems = computed(() => characters.value.map(character => ({
  id: character.id, name: character.displayName, source: character.franchise, aliases: character.aliases,
  image: popularPortraitSrc(character.id),
})))

/** 当前角色的全部蓝图（资格按成熟开关收敛）。 */
const selectedCharacter = computed(() =>
  characters.value.find(item => item.id === selectedId.value) ?? null,
)
// Keep the shared character palette on the chapter ornament without a particle canvas.
const portraitPalette = computed(() => characterParticleTheme(selectedId.value, selectedCharacter.value?.franchise))
const pool = computed<SceneBlueprint[]>(() =>
  allBlueprints.value.filter(bp =>
    bp.characterId === selectedId.value
    && (!(bp.adult || bp.sampleRating === 'R18') || (showMature && selectedCharacter.value?.adultEligibility === 'adult')),
  ),
)

// 统计口径统一为「当前角色的可浏览池」，与成人数量同源（header 不再显示全局 336 与
// 单人成人数的混搭数字）。
const totalScenes = computed(() => pool.value.length)
const adultCount = computed(() => pool.value.filter(bp => bp.adult).length)

/** 分类条稳定排序：全部最左 → 优先序列表 → 其余按数量降序 → 中文排序；成人固定垫底。 */
const CATEGORY_ORDER = ['全部', '现代日常', '温馨日常', '和风奇幻', '奇幻', '泰拉日常', '泰拉都市', '泰拉自然']
const categories = computed(() => {
  const counts = new Map<string, number>()
  counts.set('all', pool.value.length)
  for (const bp of pool.value) {
    const key = bp.adult ? '成人' : bp.category
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  // 2026-08-16 修复：counts 的键是 'all'，旧代码按 label==='全部' 匹配永远落空，
  // 「全部」按钮一直渲染成英文 "all"。
  return [...counts.entries()]
    .map(([key, count]) => ({ id: key === 'all' ? 'all' : key, label: key === 'all' ? '全部' : key, count }))
    .sort((a, b) => {
      if (a.label === '成人' || a.id === '成人') return 1
      if (b.label === '成人' || b.id === '成人') return -1
      const ia = CATEGORY_ORDER.indexOf(a.label)
      const ib = CATEGORY_ORDER.indexOf(b.label)
      if (ia >= 0 || ib >= 0) {
        const rankA = ia >= 0 ? ia : Number.MAX_SAFE_INTEGER
        const rankB = ib >= 0 ? ib : Number.MAX_SAFE_INTEGER
        if (rankA !== rankB) return rankA - rankB
      }
      if (a.count !== b.count) return b.count - a.count
      return a.label.localeCompare(b.label, 'zh-CN')
    })
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return pool.value.filter(bp => {
    if (ratingFilter.value !== 'all') {
      const r = sampleRatingOf(bp)
      if (r !== ratingFilter.value) return false
    }
    if (category.value !== 'all' && (bp.adult ? '成人' : bp.category) !== category.value) return false
    if (!q) return true
    return [bp.title, bp.description, bp.location, bp.promptProse, bp.category, bp.mood]
      .filter(Boolean)
      .some(text => String(text).toLowerCase().includes(q))
  })
})

const SHOT_LABELS: Record<string, string> = {
  close: '特写', medium: '半身', wide: '全景', pov: '第一人称',
  high: '俯视', low: '仰视', side: '侧面', turn: '回眸', over: '自拍', detail: '细节',
}
const LIGHT_LABELS: Record<string, string> = {
  golden: '黄金光', window: '窗光', back: '逆光', moon: '月光',
  lantern: '灯笼光', overcast: '阴天光',
}
const MOOD_LABELS: Record<string, string> = {
  warmth: '暖色', calm: '平静', tension: '张力', sad: '忧郁', joy: '欢快',
}

function decision(blueprint: SceneBlueprint) {
  return inferBlueprintDecisions(blueprint)
}
function shotLabel(blueprint: SceneBlueprint): string {
  const shot = decision(blueprint).shot
  return shot ? (SHOT_LABELS[shot] || shot) : '自动'
}
function lightLabel(blueprint: SceneBlueprint): string {
  const lighting = decision(blueprint).lighting
  return lighting ? (LIGHT_LABELS[lighting] || lighting) : '自动'
}
function moodLabel(blueprint: SceneBlueprint): string {
  const mood = decision(blueprint).colorMood
  return mood ? (MOOD_LABELS[mood] || mood) : '自动'
}
function artistLabel(blueprint: SceneBlueprint): string {
  return blueprint.adultArtistHint?.replace(/^@/, '') ?? ''
}
function timeLabel(value: string): string {
  return ({ morning: '清晨', afternoon: '午后', sunset: '黄昏', evening: '傍晚', night: '夜晚', late_night: '深夜', day: '白天', noon: '中午' } as Record<string, string>)[value] || value || ''
}

function selectCharacter(id: string) {
  selectedId.value = id
  if (route.query.character !== id) void router.replace({ query: { ...route.query, character: id } })
  category.value = 'all'
  query.value = ''
}
function drawUrl(blueprint: SceneBlueprint): string {
  return `/prompt-builder?popular=${encodeURIComponent(selectedId.value)}&blueprint=${encodeURIComponent(blueprint.id)}`
}
function resetFilters() {
  query.value = ''
  category.value = 'all'
  ratingFilter.value = 'all'
}

/** 样张视觉定级：缺省按成人蓝图推导（R18/All）；2026-08-15 起样张实际画面定级优先。 */
function sampleRatingOf(blueprint: SceneBlueprint): string {
  if (blueprint.sampleRating === 'SFW') return 'All'
  return blueprint.sampleRating || (blueprint.adult ? 'R18' : 'All')
}

/** 样张缩略图：与灵感场景一致，路径为展示库样张 `pc_<角色>_<蓝图>`；通用成人蓝图无样张。 */
const thumbVersion = ref(Date.now())
const thumbState = ref<Record<string, boolean>>({})
const thumbFailed = ref<Record<string, boolean>>({})
function thumbSrc(blueprint: SceneBlueprint): string {
  if (!blueprint.characterId || !selectedId.value) return ''
  return `/scene-showcase/thumbs/pc_${selectedId.value}_${blueprint.id}.jpg?v=${thumbVersion.value}`
}
function onThumbLoad(src: string) {
  thumbState.value = { ...thumbState.value, [src]: true }
}
function onThumbError(src: string) {
  thumbFailed.value = { ...thumbFailed.value, [src]: true }
}

async function init() {
  loading.value = true
  loadError.value = ''
  try {
    // 元数据（含热门角色 + 场景蓝图）随 core 加载一起就位，不拉全量宁宁/夏目分片。
    await sceneStore.ensureCore()
    if (sceneStore.error) throw new Error(sceneStore.error)
    const charParam = typeof route.query.character === 'string' ? route.query.character : ''
    const fallback = characters.value[0]?.id ?? ''
    selectedId.value = characters.value.some(c => c.id === charParam) ? charParam : fallback
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

onMounted(() => { void init() })
</script>

<style scoped>
.character-find { display: flex; align-items: center; gap: var(--s-3); margin-bottom: var(--s-4); }
.character-find input { width: min(440px, 100%); padding: var(--s-3) var(--s-4); border: 1px solid var(--border-soft); border-radius: var(--r-md); background: var(--bg-deep); color: var(--text-primary); font: inherit; }
.character-find-empty { color: var(--text-muted); font-size: var(--fs-label); margin: var(--s-3) 0; }

.page { --page-max: 1100px; }
.title { margin-bottom: var(--s-3); }

.pop-hero {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: minmax(0, .94fr) minmax(300px, 1fr);
  margin-bottom: var(--s-4);
  overflow: hidden;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xl);
  background:
    radial-gradient(24rem 16rem at 6% 10%, var(--rella-glow-cyan), transparent 62%),
    linear-gradient(145deg, var(--glass-highlight), transparent 28%),
    linear-gradient(160deg, color-mix(in srgb, var(--rella-night-soft) 60%, transparent), transparent 72%),
    var(--bg-surface);
  box-shadow: var(--shadow-glass-sm);
}
.pop-hero-copy {
  position: relative;
  z-index: var(--z-base);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--s-3);
  padding: var(--s-5);
}
.pop-hero-copy .subtitle { color: var(--text-secondary); line-height: var(--lh-loose); margin: 0; }
.pop-hero-field {
  min-width: 0;
  /* 剪影点阵需要足够高度承载人物细节（脸部/服装结构） */
  min-height: 330px;
  border-left: 1px solid color-mix(in srgb, var(--border-soft) 72%, transparent);
}
.pop-preview-missing { position: absolute; inset: 0; display: grid; place-items: center; padding: var(--s-4); color: var(--text-secondary); background: var(--bg-elevated); font-size: var(--fs-label); text-align: center; }
.pop-hero-stat {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px var(--s-4);
  padding: var(--s-3) var(--s-4);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  background: var(--bg-elevated);
  font: 650 var(--fs-mono-xs) var(--font-mono);
  color: var(--text-muted);
  letter-spacing: .08em;
  text-transform: uppercase;
}
.pop-hero-stat strong { font-size: var(--fs-title-sm); color: var(--accent); line-height: var(--lh-flush); }
.pop-hero-stat strong.adult { color: var(--danger-text); }
.pop-hero-stat span { margin-left: 4px; }

.pop-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-3);
  margin-bottom: var(--s-4);
  padding: var(--s-3);
  border: 1px solid color-mix(in srgb, var(--archive-cyan) 18%, var(--border-soft));
  border-radius: var(--r-dossier);
  background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
  box-shadow: var(--shadow-glass-sm);
  -webkit-backdrop-filter: blur(20px) saturate(130%);
  backdrop-filter: blur(20px) saturate(130%);
}
.pop-toolbar-row { flex: 1 1 100%; display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; }
.pop-search {
  flex: 1 1 280px;
  min-width: 0;
  padding: var(--s-3) var(--s-4);
  background: var(--bg-deep);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  color: var(--text-primary);
  font-size: var(--fs-body);
  outline: none;
}
.pop-search:focus { border-color: var(--accent); }
.pop-search::placeholder { color: var(--text-muted); }
.pop-rating-filters { display: inline-flex; align-items: center; gap: 4px; }
.pop-rating-pill {
  padding: 4px 10px;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-pill);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font: 600 var(--fs-mono-xs) var(--font-mono);
  cursor: pointer;
  transition: border-color var(--motion-hover) var(--ease-out), background var(--motion-hover) var(--ease-out), color var(--motion-hover) var(--ease-out);
}
.pop-rating-pill:hover { border-color: var(--border-strong); color: var(--text-primary); }
.pop-rating-pill:focus-visible,
.pop-cat:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.pop-rating-pill.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, var(--bg-elevated));
  color: var(--accent);
  font-weight: 700;
}
.pop-rating-pill.rating-R18.active {
  border-color: var(--danger-text);
  background: var(--bg-elevated);
  color: var(--danger-text);
  font-weight: 700;
}
.pop-count { color: var(--text-muted); font: 600 var(--fs-mono-sm) var(--font-mono); white-space: nowrap; }
.pop-count strong { color: var(--accent); }
.pop-cats { flex: 1 1 auto; display: flex; flex-wrap: wrap; gap: var(--s-2); }
.pop-cat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-pill);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font: 650 var(--fs-label-sm) var(--font-sans);
  cursor: pointer;
  transition: border-color var(--motion-hover), color var(--motion-hover), background var(--motion-hover), transform var(--motion-hover) var(--ease-out);
}
.pop-cat:active { transform: translateY(1px) scale(.97); }
.pop-cat em { font-style: normal; color: var(--text-muted); font: 700 var(--fs-mono-xs) var(--font-mono); }
.pop-cat:hover, .pop-cat.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.pop-cat.adult { border-color: color-mix(in srgb, var(--danger-text) 42%, var(--border-soft)); }
.pop-cat.adult em { color: var(--danger-text); }
.pop-cat.adult:hover, .pop-cat.adult.active {
  border-color: var(--danger-text);
  background: var(--bg-elevated);
  color: var(--danger-text);
}

.pop-empty {
  padding: var(--s-6);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-xl);
  text-align: center;
  color: var(--text-muted);
}

.pop-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--s-4);
}
.pop-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-4);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  background: var(--bg-elevated);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
  transition: transform var(--motion-hover) var(--ease-out), border-color var(--motion-hover), box-shadow var(--motion-hover);
  /* 离屏卡片跳过布局/绘制/渲染，长列表滚动保持满帧（首屏外无需工作） */
  content-visibility: auto;
  contain-intrinsic-size: auto 460px;
}
.pop-card:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: var(--shadow-sm); }
.pop-card.adult { border-color: color-mix(in srgb, var(--danger-text) 45%, var(--border-soft)); }

/* ---- 样张缩略图区（与灵感场景 SceneCard 视觉语言一致） ---- */
.pop-thumb {
  position: relative;
  display: block;
  aspect-ratio: 16/10;
  overflow: hidden;
  margin: calc(-1 * var(--s-4)) calc(-1 * var(--s-4)) var(--s-2);
  border-radius: var(--r-lg) var(--r-lg) 0 0;
  background: linear-gradient(145deg, color-mix(in srgb, var(--bg-deep) 72%, var(--bg-elevated)), var(--bg-elevated));
  text-decoration: none;
}
.pop-thumb.is-missing { aspect-ratio: auto; min-height: var(--s-8); }
.pop-thumb img {
  position: absolute; inset: 0; z-index: var(--z-sc-media, 0);
  width: 100%; height: 100%;
  object-fit: cover; object-position: center 22%;
  opacity: 0; filter: blur(6px);
  transition: opacity var(--motion-surface) var(--ease-out), filter var(--motion-atmosphere) var(--ease-out), transform var(--motion-surface) var(--ease-out);
}
.pop-thumb img.pop-thumb-ready { opacity: 1; filter: blur(0); }
.pop-thumb img.pop-thumb-missing { display: none; }
.pop-thumb-skeleton {
  position: absolute; inset: 0; z-index: var(--z-sc-media, 0); opacity: 0;
  background: linear-gradient(105deg, var(--bg-deep) 18%, var(--bg-elevated) 42%, var(--bg-deep) 68%);
  background-size: 220% 100%;
  transition: opacity var(--motion-hover);
}
.pop-thumb-skeleton.visible { opacity: 1; animation: archive-skeleton-shimmer 1.3s linear infinite; }
/* R18 样张默认模糊，悬停/聚焦揭示，与灵感场景一致。 */
.pop-thumb img.pop-thumb-r18,
.pop-thumb img.pop-thumb-r18.pop-thumb-ready { filter: blur(16px) saturate(.85); transform: scale(1.08); }
.pop-card:hover .pop-thumb img.pop-thumb-r18,
.pop-card:focus-within .pop-thumb img.pop-thumb-r18,
.pop-card:hover .pop-thumb img.pop-thumb-r18.pop-thumb-ready,
.pop-card:focus-within .pop-thumb img.pop-thumb-r18.pop-thumb-ready { filter: blur(0) saturate(1); transform: scale(1.08); }
.pop-thumb-hint {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--on-art-line); border-radius: var(--r-pill);
  background: var(--art-scrim); color: var(--on-art-primary);
  font: 700 var(--fs-mono-xs) var(--font-mono); letter-spacing: .08em;
  backdrop-filter: blur(10px); box-shadow: var(--shadow-sm);
  pointer-events: none; opacity: 1; transition: opacity var(--motion-hover);
}
.pop-card:hover .pop-thumb-hint, .pop-card:focus-within .pop-thumb-hint { opacity: 0; }
@media (hover: hover) and (pointer: fine) {
  .pop-card:hover .pop-thumb img { transform: scale(1.03); }
  .pop-card:hover .pop-thumb img.pop-thumb-r18,
  .pop-card:hover .pop-thumb img.pop-thumb-r18.pop-thumb-ready { transform: scale(1.03); }
}
.pop-card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); }
.pop-card-head h3 { margin: 0; font-size: var(--fs-title-xs); }
.pop-rating {
  flex: 0 0 auto;
  padding: 1px var(--s-2);
  border: 1px solid var(--danger-text);
  border-radius: var(--r-pill);
  color: var(--danger-text);
  font: 800 var(--fs-mono-sm) var(--font-mono);
}
.pop-rating.rating-R15 {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border-soft));
  color: var(--accent);
}
.pop-rating.rating-All { display: none; }
.pop-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--fs-label-sm);
  line-height: var(--lh-body);
}
.pop-meta { display: flex; flex-wrap: wrap; gap: var(--s-1); color: var(--text-muted); font-size: var(--fs-mono-xs); }
.pop-meta span + span::before { content: ' · '; margin-right: var(--s-1); /* 审计修复：分隔符原用 --border-strong(2.73:1)，改 --text-muted */ color: var(--text-muted); }
/* 2026-08-16 减压：决策行去底盒改轻量元数据行，把视觉焦点还给样张与 CTA */
.pop-decision {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-1) var(--s-3);
  color: var(--text-muted);
  font-size: var(--fs-mono-xs);
}
.pop-decision strong { color: var(--text-secondary); font-weight: 650; }
.pop-decision span + span::before { content: ' · '; margin-right: var(--s-2); /* 审计修复：分隔符原用 --border-strong(2.73:1)，改 --text-muted */ color: var(--text-muted); }
.pop-artist strong { color: var(--accent); }
.pop-card-actions { margin-top: auto; }
.pop-draw-action {
  width: 100%;
  justify-content: center;
  border-color: color-mix(in srgb, var(--accent) 44%, var(--border-soft));
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: none;
}
.pop-draw-action:hover, .pop-draw-action:focus-visible {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--text-inverse);
  box-shadow: var(--glow-sm);
}

@media (max-width: 768px) {
  .pop-hero { grid-template-columns: 1fr; }
  .pop-hero-field { min-height: 180px; border-left: 0; border-top: 1px solid var(--border-soft); }
  .pop-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>

<style scoped src="@/assets/css/popular-scene-browse.css"></style>
