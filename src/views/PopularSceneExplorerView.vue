<template>
  <article class="page library-page popular-scene-library" :style="{ '--character-ornament': portraitPalette.accent }">
    <header class="library-header"><div><div class="page-kicker">HUIYU / CHARACTER SCENES</div><h1 class="page-title">角色场景</h1></div><CharacterContextNav :character-id="selectedId" active="scenes" /></header>
    <div class="library-layout">
      <BrowsingCharacterDirectory :items="directoryItems" :selected-id="selectedId" @select="selectCharacter" />
      <div ref="sceneContent" class="library-detail" tabindex="-1" role="region" :aria-label="`${selectedCharacter?.displayName || '当前角色'}的场景`" :aria-busy="loading">
    <section class="pop-hero" data-route-arrive v-content-motion:fade="selectedId" aria-label="当前角色场景">
      <figure v-if="selectedCharacter" class="pop-character-art">
        <RuntimeImage :src="popularPortraitSrc(selectedId)" v-slot="{ image, loaded, failed }">
          <img v-if="image.src && !failed" v-bind="image" :alt="selectedCharacter.displayName" decoding="async" :class="{ 'pop-character-ready': loaded }" />
          <ArchiveIcon v-if="!loaded" class="pop-character-placeholder" name="image" />
        </RuntimeImage>
      </figure>
      <div class="pop-hero-copy">
        <div class="page-kicker">{{ franchiseLabel(franchiseKey(selectedCharacter?.franchise || '')) }}</div>
        <h2>{{ selectedCharacter?.displayName || '选择一个角色' }}</h2>
        <p v-if="selectedCharacter" class="pop-hero-note">翻开属于{{ selectedCharacter.displayName }}的故事，选一幕留在画里。</p>
      </div>
      <p class="pop-hero-stat" aria-label="场景统计"><strong v-if="!loading && !loadError">{{ totalScenes }}</strong><span>{{ loading ? '正在整理场景' : loadError ? '场景暂不可用' : '幕可选场景' }}</span></p>
    </section>

    <ArchiveStatePanel v-if="loading || samplesPending" kind="loading" title="正在读取角色场景" />
    <ArchiveStatePanel v-else-if="loadError" kind="error" title="角色场景读取失败" :message="loadError">
      <button class="btn btn-primary" type="button" @click="retryScenes">重新读取</button>
    </ArchiveStatePanel>

    <div v-else class="pop-content" data-route-arrive v-content-motion:up="true">
      <div class="browse-toolbar pop-toolbar">
        <div class="pop-toolbar-row">
          <StudioSearch v-model="query" class="pop-search-field" id="popularSceneSearch" label="搜索场景" placeholder="搜索场景、地点或氛围…" />
          <div class="pop-rating-filters studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="分级筛选">
            <AnimatedSelection />
            <button v-for="r in RATING_OPTS" :key="r.v" type="button" class="pop-rating-pill"
              :aria-pressed="ratingFilter === r.v"
              @click="ratingFilter = r.v">{{ r.l }}</button>
          </div>
        </div>
        <div class="pop-cats studio-segments studio-segments--compact" data-fluid-glass role="group" aria-label="场景分类">
          <AnimatedSelection />
          <button v-for="cat in categories" :key="cat.id" type="button" class="pop-cat"
            :aria-pressed="category === cat.id"
            @click="category = cat.id">{{ cat.label }}<em>{{ cat.count }}</em></button>
        </div>
      </div>
      <div class="pop-results-bar">
        <span class="pop-count" role="status">已显示 <strong>{{ paged.length }}</strong> / {{ filtered.length }} 幕</span>
        <button v-if="query.trim() || category !== 'all' || ratingFilter !== 'all'" class="btn btn-quiet btn-sm" type="button" @click="resetFilters">清除筛选</button>
        <StudioTooltip content="成人场景可浏览，R18 样张保留模糊遮罩">
          <span class="pop-count mature-hint" tabindex="0">成人 {{ adultCount }}</span>
        </StudioTooltip>
      </div>

      <ArchiveStatePanel v-if="filtered.length === 0" compact :kind="pool.length ? 'filtered' : 'empty'"
        :title="pool.length ? '没有符合当前条件的场景' : '这个角色暂未收录场景'">
        <button v-if="pool.length" class="btn btn-ghost" type="button" @click="resetFilters">重置筛选</button>
      </ArchiveStatePanel>

      <ArchiveStatePanel v-if="assetsError" compact kind="error" title="样张清单暂不可用" :message="assetsError">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="assetsLoading" @click="retryAssets">重新读取样张</button>
      </ArchiveStatePanel>
      <!-- 场景卡片网格 -->
      <div ref="listRoot" class="pop-grid">
        <article v-for="blueprint in paged" :key="blueprint.id" class="pop-card"
          :class="{ adult: blueprint.adult }" :data-blueprint-id="blueprint.id" :data-list-key="blueprint.id"
          :style="{ '--scene-preview-ratio': previewRatio(blueprint) }">
          <!-- 样张缩略图：与灵感场景一致的真实样张预览；仅角色专属蓝图有样张 -->
          <RuntimeImage v-if="thumbSrc(blueprint)" :src="thumbSrc(blueprint)" v-slot="{ image, loaded, failed }" @load="measurePreview(blueprint, $event)">
          <button class="pop-thumb" :class="{ 'is-missing': failed, 'is-r18': sampleRatingOf(blueprint) === 'R18' }" type="button"
            :aria-label="`欣赏场景：${blueprint.title}`" @click="openPreview(blueprint, $event)">
            <span class="pop-thumb-skeleton" :class="{ visible: !loaded && !failed }" aria-hidden="true"></span>
            <img v-if="image.src" v-bind="image" alt="" loading="lazy" decoding="async"
              :class="{
                'pop-thumb-r18': sampleRatingOf(blueprint) === 'R18',
                'pop-thumb-missing': failed,
                'pop-thumb-ready': loaded,
              }" />
            <SensitivePreviewVeil v-if="sampleRatingOf(blueprint) === 'R18' && image.src && !failed"
              :src="image.src" :crossorigin="image.crossorigin" />
            <span v-if="failed" class="pop-preview-missing"><ArchiveIcon name="gallery" /><strong>样张暂不可用</strong></span>
            <span v-else-if="sampleRatingOf(blueprint) === 'R18'" class="pop-thumb-hint">R18 · 悬停预览</span>
          </button>
          </RuntimeImage>
          <div v-else class="pop-thumb is-missing"><span class="pop-preview-missing"><ArchiveIcon name="gallery" /><strong>{{ assetsLoading ? '正在读取样张' : assetsError ? '样张暂不可用' : '样张待补充' }}</strong></span></div>
          <div class="pop-card-body">
            <div class="pop-card-category"><span>{{ blueprint.category }}</span><span v-if="sampleRatingOf(blueprint) !== 'All'" class="pop-rating" :class="'rating-' + sampleRatingOf(blueprint)">{{ sampleRatingOf(blueprint) }}</span></div>
            <header class="pop-card-head"><h3>{{ blueprint.title }}</h3></header>
            <div class="pop-meta"><span>{{ blueprint.location }}</span><span>{{ timeLabel(blueprint.timeOfDay) }}</span></div>
            <footer class="pop-card-actions">
              <RouterLink class="btn btn-primary pop-draw-action" :to="drawUrl(blueprint)"><ArchiveIcon name="spark" />绘制这一幕</RouterLink>
            </footer>
            <details class="pop-scene-details" :open="openDetails.has(blueprint.id)" @toggle="setDetailsOpen(blueprint.id, $event)">
              <StudioDisclosureSummary>场景细节</StudioDisclosureSummary>
              <div v-if="openDetails.has(blueprint.id)" data-disclosure-content>
              <p v-if="blueprint.description" class="pop-full-description">{{ displayDescription(blueprint) }}</p>
              <dl class="pop-decision">
                <div><dt>镜头</dt><dd>{{ shotLabel(blueprint) }}</dd></div>
                <div><dt>光线</dt><dd>{{ lightLabel(blueprint) }}</dd></div>
                <div><dt>色调</dt><dd>{{ moodLabel(blueprint) }}</dd></div>
                <div><dt>画幅</dt><dd>{{ blueprint.recommendedSize.replace('x', '×') }}</dd></div>
                <div v-if="blueprint.adult && artistLabel(blueprint)" class="pop-artist"><dt>画师</dt><dd>{{ artistLabel(blueprint) }}</dd></div>
              </dl>
              </div>
            </details>
          </div>
          <CardEdgeLight />
        </article>
      </div>
      <div v-if="paged.length < filtered.length" ref="loadSentinel" class="tw:mt-s-5 tw:text-center">
        <button class="btn btn-ghost" type="button" @click="loadMore">加载更多（剩余 {{ filtered.length - paged.length }} 幕）</button>
      </div>
    </div>
      </div>
    </div>
    <SceneArtworkViewer ref="previewViewer" v-model="previewId" :items="previewItems" @after-close="previewBlueprint = null">
      <template v-if="previewBlueprint" #info>
        <div class="viewer-meta">{{ selectedCharacter?.displayName }} · {{ previewBlueprint.category }} · {{ timeLabel(previewBlueprint.timeOfDay) }}</div>
        <section class="viewer-section"><h3>场景设定</h3><p class="viewer-story">{{ displayDescription(previewBlueprint) }}</p></section>
        <dl class="viewer-record">
          <div><dt>地点</dt><dd>{{ previewBlueprint.location || '未指定' }}</dd></div>
          <div><dt>镜头</dt><dd>{{ shotLabel(previewBlueprint) }}</dd></div>
          <div><dt>光线</dt><dd>{{ lightLabel(previewBlueprint) }}</dd></div>
          <div><dt>色调</dt><dd>{{ moodLabel(previewBlueprint) }}</dd></div>
          <div><dt>画幅</dt><dd>{{ previewBlueprint.recommendedSize.replace('x', '×') }}</dd></div>
          <div v-if="previewBlueprint.adult && artistLabel(previewBlueprint)"><dt>画师</dt><dd>{{ artistLabel(previewBlueprint) }}</dd></div>
        </dl>
        <div class="viewer-actions"><RouterLink class="btn btn-primary" :to="drawUrl(previewBlueprint)"><ArchiveIcon name="spark" />绘制这一幕</RouterLink></div>
      </template>
    </SceneArtworkViewer>
  </article>
</template>

<script setup lang="ts">
import CharacterContextNav from '@/components/library/CharacterContextNav.vue'
import RuntimeImage from '@/components/visual/RuntimeImage.vue'
import SensitivePreviewVeil from '@/components/visual/SensitivePreviewVeil.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import CardEdgeLight from '@/components/visual/CardEdgeLight.vue'
import SceneArtworkViewer from '@/components/scene/SceneArtworkViewer.vue'
import { useListTransition } from '@/composables/useListTransition'
import { useBrowseSearch } from '@/composables/useBrowseSearch'

import { popularPortraitSrc } from '@/utils/popularPortraitSource'
import { ref, computed, nextTick, onUnmounted, watch } from 'vue'
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
import { catalogShowcaseId } from '@/utils/showcaseManifest'
import { useShowcaseAssets } from '@/composables/scene/useShowcaseAssets'

const route = useRoute()
const router = useRouter()
const sceneStore = useSceneStore()
const { thumbUrl, imageUrl, thumbDimensions, initialLoading: samplesPending, loading: assetsLoading, error: assetsError, reload: reloadAssets } = useShowcaseAssets()

const loadError = ref('')
const sceneContent = ref<HTMLElement | null>(null)
function retryScenes() {
  sceneContent.value?.focus({ preventScroll: true })
  void init()
}
function retryAssets() {
  sceneContent.value?.focus({ preventScroll: true })
  void reloadAssets().catch(() => {})
}
const routeFilters = () => ({ q: typeof route.query.q === 'string' ? route.query.q : '',
  category: typeof route.query.category === 'string' ? route.query.category : 'all',
  rating: RATING_OPTS.find(option => option.v === route.query.rating)?.v ?? 'all' })
const openingFilters = routeFilters()
const { query, settledQuery, restoreQuery } = useBrowseSearch(openingFilters.q)
const category = ref(openingFilters.category)
const ratingFilter = ref(openingFilters.rating)
let pendingRouteWrite: ReturnType<typeof routeFilters> | null = null
watch(routeFilters, filters => {
  if (route.path !== '/popular-scenes') return
  if (pendingRouteWrite && JSON.stringify(pendingRouteWrite) === JSON.stringify(filters)) return
  pendingRouteWrite = null
  restoreQuery(filters.q); category.value = filters.category; ratingFilter.value = filters.rating
}, { flush: 'sync' })
watch([settledQuery, category, ratingFilter], () => {
  if (route.path !== '/popular-scenes') return
  const filters = { q: settledQuery.value, category: category.value, rating: ratingFilter.value }
  if (JSON.stringify(filters) === JSON.stringify(routeFilters())) return
  const next = { ...route.query }
  if (filters.q) next.q = filters.q; else delete next.q
  if (filters.category !== 'all') next.category = filters.category; else delete next.category
  if (filters.rating !== 'all') next.rating = filters.rating; else delete next.rating
  pendingRouteWrite = filters
  void router.replace({ query: next, hash: route.hash }).catch(() => {}).finally(() => {
    if (pendingRouteWrite === filters) pendingRouteWrite = null
  })
})

const characters = computed<PopularCharacter[]>(() => sceneStore.popularCharacters)
const allBlueprints = computed<SceneBlueprint[]>(() => sceneStore.sceneBlueprints)
// Same-page navigation reuses this view, so the URL remains the selection owner.
const selectedId = computed(() => {
  const requested = typeof route.query.character === 'string' ? route.query.character : ''
  return characters.value.some(character => character.id === requested) ? requested : characters.value[0]?.id ?? ''
})
const loading = ref(!sceneStore.hasBlueprintCharacter(selectedId.value))

const directoryItems = computed(() => characters.value.map(character => ({
  id: character.id, name: character.displayName, source: character.franchise, aliases: character.aliases,
  image: popularPortraitSrc(character.id),
})))

/** 当前角色的全部蓝图。 */
const selectedCharacter = computed(() =>
  characters.value.find(item => item.id === selectedId.value) ?? null,
)
// Keep the shared character palette on the chapter ornament without a particle canvas.
const portraitPalette = computed(() => characterParticleTheme(selectedId.value, selectedCharacter.value?.franchise))
const pool = computed<SceneBlueprint[]>(() =>
  allBlueprints.value.filter(bp =>
    bp.characterId === selectedId.value,
  ),
)

// 统计口径统一为「当前角色的可浏览池」，与成人数量同源（header 不再显示全局 336 与
// 单人成人数的混搭数字）。
const totalScenes = computed(() => pool.value.length)
const adultCount = computed(() => pool.value.filter(bp => bp.adult).length)

const categories = computed(() => buildPopularCategories(pool.value))
const searchIndex = computed(() => new Map(pool.value.map(blueprint => [blueprint.id,
  [blueprint.title, blueprint.description, blueprint.location, blueprint.promptProse, blueprint.category, blueprint.mood]
    .filter(Boolean).map(text => String(text).toLowerCase()),
])))

const filtered = computed(() => {
  const q = settledQuery.value.trim().toLowerCase()
  return pool.value.filter(bp => {
    if (ratingFilter.value !== 'all') {
      const r = sampleRatingOf(bp)
      if (r !== ratingFilter.value) return false
    }
    if (category.value !== 'all' && (bp.adult ? '成人' : bp.category) !== category.value) return false
    if (!q) return true
    return searchIndex.value.get(bp.id)?.some(text => text.includes(q))
  })
})

const visibleCount = ref(24)
const paged = computed(() => filtered.value.slice(0, visibleCount.value))
const listRoot = ref<HTMLElement | null>(null)
useListTransition(listRoot, () => paged.value.map(blueprint => blueprint.id))
const imageRatios = ref<Record<string, { src: string; ratio: number }>>({})
function previewRatio(blueprint: SceneBlueprint) {
  const size = thumbDimensions(showcaseId(blueprint))
  const [width, height] = blueprint.recommendedSize.split('x').map(Number)
  const measured = imageRatios.value[blueprint.id]
  return measured?.src === thumbSrc(blueprint) ? measured.ratio : size ? size.width / size.height : width / height
}
function measurePreview(blueprint: SceneBlueprint, event: Event) {
  const image = event.target as HTMLImageElement
  if (image.naturalWidth && image.naturalHeight)
    imageRatios.value[blueprint.id] = { src: thumbSrc(blueprint), ratio: image.naturalWidth / image.naturalHeight }
}
const previewViewer = ref<InstanceType<typeof SceneArtworkViewer> | null>(null)
const previewId = ref<string | null>(null)
const previewBlueprint = ref<SceneBlueprint | null>(null)
watch(previewId, id => { if (id) previewBlueprint.value = filtered.value.find(item => item.id === id) ?? null }, { flush: 'sync' })
const previewItems = computed(() => filtered.value.map(blueprint => {
  const [width, height] = blueprint.recommendedSize.split('x').map(Number)
  return { id: blueprint.id, title: blueprint.title, width, height,
    src: imageUrl(showcaseId(blueprint)), previewSrc: thumbSrc(blueprint) }
}))
function openPreview(blueprint: SceneBlueprint, event: MouseEvent) {
  const image = (event.currentTarget as HTMLElement).querySelector<HTMLImageElement>('img')
  previewViewer.value?.capture(image)
  previewId.value = blueprint.id
}
const loadSentinel = ref<HTMLElement | null>(null)
const openDetails = ref(new Set<string>())
let moreObserver: IntersectionObserver | undefined
function loadMore() { visibleCount.value = Math.min(visibleCount.value + 24, filtered.value.length) }
function setDetailsOpen(id: string, event: Event) {
  if ((event.target as HTMLDetailsElement).open) openDetails.value.add(id)
  else openDetails.value.delete(id)
}
watch([selectedId, settledQuery, category, ratingFilter], () => { visibleCount.value = 24; previewId.value = null })
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
  if (route.query.character !== id) void router.replace({ query: next, hash: route.hash })
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
  const previousFocus = document.activeElement
  restoreQuery('')
  category.value = 'all'
  ratingFilter.value = 'all'
  void nextTick(() => { if (previousFocus && !previousFocus.isConnected) document.getElementById('popularSceneSearch')?.focus() })
}

/** The manifest retains real paths for both current and older saved blueprints. */
function showcaseId(blueprint: SceneBlueprint): string {
  return blueprint.characterId ? catalogShowcaseId({ kind: 'blueprint', id: blueprint.id, characterId: blueprint.characterId }) : ''
}
const thumbSrc = (blueprint: SceneBlueprint) => thumbUrl(showcaseId(blueprint))

let loadRevision = 0
async function init() {
  const revision = ++loadRevision
  loading.value = !sceneStore.hasBlueprintCharacter(selectedId.value)
  loadError.value = ''
  try {
    await sceneStore.loadBlueprintCatalog()
    if (revision !== loadRevision) return
    if (selectedId.value) await sceneStore.loadBlueprintCharacter(selectedId.value)
  } catch (error) {
    if (revision === loadRevision) loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (revision === loadRevision) loading.value = false
  }
}

watch(selectedId, () => { if (route.path === '/popular-scenes') void init() }, { immediate: true })
onUnmounted(() => { loadRevision++ })
</script>

<style scoped src="@/assets/css/popular-scene-explorer.css"></style>

<style scoped src="@/assets/css/popular-scene-browse.css"></style>
