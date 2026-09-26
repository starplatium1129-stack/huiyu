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
          <StudioTooltip :content="showMature ? '本机成人场景可浏览，R18 样张保留模糊遮罩' : '成人场景仅限本机访问'">
            <span class="pop-count mature-hint">{{ showMature ? `成人 ${adultCount} · 已展示` : '成人场景 · 仅限本机' }}</span>
          </StudioTooltip>
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
            <img :crossorigin="runtimeResourceCors()" :src="resolveRuntimeUrl(thumbSrc(blueprint))" alt="" loading="lazy" decoding="async"
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
import { resolveRuntimeUrl, runtimeResourceCors } from '@/platform/runtimeUrl'

import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSceneStore } from '@/stores/sceneStore'
import BrowsingCharacterDirectory from '@/components/library/BrowsingCharacterDirectory.vue'
import type { PopularCharacter, SceneBlueprint } from '@/utils/popularContent'
import {
  RATING_OPTS,
  artistLabel,
  buildPopularCategories,
  lightLabel,
  moodLabel,
  sampleRatingOf,
  shotLabel,
  timeLabel,
} from '@/utils/popularScenePresentation'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
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

const categories = computed(() => buildPopularCategories(pool.value))

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

<style scoped src="@/assets/css/popular-scene-explorer.css"></style>

<style scoped src="@/assets/css/popular-scene-browse.css"></style>
