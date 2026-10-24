<template>
  <article class="page showcase-page">
    <header class="showcase-heading">
      <div class="heading-copy tw:min-w-0">
        <p class="showcase-kicker"><ArchiveIcon name="book" />ARTBOOK / 邂逅灵感</p>
        <div class="heading-title"><h1>参考画册</h1><span class="collection-count"><strong>{{ manifestLoading && !entries.length ? '—' : entries.length }}</strong> 幅灵感</span></div>
        <p class="showcase-invitation">在光影与故事之间，拾起下一幅画的开端。</p>
      </div>
      <div class="hero-actions tw:flex tw:gap-s-2 tw:flex-wrap"><button class="btn btn-primary" type="button" :disabled="manifestLoading || !filtered.length" @click="openRandom"><ArchiveIcon name="spark" /> 随机邂逅一张</button><RouterLink to="/scene-explorer" class="btn btn-ghost"><ArchiveIcon name="scene" />按场景寻找灵感</RouterLink><button class="btn btn-ghost showcase-refresh" type="button" :disabled="manifestLoading" :aria-label="manifestLoading ? '正在读取画册' : '刷新画册'" @click="loadManifest(true)"><ArchiveIcon name="refresh" /></button></div>
    </header>

    <div class="browse-toolbar showcase-toolbar" aria-label="样张筛选" data-reveal>
      <div class="search-row tw:flex tw:items-center tw:gap-s-3 tw:flex-wrap">
        <div class="showcase-browse-modes studio-segments" role="group" aria-label="画册浏览方式"><AnimatedSelection /><button class="filter-pill" type="button" :class="{ active: !albumsOpen }" :aria-pressed="!albumsOpen" @click="showImages">{{ !selectedAlbum && typeFilter === 'all' ? '全部样张' : '画册样张' }}</button><button class="filter-pill" type="button" :class="{ active: albumsOpen }" :aria-pressed="albumsOpen" @click="showAlbums"><ArchiveIcon name="book" />按画册 <span>{{ albums.length }}</span></button></div>
        <StudioSearch v-show="!albumsOpen" ref="searchInput" v-model="searchQuery" class="search-field" id="showcaseSearch" label="搜索画册" placeholder="搜索场景、情绪、角色或关键词…" />
        <div v-show="!albumsOpen" class="filter-group studio-segments tw:flex tw:gap-s-1 tw:flex-wrap tw:items-center" data-fluid-glass role="group" aria-label="样张来源">
          <AnimatedSelection />
          <button v-for="opt in SCOPE_OPTS" :key="opt.v" class="filter-pill" :class="{active:scope===opt.v}" type="button" :aria-pressed="scope===opt.v" @click="scope=opt.v">{{ opt.l }}</button>
        </div>
        <button v-if="hasFilters && !albumsOpen" class="btn btn-quiet btn-sm" type="button" @click="resetFromControl">清除筛选</button>
      </div>
      <details v-show="!albumsOpen" class="showcase-filters">
        <StudioDisclosureSummary><span>细选画册</span><span class="filter-summary">{{ filterSummary }}</span></StudioDisclosureSummary>
        <div class="filter-details" data-disclosure-content>
          <div class="filter-group filter-dropdowns tw:flex tw:gap-s-1 tw:flex-wrap tw:items-center">
            <label for="showcaseTypeSelect">作品类型
              <StudioSelect id="showcaseTypeSelect" v-model="typeFilter" label="筛选作品类型"
                :options="typeOptions" /></label>
            <label for="showcaseCharSelect">角色筛选
              <StudioSelect id="showcaseCharSelect" v-model="charFilter" label="筛选角色"
                :options="characterOptions" /></label>
          </div>
          <div class="rating-options"><span>内容分级</span><div class="filter-group studio-segments studio-segments--compact tw:flex tw:gap-s-1 tw:flex-wrap tw:items-center" data-fluid-glass role="group" aria-label="内容分级">
            <AnimatedSelection />
            <button v-for="opt in RATING_OPTS" :key="opt.v" class="filter-pill" :class="{active:ratingFilter===opt.v}" type="button" :aria-pressed="ratingFilter===opt.v" @click="ratingFilter=opt.v">{{ opt.l }}</button>
          </div></div>
        </div>
      </details>
    </div>

    <div v-if="entries.length && (manifestLoading || reloadError)" class="showcase-load-status" role="status"><ArchiveIcon :name="manifestLoading ? 'book' : 'warning'" /><span>{{ manifestLoading ? '正在刷新画册…' : reloadError }}</span><button v-if="reloadError && !manifestLoading" class="btn btn-quiet btn-sm" type="button" @click="loadManifest(true)">重试</button></div>
    <div v-show="albumsOpen" v-content-motion:up.defer="albumsOpen" ref="albumRoot" class="showcase-album-overview" tabindex="-1">
      <ShowcaseAlbums v-if="albums.length && !unavailable" :albums="albums" :selected="albumSelection" :thumb-src="thumbSrc" :aria-busy="manifestLoading" @select="openAlbum" />
      <ArchiveStatePanel v-if="(manifestLoading && !entries.length) || unavailable || (!manifestLoading && !albums.length)" compact :kind="manifestLoading ? 'loading' : unavailable ? 'error' : 'empty'" :title="manifestLoading ? '正在整理画册' : unavailable ? '画册读取失败' : '暂未收录画册'"><button class="btn btn-ghost" type="button" @click="showImages">返回样张展墙</button></ArchiveStatePanel>
    </div>
    <div v-show="!albumsOpen" v-content-motion:up.defer="!albumsOpen" class="showcase-image-browse">
    <div ref="imageHeading" class="showcase-results-heading" tabindex="-1"><div class="showcase-result-location"><button v-if="selectedAlbum || typeFilter !== 'all'" type="button" class="showcase-album-back" @click="showAlbums"><ArchiveIcon name="chevron-down" />返回画册</button><h2>{{ selectedAlbum?.title || (typeFilter === 'all' ? '全部样张' : typeLabel(typeFilter)) }}</h2></div><span class="result-meta" id="resultMeta" role="status"><strong>{{ paged.length }}</strong> / {{ filtered.length }} 幅 · R18 默认模糊</span></div>
    <ArchiveStatePanel
      v-if="unavailable"
      class="empty empty-block"
      kind="error"
      title="展示素材暂未连接"
      message="请确认离线素材包已正确导入，或先浏览灵感场景。"
    >
      <button class="btn btn-primary" type="button" @click="loadManifest(true)">重新加载画册</button>
      <RouterLink class="btn btn-ghost" to="/scene-explorer">先逛灵感场景</RouterLink>
    </ArchiveStatePanel>

    <ArchiveStatePanel
      v-else-if="manifestLoading && !entries.length"
      class="empty empty-block"
      kind="loading"
      title="正在读取样张目录…"
    >
      <span class="btn btn-ghost" aria-disabled="true">加载中</span>
    </ArchiveStatePanel>

    <ArchiveStatePanel
      v-else-if="!filtered.length"
      :kind="entries.length ? 'filtered' : 'empty'"
      :title="entries.length ? '没有匹配的参考样张' : '画册暂未收录样张'"
    >
      <button v-if="hasFilters" class="btn btn-ghost" type="button" @click="resetFromControl">重置筛选</button>
    </ArchiveStatePanel>

    <div v-else ref="listRoot" data-route-arrive class="showcase-grid" :aria-busy="manifestLoading">
      <ShowcaseSampleCard v-for="entry in paged" :key="entry.id" :entry="entry" :src="thumbSrc(entry)" :data-list-key="entry.id"
        :featured="featured.has(entry.id)"
        :character-label="charLabel(entry.char)" :rating-label="ratingLabel(entry.rating)"
        @open="openViewer" />
    </div>

    <div ref="loadSentinel" v-show="paged.length < filtered.length" class="load-wrap">
      <button class="btn btn-ghost load-more" type="button" @click="loadMore">加载更多（剩余 {{ filtered.length - paged.length }}）</button>
    </div>
    </div>

    <!-- 查看器 dialog -->
    <Teleport to="body">
      <!-- 必须用 showModal() 打开（见 openViewer）：设 open 属性只是非模态 dialog，
           没有 top layer、没有 ::backdrop，背景不 inert，Tab 能直接跑到下面的网格里 -->
      <dialog ref="dialogEl" class="art-viewer showcase-viewer" :class="{ 'info-open': viewerInfoOpen }" data-image-transition aria-label="样张查看器" @click.self="closeViewer" @cancel.prevent="viewerInfoOpen ? closeViewerInfo() : closeViewer()">
        <template v-if="viewerMounted && currentEntry">
          <ArtworkViewerStage :items="filtered" :index="currentIdx" :active="viewerMounted && !viewerClosing" :original="originalViewer"
            :src="imgSrc(currentEntry)" :preview-src="viewerSurface.previewSrc.value" :thumb-urls="viewerThumbs" :title="entry => entry.title"
            @select="openViewer(filtered[$event].id)" @close="closeViewer" @toggle-original="toggleOriginalViewer" @dismiss-info="closeViewerInfo"
            @error="viewerImageFailed = true" @close-button="viewerClose = $event">
            <template #tools><button ref="viewerInfoToggle" class="viewer-info-toggle" data-fluid-glass type="button" aria-label="作品信息" aria-controls="showcase-viewer-info" :aria-expanded="viewerInfoOpen" @click="openViewerInfo"><ArchiveIcon name="info" /></button></template>
          </ArtworkViewerStage>
          <aside id="showcase-viewer-info" ref="viewerInfoEl" class="viewer-info" :inert="narrowViewer && !viewerInfoOpen" :aria-hidden="narrowViewer && !viewerInfoOpen ? true : undefined" aria-labelledby="showcase-viewer-title">
            <header class="viewer-info-header"><span class="viewer-kicker">参考画册</span><button ref="viewerInfoClose" class="viewer-info-close" type="button" @click="closeViewerInfo"><ArchiveIcon name="close" />关闭信息</button></header>
            <div class="viewer-info-body">
            <h2 id="showcase-viewer-title" class="viewer-title">{{ currentEntry.title }}</h2>
            <div class="viewer-meta">
              <span>{{ charLabel(currentEntry.char) }}</span>
              <span>{{ ratingLabel(currentEntry.rating) }}</span>
              <span>{{ currentEntry.category }}</span>
            </div>
            <div class="viewer-actions">
              <StudioTooltip v-if="workspaceTarget" :content="viewerClosing ? null : workspaceTarget.hint">
                <RouterLink class="btn btn-primary" :to="workspaceTarget.to"><ArchiveIcon name="spark" /> {{ workspaceTarget.label }}</RouterLink>
              </StudioTooltip>
            </div>
            <div class="viewer-story">{{ currentEntry.story }}</div>
            <details v-if="currentEntry.meta" class="viewer-details"><StudioDisclosureSummary>创作参数</StudioDisclosureSummary><div class="viewer-meta viewer-meta-gen" data-disclosure-content>
              <span v-if="currentEntry.meta.engine">引擎 {{ currentEntry.meta.engine }}</span>
              <span v-if="currentEntry.meta.checkpoint">Checkpoint {{ currentEntry.meta.checkpoint }}</span>
              <span v-if="currentEntry.meta.model">模型 {{ currentEntry.meta.model }}</span>
              <span v-if="currentEntry.meta.loraId">LoRA {{ currentEntry.meta.loraId }}<template v-if="currentEntry.meta.loraVersion"> · v{{ currentEntry.meta.loraVersion }}</template></span>
              <span v-if="currentEntry.meta.seed !== undefined">Seed {{ currentEntry.meta.seed }}</span>
            </div>
            </details>
            </div>
          </aside>
        </template>
      </dialog>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import '@/assets/css/viewer.css'
import { useShowcaseAssets } from '@/composables/scene/useShowcaseAssets'
import { useFluidDialog } from '@/composables/useFluidDialog'
import { useArtworkInfoDrawer } from '@/composables/useArtworkInfoDrawer'
import { useArtworkViewerSurface } from '@/composables/useArtworkViewerSurface'
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import { useSceneStore } from '@/stores/sceneStore'
import { useRoute, useRouter } from 'vue-router'
import { showcaseDestination } from '@/utils/showcaseDestination'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import ArtworkViewerStage from '@/components/gallery/ArtworkViewerStage.vue'
import ShowcaseAlbums from '@/components/showcase/ShowcaseAlbums.vue'
import ShowcaseSampleCard from '@/components/showcase/ShowcaseSampleCard.vue'
import { useShowcaseAlbums } from '@/composables/showcase/useShowcaseAlbums'
import { useAlbumNavigation } from '@/composables/gallery/useAlbumNavigation'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { useListTransition } from '@/composables/useListTransition'
import { useBrowseSearch } from '@/composables/useBrowseSearch'
import {
  type ShowcaseEntry,
  type ShowcaseEntryType,
  type ShowcaseRating,
} from '@/utils/showcaseManifest'

const sceneStore = useSceneStore()
const route = useRoute()
const router = useRouter()
useScrollReveal()

const PAGE_SIZE = 24
const SCOPE_OPTS = [{ v:'all', l:'全部' }, { v:'featured', l:'精选' }] as const
const TYPE_OPTS = [{ v:'all', l:'全部类型' }, { v:'scene', l:'场景' }, { v:'artist', l:'画师' }, { v:'popular', l:'热门角色' }, { v:'lora', l:'LoRA' }] as const
const CHAR_OPTS  = [{ v:'all', l:'全部角色' }, { v:'nene', l:'宁宁' }, { v:'natsume', l:'夏目' }, { v:'triad', l:'双人' }] as const
const RATING_OPTS= [{ v:'all', l:'全部分级' }, { v:'All', l:'全年龄' }, { v:'R15', l:'R15' }, { v:'R18', l:'R18' }] as const
const LABELS: Record<string,string> = { nene:'绫地宁宁', natsume:'四季夏目', triad:'宁宁×夏目', All:'全年龄', R15:'R15', R18:'R18' }
const TYPE_LABELS: Record<string,string> = { scene:'场景样张', artist:'画师风格', popular:'热门角色', lora:'LoRA 样张' }

const assets = useShowcaseAssets(() => '暂时无法读取样张目录，请确认媒体磁盘已连接后重试。')
const { entries, loading: manifestLoading, error: reloadError } = assets
const albums = useShowcaseAlbums(entries, () => sceneStore.popularCharacters)
const albumSelection = ref('all')
const selectedAlbum = computed(() => albums.value.find(album => album.id === albumSelection.value))
const albumEntryIds = computed(() => selectedAlbum.value ? new Set(selectedAlbum.value.entryIds) : null)
const featured = computed(() => new Set([...(sceneStore.curation.signatureSceneIds ?? []), ...(sceneStore.curation.curatedSceneIds ?? [])]))
const unavailable = computed(() => !!reloadError.value && !entries.value.length)
const { query: searchQuery, settledQuery, restoreQuery } = useBrowseSearch()
const searchInput = ref<InstanceType<typeof StudioSearch> | null>(null)
const scope       = ref<'all' | 'featured'>('all')
const typeFilter  = ref<'all' | ShowcaseEntryType>('all')
const { albumsOpen, albumRoot, imageHeading, showAlbums, showImages, openAlbum: navigateAlbum } = useAlbumNavigation(albumSelection)
const charFilter  = ref<string>('all')
const ratingFilter= ref<'all' | ShowcaseRating>('all')
function openAlbum(id: string) { resetFilters(); void navigateAlbum(id) }
const visibleCount= ref(PAGE_SIZE)
/** 无限滚动哨兵：划到底自动加载下一页，按钮保留作键盘/兜底入口 */
const loadSentinel = ref<HTMLElement | null>(null)
let sentinelObserver: IntersectionObserver | null = null
function loadMore() { visibleCount.value += PAGE_SIZE }
const currentId   = ref('')
let linkedSceneId = ''
const viewerMounted = ref(false)
const viewerClosing = ref(false)
const originalViewer = ref(false)
const viewerInfoOpen = ref(false)
const viewerInfoEl = ref<HTMLElement | null>(null), viewerInfoClose = ref<HTMLButtonElement | null>(null), viewerInfoToggle = ref<HTMLButtonElement | null>(null)
const viewerClose = ref<HTMLElement | null>(null)
const dialogEl    = ref<HTMLDialogElement | null>(null)
const { compact: narrowViewer, toggle: openViewerInfo, close: closeViewerInfo } = useArtworkInfoDrawer({
  viewer: dialogEl, panel: viewerInfoEl, trigger: viewerInfoToggle, closeButton: viewerInfoClose,
  viewerCloseButton: viewerClose, open: viewerInfoOpen, active: () => viewerMounted.value && !viewerClosing.value,
})
const viewerSurface = useArtworkViewerSurface({
  active: () => viewerMounted.value && !viewerClosing.value, imageKey: () => currentId.value,
  mode: () => originalViewer.value, source: id => sourceImage(String(id)),
})
function sourceImage(id = currentId.value) {
  return document.querySelector<HTMLImageElement>(`.sample[data-sample-id="${CSS.escape(id)}"] .sample-image`)
}
const viewerMotion = useFluidDialog(dialogEl, viewerSurface)
const viewerImageFailed = ref(false)

const viewerVersion = ref(0)
let unmounted = false
let viewActive = true

// Reset visible count whenever filters change
watch([settledQuery, scope, typeFilter, charFilter, ratingFilter, albumSelection], () => { visibleCount.value = PAGE_SIZE })
watch(typeFilter, () => { charFilter.value = 'all' })

function norm(s: string) { return String(s||'').trim().toLocaleLowerCase('zh-CN') }
function ratingLabel(v: string) { return LABELS[v] || v || '未分级' }
function typeLabel(v: string) { return TYPE_LABELS[v] || '场景' }
const characterLabels = computed(() => {
  const labels = new Map(sceneStore.popularCharacters.map(character => [character.id, character.displayName]))
  for (const entry of entries.value) if (entry.displayName && !labels.has(entry.char)) labels.set(entry.char, entry.displayName)
  return labels
})
function charLabel(value: string) { return LABELS[value] || characterLabels.value.get(value) || value || '角色' }
const filterSummary = computed(() => [typeFilter.value === 'all' ? '' : typeLabel(typeFilter.value), charFilter.value === 'all' ? '' : charLabel(charFilter.value), ratingFilter.value === 'all' ? '' : ratingLabel(ratingFilter.value)].filter(Boolean).join(' · ') || '类型、角色与分级')
const searchTerm = computed(() => norm(settledQuery.value))
const searching = computed(() => !!searchTerm.value)
const searchIndex = computed(() => searching.value ? new Map(entries.value.map(entry => [entry.id, {
  title: norm(entry.title), id: norm(entry.id),
  text: norm([entry.id, entry.title, entry.story, entry.category, entry.displayName || '', charLabel(entry.char), ratingLabel(entry.rating), typeLabel(entry.type)].join(' ')),
}])) : null)
watch(searching, active => { if (!active) void searchIndex.value }, { flush: 'sync' })
const hasFilters = computed(() => Boolean(selectedAlbum.value || searchQuery.value.trim() || scope.value !== 'all' || typeFilter.value !== 'all' || charFilter.value !== 'all' || ratingFilter.value !== 'all'))
function thumbSrc(entry: ShowcaseEntry) {
  return assets.thumbUrl(entry.id)
}
function imgSrc(entry: ShowcaseEntry) {
  const path = assets.imageUrl(entry.id)
  return path && viewerVersion.value ? `${path}&retry=${viewerVersion.value}` : path
}

/** 角色筛选选项：收进统一的下拉筛选器，支持全部角色、工作室角色与热门角色。 */
const charOpts = computed<{ v: string; l: string }[]>(() => [...CHAR_OPTS])
const popularCharOpts = computed<{ v: string; l: string }[]>(() => {
  const seen = new Set<string>()
  const options: { v: string; l: string }[] = []
  for (const entry of entries.value) {
    if (entry.type !== 'popular' || seen.has(entry.char)) continue
    seen.add(entry.char)
    options.push({ v: entry.char, l: charLabel(entry.char) })
  }
  return options.sort((a, b) => a.l.localeCompare(b.l, 'zh-CN'))
})

const allCharOptions = computed<{ v: string; l: string }[]>(() => {
  if (typeFilter.value === 'popular') {
    return [{ v: 'all', l: '全部热门角色' }, ...popularCharOpts.value]
  }
  if (typeFilter.value === 'scene' || typeFilter.value === 'lora') {
    return [...charOpts.value]
  }
  // 全部类型下：全部角色 + 工作室角色 + 热门角色
  const base = [...charOpts.value]
  if (popularCharOpts.value.length) {
    return [...base, ...popularCharOpts.value]
  }
  return base
})
const typeOptions = TYPE_OPTS.map(option => ({ value: option.v, label: option.l }))
const characterOptions = computed(() => allCharOptions.value.map(option => ({ value: option.v, label: option.l })))

const filtered = computed(() => {
  const term = searchTerm.value
  const index = term ? searchIndex.value : null
  const matches = entries.value.filter(e => {
    if (albumEntryIds.value && !albumEntryIds.value.has(e.id)) return false
    if (scope.value === 'featured' && !featured.value.has(e.id)) return false
    if (typeFilter.value !== 'all' && e.type !== typeFilter.value) return false
    if (charFilter.value !== 'all' && e.char !== charFilter.value) return false
    if (ratingFilter.value !== 'all' && e.rating !== ratingFilter.value) return false
    return !term || index?.get(e.id)?.text.includes(term)
  })
  if (!term) return matches
  return matches.map(entry => {
    const indexed = index!.get(entry.id)!
    const score = indexed.title === term ? 3 : indexed.title.includes(term) ? 2 : indexed.id.includes(term) ? 1 : 0
    return { entry, score }
  }).sort((a, b) => b.score - a.score).map(({ entry }) => entry)
})
const paged = computed(() => filtered.value.slice(0, visibleCount.value))
const listRoot = ref<HTMLElement | null>(null)
useListTransition(listRoot, () => paged.value.map(entry => entry.id))
const currentIdx = computed(() => filtered.value.findIndex(e => e.id === currentId.value))
const currentEntry = computed(() => filtered.value[currentIdx.value] ?? null)
// Let catalogue replacement and linked-scene filter resets settle before closing.
watch(currentEntry, entry => {
  if (!entry && viewerMounted.value && viewActive && !unmounted) closeViewer()
}, { flush: 'post' })
watch(currentId, () => { viewerInfoEl.value?.querySelector('.viewer-info-body')?.scrollTo(0, 0) }, { flush: 'post' })
const viewerThumbs = computed(() => Object.fromEntries(filtered.value.map(entry => [entry.id, thumbSrc(entry)])))
const workspaceTarget = computed(() => currentEntry.value ? showcaseDestination(currentEntry.value, sceneStore.popularCharacters, sceneStore.sceneBlueprints) : null)

function openViewer(id: string) {
  if (!filtered.value.some(entry => entry.id === id)) return
  if (!dialogEl.value?.open) {
    originalViewer.value = false; viewerInfoOpen.value = false
    viewerSurface.captureOrigin(sourceImage(id), id)
  }
  // Normal reopen uses the same decoded resource. Only a failed image needs a retry key.
  if (viewerImageFailed.value) viewerVersion.value++
  viewerClosing.value = false
  viewerMounted.value = true
  currentId.value = id
  viewerImageFailed.value = false
  // Opening after the computed entry has rendered avoids relying on a same-card
  // close/reopen value change, which is not guaranteed during dialog teardown.
  void nextTick(() => {
    if (viewerMounted.value && !viewerClosing.value && currentId.value === id && currentEntry.value && dialogEl.value && !unmounted && viewActive && route.path === '/showcase') {
      viewerMotion.open()
    }
  })
}
function toggleOriginalViewer() {
  originalViewer.value = !originalViewer.value
  void nextTick(() => dialogEl.value?.querySelector<HTMLElement>('.zoomable-image-viewer')?.focus({ preventScroll: true }))
}
function openLinkedScene() {
  if (!viewActive || route.path !== '/showcase') return
  const id = route.query.scene
  if (typeof id !== 'string') { if (linkedSceneId) closeViewer(); return }
  if (!entries.value.some(entry => entry.id === id)) {
    if (linkedSceneId && !manifestLoading.value && !reloadError.value) closeViewer()
    return
  }
  if (linkedSceneId === id && viewerMounted.value && currentEntry.value) return
  linkedSceneId = id
  if (!filtered.value.some(entry => entry.id === id)) resetFilters()
  albumsOpen.value = false
  openViewer(id)
}
watch(() => route.query.scene, openLinkedScene)
watch([entries, manifestLoading], openLinkedScene)
function clearLinkedScene() {
  const id = linkedSceneId
  linkedSceneId = ''
  if (!id || route.path !== '/showcase' || route.query.scene !== id) return
  const query = { ...route.query }
  delete query.scene
  void router.replace({ query, hash: route.hash })
}
function closeViewer() {
  if (viewerClosing.value || (!viewerMounted.value && !dialogEl.value?.open)) return
  // Clear only the tooltip portal before native close (Reka's Teleport anchor
  // otherwise becomes stale), then release native focus and media together.
  viewerClosing.value = true
  viewerInfoOpen.value = false
  void nextTick(() => {
    if (!viewerClosing.value || !viewActive || unmounted) return
    viewerMotion.close(() => {
      viewerMounted.value = false
      viewerClosing.value = false
      clearLinkedScene()
    })
  })
}

// Native <dialog> owns the top layer, inert background, focus containment and
// Escape handling. Selection changes always pass through openViewer so the media
// source is reset before the already-open dialog is retargeted.
function move(step: number) {
  const arr = filtered.value
  if (!arr.length) return
  const next = Math.max(0, Math.min(arr.length - 1, currentIdx.value + step))
  openViewer(arr[next].id)
}
function openRandom() {
  const src = filtered.value
  if (!src.length) return
  openViewer(src[Math.floor(Math.random() * src.length)].id)
}
function resetFilters() { albumSelection.value = 'all'; restoreQuery(''); scope.value = 'all'; typeFilter.value = 'all'; charFilter.value = 'all'; ratingFilter.value = 'all' }
async function resetFromControl(event: MouseEvent) {
  const owned = document.activeElement === event.currentTarget
  resetFilters()
  await nextTick()
  if (owned && viewActive && !unmounted && !albumsOpen.value && document.activeElement === document.body && !document.querySelector('dialog:modal'))
    searchInput.value?.focus({ preventScroll: true })
}

function onKey(e: KeyboardEvent) {
  if (!dialogEl.value?.open || viewerClosing.value || !currentEntry.value || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
  if (narrowViewer.value && viewerInfoOpen.value) return
  if (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable="true"]')) return
  if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1) }
  if (e.key === 'ArrowRight') { e.preventDefault(); move(1) }
  // Escape 交给 <dialog> 原生处理（@cancel），这里不再重复
}

async function loadManifest(refreshImages = false) {
  try {
    await Promise.all([
      refreshImages ? assets.refresh() : assets.reload(),
      sceneStore.loadBlueprintCatalog().catch(() => {})
    ])
  } catch { /* The shared manifest owner exposes read failures and retains valid entries. */ }
}

onActivated(() => { viewActive = true; document.addEventListener('keydown', onKey); if (entries.value.length) openLinkedScene(); if (loadSentinel.value) sentinelObserver?.observe(loadSentinel.value) })
onDeactivated(() => {
  viewActive = false
  linkedSceneId = ''
  document.removeEventListener('keydown', onKey)
  sentinelObserver?.disconnect()
  viewerMotion.dispose()
  viewerMounted.value = false
  currentId.value = ''
  if (dialogEl.value?.open) dialogEl.value.close()
})
onMounted(() => {
  unmounted = false
  document.addEventListener('keydown', onKey)
  void sceneStore.loadBlueprintCatalog().catch(() => {})
  openLinkedScene()
  // 无限滚动：哨兵进入视口（提前 600px 预载）即自动追加一页，直到全部加载完
  if ('IntersectionObserver' in window) {
    sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (viewActive && !albumsOpen.value && entries.some(e => e.isIntersecting) && visibleCount.value < filtered.value.length) loadMore()
      },
      { rootMargin: '600px 0px' }
    )
    if (viewActive && loadSentinel.value) sentinelObserver.observe(loadSentinel.value)
  }
})
onUnmounted(() => {
  unmounted = true
  viewerMotion.dispose()
  viewerMounted.value = false
  sentinelObserver?.disconnect()
  sentinelObserver = null
  document.removeEventListener('keydown', onKey)
  if (dialogEl.value?.open) dialogEl.value.close()
})
</script>

<style scoped src="@/assets/css/showcase-view.css"></style>
<style src="@/assets/css/showcase-viewer.css"></style>
