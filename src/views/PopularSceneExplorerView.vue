<template>
  <article class="page library-page popular-scene-library" :style="{ '--character-ornament': portraitPalette.accent }">
    <header class="library-header"><div><div class="page-kicker">SCENE / 02</div><h1>角色场景</h1></div><CharacterContextNav :character-id="selectedId" active="scenes" /></header>
    <div class="library-layout">
      <BrowsingCharacterDirectory :items="directoryItems" :selected-id="selectedId" @select="selectCharacter" />
      <div class="library-detail" v-content-motion="selectedId">
    <section class="pop-hero" aria-label="当前角色场景">
      <figure v-if="selectedCharacter" class="pop-character-art">
        <RuntimeImage :src="popularPortraitSrc(selectedId)" :alt="selectedCharacter.displayName" decoding="async">
          <template #fallback><ArchiveIcon name="image" /></template>
        </RuntimeImage>
      </figure>
      <div class="pop-hero-copy">
        <div class="page-kicker">{{ franchiseLabel(franchiseKey(selectedCharacter?.franchise || '')) }}</div>
        <h2>{{ selectedCharacter?.displayName || '选择一个角色' }}</h2>
      </div>
      <p class="pop-hero-stat" aria-label="场景统计"><strong>{{ totalScenes }}</strong> 幕可选场景</p>
    </section>

    <ArchiveStatePanel v-if="loading" kind="loading" title="正在读取角色场景" message="正在载入热门角色档案与场景蓝图。" />
    <ArchiveStatePanel v-else-if="loadError" kind="error" title="角色场景读取失败" :message="loadError">
      <button class="btn btn-primary" type="button" @click="init">重新读取</button>
    </ArchiveStatePanel>

    <template v-else>
      <div class="pop-toolbar tw:grid tw:gap-s-3 tw:mb-s-3">
        <div class="pop-toolbar-row tw:flex tw:items-center tw:gap-s-3 tw:flex-wrap">
          <StudioSearch v-model="query" class="pop-search-field" id="popularSceneSearch" label="搜索场景" placeholder="搜索场景、地点或氛围…" />
          <div class="pop-rating-filters tw:inline-flex tw:items-center tw:gap-s-1" role="group" aria-label="分级筛选">
            <button v-for="r in RATING_OPTS" :key="r.v" type="button" class="pop-rating-pill"
              :class="{ active: ratingFilter === r.v, ['rating-' + r.v]: r.v !== 'all' }"
              :aria-pressed="ratingFilter === r.v"
              @click="ratingFilter = r.v">{{ r.l }}</button>
          </div>
        </div>
        <div class="pop-cats" role="group" aria-label="场景分类">
          <button v-for="cat in categories" :key="cat.id" type="button" class="pop-cat"
            :class="{ active: category === cat.id, adult: cat.id === '成人' }"
            :aria-pressed="category === cat.id"
            @click="category = cat.id">{{ cat.label }}<em>{{ cat.count }}</em></button>
        </div>
      </div>
      <div class="pop-results-bar">
        <span class="pop-count" role="status">已显示 <strong>{{ paged.length }}</strong> / {{ filtered.length }} 幕</span>
        <button v-if="query.trim() || category !== 'all' || ratingFilter !== 'all'" class="pop-filter-reset" type="button" @click="resetFilters">清除筛选</button>
        <StudioTooltip :content="showMature ? '本机成人场景可浏览，R18 样张保留模糊遮罩' : '成人场景仅限本机访问'">
          <span class="pop-count mature-hint">{{ showMature ? `成人 ${adultCount} · 已展示` : '成人场景 · 仅限本机' }}</span>
        </StudioTooltip>
      </div>

      <ArchiveStatePanel v-if="filtered.length === 0" compact :kind="pool.length ? 'filtered' : 'empty'"
        :title="pool.length ? '没有符合当前条件的场景' : '这个角色暂未收录场景'"
        :message="pool.length ? '换个关键词或分类，也可以清除筛选继续翻阅。' : '可先翻阅其他角色的场景，找到想要绘制的下一幕。'">
        <button v-if="pool.length" class="btn btn-ghost" type="button" @click="resetFilters">重置筛选</button>
      </ArchiveStatePanel>

      <!-- 场景卡片网格 -->
      <div v-content-motion="`${category}:${ratingFilter}`" class="pop-grid">
        <article v-for="blueprint in paged" :key="blueprint.id" class="pop-card"
          :class="{ adult: blueprint.adult }" :data-blueprint-id="blueprint.id"
          :style="{ '--scene-preview-ratio': blueprint.recommendedSize.replace('x', ' / ') }">
          <!-- 样张缩略图：与灵感场景一致的真实样张预览；仅角色专属蓝图有样张 -->
          <RuntimeImage v-if="thumbSrc(blueprint)" :src="thumbSrc(blueprint)" v-slot="{ image, loaded, failed }">
          <RouterLink class="pop-thumb" :class="{ 'is-missing': failed }" :to="drawUrl(blueprint)"
            :aria-label="`以「${blueprint.title}」开始绘制`">
            <span class="pop-thumb-skeleton" :class="{ visible: !loaded && !failed }" aria-hidden="true"></span>
            <img v-if="image.src" v-bind="image" alt="" loading="lazy" decoding="async"
              :class="{
                'pop-thumb-r18': sampleRatingOf(blueprint) === 'R18',
                'pop-thumb-missing': failed,
                'pop-thumb-ready': loaded,
              }"
              />
            <SensitivePreviewVeil v-if="sampleRatingOf(blueprint) === 'R18' && image.src && !failed"
              :src="image.src" :crossorigin="image.crossorigin" />
            <span v-if="failed" class="pop-preview-missing"><ArchiveIcon name="gallery" /><strong>样张暂不可用</strong><span>场景设定已就绪，可以直接绘制</span></span>
            <span v-else-if="sampleRatingOf(blueprint) === 'R18'" class="pop-thumb-hint">R18 · 悬停预览</span>
          </RouterLink>
          </RuntimeImage>
          <div v-else class="pop-thumb is-missing"><span class="pop-preview-missing"><ArchiveIcon name="gallery" /><strong>样张待补充</strong><span>场景设定已就绪，可以直接绘制</span></span></div>
          <div class="pop-card-body">
            <div class="pop-card-category"><span>{{ blueprint.category }}</span><span v-if="sampleRatingOf(blueprint) !== 'All'" class="pop-rating" :class="'rating-' + sampleRatingOf(blueprint)">{{ sampleRatingOf(blueprint) }}</span></div>
            <header class="pop-card-head"><h3>{{ blueprint.title }}</h3></header>
            <div class="pop-meta"><span>{{ blueprint.location }}</span><span>{{ timeLabel(blueprint.timeOfDay) }}</span></div>
            <footer class="pop-card-actions">
              <RouterLink class="btn btn-primary pop-draw-action" :to="drawUrl(blueprint)"><ArchiveIcon name="spark" />绘制这一幕</RouterLink>
            </footer>
            <details class="pop-scene-details" :open="openDetails.has(blueprint.id)" @toggle="setDetailsOpen(blueprint.id, $event)">
              <summary><span>场景细节</span><ArchiveIcon name="chevron-down" /></summary>
              <template v-if="openDetails.has(blueprint.id)">
              <p v-if="blueprint.description" class="pop-full-description">{{ displayDescription(blueprint) }}</p>
              <dl class="pop-decision">
                <div><dt>镜头</dt><dd>{{ shotLabel(blueprint) }}</dd></div>
                <div><dt>光线</dt><dd>{{ lightLabel(blueprint) }}</dd></div>
                <div><dt>色调</dt><dd>{{ moodLabel(blueprint) }}</dd></div>
                <div><dt>画幅</dt><dd>{{ blueprint.recommendedSize.replace('x', '×') }}</dd></div>
                <div v-if="blueprint.adult && artistLabel(blueprint)" class="pop-artist"><dt>画师</dt><dd>{{ artistLabel(blueprint) }}</dd></div>
              </dl>
              </template>
            </details>
          </div>
        </article>
      </div>
      <div v-if="paged.length < filtered.length" ref="loadSentinel" class="tw:mt-s-5 tw:text-center">
        <button class="btn btn-ghost" type="button" @click="loadMore">加载更多（剩余 {{ filtered.length - paged.length }} 幕）</button>
      </div>
    </template>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import CharacterContextNav from '@/components/library/CharacterContextNav.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import SensitivePreviewVeil from '@/components/visual/SensitivePreviewVeil.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'

import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { ref, computed, onMounted, onUnmounted, onActivated, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
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
const routeFilters = () => ({ q: typeof route.query.q === 'string' ? route.query.q : '',
  category: typeof route.query.category === 'string' ? route.query.category : 'all',
  rating: RATING_OPTS.find(option => option.v === route.query.rating)?.v ?? 'all' })
const openingFilters = routeFilters()
const query = ref(openingFilters.q)
const category = ref(openingFilters.category)
const ratingFilter = ref(openingFilters.rating)
let pendingRouteWrite: ReturnType<typeof routeFilters> | null = null
watch(routeFilters, filters => {
  if (route.path !== '/popular-scenes') return
  if (pendingRouteWrite && JSON.stringify(pendingRouteWrite) === JSON.stringify(filters)) return
  pendingRouteWrite = null
  query.value = filters.q; category.value = filters.category; ratingFilter.value = filters.rating
}, { flush: 'sync' })
watch([query, category, ratingFilter], () => {
  if (route.path !== '/popular-scenes') return
  const filters = { q: query.value, category: category.value, rating: ratingFilter.value }
  if (JSON.stringify(filters) === JSON.stringify(routeFilters())) return
  const next = { ...route.query }
  if (filters.q) next.q = filters.q; else delete next.q
  if (filters.category !== 'all') next.category = filters.category; else delete next.category
  if (filters.rating !== 'all') next.rating = filters.rating; else delete next.rating
  pendingRouteWrite = filters
  void router.replace({ query: next }).catch(() => {}).finally(() => {
    if (pendingRouteWrite === filters) pendingRouteWrite = null
  })
})
/** 成人场景仅限本机，远程和未知来源默认拒绝。 */
const showMature = isLocalStudioHost()

const characters = computed<PopularCharacter[]>(() => sceneStore.popularCharacters)
const allBlueprints = computed<SceneBlueprint[]>(() => sceneStore.sceneBlueprints)
// Same-page navigation reuses this view, so the URL remains the selection owner.
const selectedId = computed(() => {
  const requested = typeof route.query.character === 'string' ? route.query.character : ''
  return characters.value.some(character => character.id === requested) ? requested : characters.value[0]?.id ?? ''
})

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

const visibleCount = ref(24)
const paged = computed(() => filtered.value.slice(0, visibleCount.value))
const loadSentinel = ref<HTMLElement | null>(null)
const openDetails = ref(new Set<string>())
let moreObserver: IntersectionObserver | undefined
function loadMore() { visibleCount.value = Math.min(visibleCount.value + 24, filtered.value.length) }
function setDetailsOpen(id: string, event: Event) {
  if ((event.target as HTMLDetailsElement).open) openDetails.value.add(id)
  else openDetails.value.delete(id)
}
watch([selectedId, query, category, ratingFilter], () => { visibleCount.value = 24 })
watch(loadSentinel, element => {
  moreObserver?.disconnect()
  if (!element) return
  moreObserver ??= new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) loadMore()
  }, { rootMargin: '600px' })
  moreObserver.observe(element)
}, { flush: 'post' })
onUnmounted(() => moreObserver?.disconnect())

function selectCharacter(id: string) {
  const next: LocationQueryRaw = { ...route.query, character: id }
  delete next.q; delete next.category; delete next.rating
  if (route.query.character !== id) void router.replace({ query: next })
  else resetFilters()
}
function drawUrl(blueprint: SceneBlueprint): string {
  return `/prompt-builder?popular=${encodeURIComponent(selectedId.value)}&blueprint=${encodeURIComponent(blueprint.id)}`
}
function displayDescription(blueprint: SceneBlueprint): string {
  const prefix = `[${blueprint.title}]`
  return blueprint.description.startsWith(prefix) ? blueprint.description.slice(prefix.length).trim() : blueprint.description
}
function resetFilters() {
  query.value = ''
  category.value = 'all'
  ratingFilter.value = 'all'
}

/** 样张缩略图：与灵感场景一致，路径为展示库样张 `pc_<角色>_<蓝图>`；通用成人蓝图无样张。 */
const thumbVersion = ref(Date.now())
function thumbSrc(blueprint: SceneBlueprint): string {
  if (!blueprint.characterId || !selectedId.value) return ''
  return `/scene-showcase/thumbs/pc_${selectedId.value}_${blueprint.id}.jpg?v=${thumbVersion.value}`
}

async function init() {
  loading.value = true
  loadError.value = ''
  try {
    await sceneStore.loadBlueprintCatalog()
    if (selectedId.value) await sceneStore.loadBlueprintCharacter(selectedId.value)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

onMounted(() => { void init() })
onActivated(() => { if (!loading.value) void init() })
watch(selectedId, async id => {
  if (!id) return
  try { await sceneStore.loadBlueprintCharacter(id) }
  catch (error) { loadError.value = error instanceof Error ? error.message : String(error) }
})
</script>

<style scoped src="@/assets/css/popular-scene-explorer.css"></style>

<style scoped src="@/assets/css/popular-scene-browse.css"></style>
