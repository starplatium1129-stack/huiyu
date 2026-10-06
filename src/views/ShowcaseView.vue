<template>
  <article class="page showcase-page">
    <header class="showcase-heading">
      <div class="heading-copy tw:min-w-0">
        <div class="heading-title"><h1>参考画册</h1><span class="collection-count"><strong>{{ stats.total }}</strong> 幅灵感</span></div>
      </div>
      <div class="hero-actions tw:flex tw:gap-s-2 tw:flex-wrap"><button class="btn btn-primary" type="button" :disabled="manifestLoading || !filtered.length" @click="openRandom"><ArchiveIcon name="spark" /> 随机邂逅一张</button><RouterLink to="/scene-explorer" class="btn btn-ghost"><ArchiveIcon name="scene" />按场景寻找灵感</RouterLink><button class="btn btn-ghost showcase-refresh" type="button" :disabled="manifestLoading" :aria-label="manifestLoading ? '正在读取画册' : '刷新画册'" @click="loadManifest(true)"><ArchiveIcon name="refresh" /></button></div>
    </header>

    <div class="toolbar-shell" aria-label="样张筛选" data-reveal>
      <div class="search-row tw:flex tw:items-center tw:gap-s-3 tw:flex-wrap">
        <div class="collection-scope showcase-browse-modes studio-segments" role="group" aria-label="画册浏览方式"><AnimatedSelection /><button class="filter-pill" type="button" :class="{ active: !albumsOpen }" :aria-pressed="!albumsOpen" @click="showImages">{{ typeFilter === 'all' ? '全部样张' : '画册样张' }}</button><button class="filter-pill" type="button" :class="{ active: albumsOpen }" :aria-pressed="albumsOpen" @click="showAlbums"><ArchiveIcon name="book" />按画册 <span>{{ albums.length }}</span></button></div>
        <StudioSearch v-show="!albumsOpen" v-model="searchQuery" class="search-field" id="showcaseSearch" label="搜索画册" placeholder="搜索场景、情绪、角色或关键词…" />
        <div v-show="!albumsOpen" class="filter-group collection-scope studio-segments tw:flex tw:gap-s-1 tw:flex-wrap tw:items-center" role="group" aria-label="样张来源">
          <AnimatedSelection />
          <button v-for="opt in SCOPE_OPTS" :key="opt.v" class="filter-pill" :class="{active:scope===opt.v}" type="button" :aria-pressed="scope===opt.v" @click="scope=opt.v">{{ opt.l }}</button>
        </div>
        <button v-if="hasFilters && !albumsOpen" class="filter-reset" type="button" @click="resetFilters">清除筛选</button>
      </div>
      <details v-show="!albumsOpen" class="showcase-filters">
        <summary><span>细选画册</span><span class="filter-summary">{{ filterSummary }}</span><ArchiveIcon name="chevron-down" /></summary>
        <div class="filter-details">
          <div class="filter-group filter-dropdowns tw:flex tw:gap-s-1 tw:flex-wrap tw:items-center">
            <label for="showcaseTypeSelect">作品类型
              <StudioSelect :key="`type-${typeFilter}`" id="showcaseTypeSelect" v-model="typeFilter" label="筛选作品类型"
                :options="TYPE_OPTS.map(opt => ({ value: opt.v, label: opt.l }))" /></label>
            <label for="showcaseCharSelect">角色筛选
              <StudioSelect id="showcaseCharSelect" v-model="charFilter" label="筛选角色"
                :options="allCharOptions.map(opt => ({ value: opt.v, label: opt.l }))" /></label>
          </div>
          <div class="rating-options"><span>内容分级</span><div class="filter-group tw:flex tw:gap-s-1 tw:flex-wrap tw:items-center">
            <button v-for="opt in RATING_OPTS" :key="opt.v" class="filter-pill" :class="{active:ratingFilter===opt.v}" type="button" :aria-pressed="ratingFilter===opt.v" @click="ratingFilter=opt.v">{{ opt.l }}</button>
          </div></div>
        </div>
      </details>
    </div>

    <div v-if="entries.length && (manifestLoading || reloadError)" class="showcase-load-status" role="status"><ArchiveIcon :name="manifestLoading ? 'book' : 'warning'" /><span>{{ manifestLoading ? '正在刷新画册，当前样张仍可继续浏览。' : reloadError }}</span><button v-if="reloadError && !manifestLoading" class="filter-reset" type="button" @click="loadManifest(true)">重试</button></div>
    <div v-show="albumsOpen" v-content-motion="albumsOpen" ref="albumRoot" class="showcase-album-overview" tabindex="-1">
      <ShowcaseAlbums v-if="albums.length && !unavailable" :albums="albums" :selected="typeFilter" :thumb-src="thumbSrc" :aria-busy="manifestLoading" @select="openAlbum" />
      <ArchiveStatePanel v-if="(manifestLoading && !entries.length) || unavailable || (!manifestLoading && !albums.length)" compact :kind="manifestLoading ? 'loading' : unavailable ? 'error' : 'empty'" :title="manifestLoading ? '正在整理画册' : unavailable ? '画册读取失败' : '暂未收录画册'" message="画册按已发布样张的类型整理。"><button class="btn btn-ghost" type="button" @click="showImages">返回样张展墙</button></ArchiveStatePanel>
    </div>
    <div v-show="!albumsOpen" v-content-motion="!albumsOpen" class="showcase-image-browse">
    <div ref="imageHeading" class="showcase-results-heading" tabindex="-1"><div class="showcase-result-location"><button v-if="typeFilter !== 'all'" type="button" class="showcase-album-back" @click="showAlbums"><ArchiveIcon name="chevron-down" />返回画册</button><h2>{{ typeFilter === 'all' ? '全部样张' : (albums.find(album => album.type === typeFilter)?.title || typeLabel(typeFilter)) }}</h2></div><span class="result-meta" id="resultMeta" role="status"><strong>{{ paged.length }}</strong> / {{ filtered.length }} 幅 · R18 默认模糊</span></div>
    <ArchiveStatePanel
      v-if="unavailable"
      class="empty empty-block"
      kind="error"
      title="展示素材暂未连接"
      message="请确认展示素材已连接后重新读取，也可以先逛灵感场景。"
    >
      <button class="btn btn-primary" type="button" @click="loadManifest(true)">重新读取样张</button>
      <RouterLink class="btn btn-ghost" to="/scene-explorer">先逛灵感场景</RouterLink>
    </ArchiveStatePanel>

    <ArchiveStatePanel
      v-else-if="manifestLoading && !entries.length"
      class="empty empty-block"
      kind="loading"
      title="正在读取样张目录…"
      message="正在连接画册目录和已审核样张。"
    >
      <span class="btn btn-ghost" aria-disabled="true">加载中</span>
    </ArchiveStatePanel>

    <ArchiveStatePanel
      v-else-if="!filtered.length"
      :kind="entries.length ? 'filtered' : 'empty'"
      :title="entries.length ? '没有匹配的参考样张' : '画册暂未收录样张'"
      :message="entries.length ? '可尝试更换关键词或重置筛选条件，重新检索参考样张。' : '样张目录已读取，发布样张后可刷新画册查看。'"
    >
      <button v-if="hasFilters" class="btn btn-ghost" type="button" @click="resetFilters">重置筛选</button>
    </ArchiveStatePanel>

    <div v-else class="showcase-grid" :aria-busy="manifestLoading">
      <ShowcaseSampleCard v-for="entry in paged" :key="entry.id" :entry="entry" :src="thumbSrc(entry)"
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
      <dialog ref="dialogEl" class="showcase-viewer" data-image-transition aria-label="样张查看器" @click.self="closeViewer" @cancel.prevent="closeViewer">
        <button class="viewer-close viewer-close-on-art" type="button" id="viewerClose" aria-label="关闭大图" @click="closeViewer"><ArchiveIcon name="close" /></button>
        <div v-if="viewerMounted && currentEntry" class="viewer-layout" :style="{ '--viewer-image-ratio': viewerAspectRatio }">
          <div class="viewer-art">
            <ZoomableImageViewer
              :src="resolveRuntimeUrl(imgSrc(currentEntry))"
              :preview-src="viewerPreviewSrc"
              :alt="currentEntry.title"
              @load="onViewerImageLoad"
              @error="viewerImageFailed = true"
            >
              <template #fallback>
                <div class="viewer-image-fallback">图片暂时无法读取</div>
              </template>
            </ZoomableImageViewer>
          </div>
          <div class="viewer-copy">
            <div class="viewer-kicker">画中一刻 / CG JOURNAL</div>
            <h2>{{ currentEntry.title }}</h2>
            <div class="viewer-meta">
              <span>{{ currentEntry.id }}</span>
              <span>{{ charLabel(currentEntry.char) }}</span>
              <span>{{ ratingLabel(currentEntry.rating) }}</span>
              <span>{{ currentEntry.category }}</span>
            </div>
            <details v-if="currentEntry.meta" class="viewer-production"><summary>创作参数</summary><div class="viewer-meta viewer-meta-gen">
              <span v-if="currentEntry.meta.engine">引擎 {{ currentEntry.meta.engine }}</span>
              <span v-if="currentEntry.meta.checkpoint">Checkpoint {{ currentEntry.meta.checkpoint }}</span>
              <span v-if="currentEntry.meta.model">模型 {{ currentEntry.meta.model }}</span>
              <span v-if="currentEntry.meta.loraId">LoRA {{ currentEntry.meta.loraId }}<template v-if="currentEntry.meta.loraVersion"> · v{{ currentEntry.meta.loraVersion }}</template></span>
              <span v-if="currentEntry.meta.seed !== undefined">Seed {{ currentEntry.meta.seed }}</span>
            </div>
            </details>
            <div class="viewer-story">{{ currentEntry.story }}</div>
            <div class="viewer-actions">
              <StudioTooltip v-if="workspaceTarget" :content="viewerClosing ? null : workspaceTarget.hint">
                <RouterLink class="btn btn-primary" :to="workspaceTarget.to"><ArchiveIcon name="spark" /> {{ workspaceTarget.label }}</RouterLink>
              </StudioTooltip>
              <span class="viewer-position" aria-live="polite">{{ currentIdx + 1 }} / {{ filtered.length }} · 方向键切换，Esc 关闭</span>
              <div class="viewer-paging"><button class="btn btn-ghost" type="button" aria-label="上一张" @click="move(-1)">← 上一张</button><button class="btn btn-ghost" type="button" aria-label="下一张" @click="move(1)">下一张 →</button></div>
            </div>
          </div>
        </div>
      </dialog>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import '@/assets/css/viewer.css'
import { resolveRuntimeUrl, runtimeFetch } from '@/platform/runtimeUrl'

import { useFluidDialog } from '@/composables/useFluidDialog'
import { useFluidSurface } from '@/composables/useFluidSurface'
import { useImageOriginTransition } from '@/composables/useImageOriginTransition'
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import { useSceneStore } from '@/stores/sceneStore'
import { useRoute, useRouter } from 'vue-router'
import { showcaseDestination } from '@/utils/showcaseDestination'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioSearch from '@/components/ui/StudioSearch.vue'
import AnimatedSelection from '@/components/visual/AnimatedSelection.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
import ShowcaseAlbums from '@/components/showcase/ShowcaseAlbums.vue'
import ShowcaseSampleCard from '@/components/showcase/ShowcaseSampleCard.vue'
import { useShowcaseAlbums } from '@/composables/showcase/useShowcaseAlbums'
import { useAlbumNavigation } from '@/composables/gallery/useAlbumNavigation'
import { useScrollReveal } from '@/composables/useScrollReveal'
import {
  parseShowcaseManifest,
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

const entries   = ref<ShowcaseEntry[]>([])
const albums = useShowcaseAlbums(entries)
const featured  = ref(new Set<string>())
const stats     = ref({ total: '—', safe: '—', r15: '—' })
const unavailable = ref(false)
/** manifest 未返回前显示加载面板，避免闪现错误的"没有匹配样张"空状态 */
const manifestLoading = ref(true)
const searchQuery = ref('')
const scope       = ref<'all' | 'featured'>('all')
const typeFilter  = ref<'all' | ShowcaseEntryType>('all')
const { albumsOpen, albumRoot, imageHeading, showAlbums, showImages, openAlbum } = useAlbumNavigation(typeFilter)
const charFilter  = ref<string>('all')
const ratingFilter= ref<'all' | ShowcaseRating>('all')
const visibleCount= ref(PAGE_SIZE)
/** 无限滚动哨兵：划到底自动加载下一页，按钮保留作键盘/兜底入口 */
const loadSentinel = ref<HTMLElement | null>(null)
let sentinelObserver: IntersectionObserver | null = null
function loadMore() { visibleCount.value += PAGE_SIZE }
const currentId   = ref('')
const viewerMounted = ref(false)
const viewerClosing = ref(false)
const viewerPreviewSrc = ref('')
const dialogEl    = ref<HTMLDialogElement | null>(null)
const viewerHero = useImageOriginTransition({ proxyPixelBudget: 1920 * 1080 })
const viewerSurface = useFluidSurface(':scope > .viewer-layout')
function sourceImage(id = currentId.value) {
  return document.querySelector<HTMLImageElement>(`.sample[data-sample-id="${CSS.escape(id)}"] .sample-image`)
}
const viewerMotion = useFluidDialog(dialogEl, {
  enter(el, done) {
    const image = el.querySelector<HTMLImageElement>('.zoomable-img')
    viewerSurface.enter(el, done)
    if (image) void viewerHero.enter(image, el as HTMLElement)
  },
  leave(el, done) {
    const image = el.querySelector<HTMLImageElement>('.zoomable-img')
    void Promise.all([
      new Promise<void>(resolve => viewerSurface.leave(el, resolve)),
      image ? viewerHero.leave(image, el as HTMLElement, sourceImage()) : Promise.resolve(),
    ]).then(done)
  },
  dispose(el) { viewerHero.cancel(); viewerSurface.dispose(el) },
})
const viewerImageFailed = ref(false)
const viewerImageReady = ref(false)
const viewerAspectRatio = ref(2 / 3)
function onViewerImageLoad() {
  viewerImageReady.value = true
  const image = dialogEl.value?.querySelector<HTMLImageElement>('.zoomable-img')
  if (image?.naturalWidth && image.naturalHeight) viewerAspectRatio.value = image.naturalWidth / image.naturalHeight
}

const viewerVersion = ref(0)
// Stable URLs reuse browser-decoded thumbnails; explicit refresh alone busts cache.
const imgVersion = ref(0)
const reloadError = ref('')
let manifestRevision = 0
const manifestController = new AbortController()
let unmounted = false
let viewActive = true

// Reset visible count whenever filters change
watch([searchQuery, scope, typeFilter, charFilter, ratingFilter], () => { visibleCount.value = PAGE_SIZE })
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
const searchIndex = computed(() => new Map(entries.value.map(entry => [entry.id, {
  title: norm(entry.title), id: norm(entry.id),
  text: norm([entry.id, entry.title, entry.story, entry.category, entry.displayName || '', charLabel(entry.char), ratingLabel(entry.rating), typeLabel(entry.type)].join(' ')),
}])))
const hasFilters = computed(() => Boolean(searchQuery.value.trim() || scope.value !== 'all' || typeFilter.value !== 'all' || charFilter.value !== 'all' || ratingFilter.value !== 'all'))
function thumbSrc(entry: ShowcaseEntry) {
  const path = entry.thumb ? `/scene-showcase/${entry.thumb}` : `/scene-showcase/thumbs/${encodeURIComponent(entry.id)}.jpg`
  return path + (imgVersion.value ? `?cv=${imgVersion.value}` : '')
}
function imgSrc(entry: ShowcaseEntry) {
  const path = entry.image ? `/scene-showcase/${entry.image}` : `/scene-showcase/images/${encodeURIComponent(entry.id)}.jpg`
  const query = [imgVersion.value ? `cv=${imgVersion.value}` : '', viewerVersion.value ? `v=${viewerVersion.value}` : ''].filter(Boolean).join('&')
  return path + (query ? `?${query}` : '')
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

const filtered = computed(() => {
  const term = norm(searchQuery.value)
  const matches = entries.value.filter(e => {
    if (scope.value === 'featured' && !featured.value.has(e.id)) return false
    if (typeFilter.value !== 'all' && e.type !== typeFilter.value) return false
    if (charFilter.value !== 'all' && e.char !== charFilter.value) return false
    if (ratingFilter.value !== 'all' && e.rating !== ratingFilter.value) return false
    return !term || searchIndex.value.get(e.id)?.text.includes(term)
  })
  if (!term) return matches
  return matches.map(entry => {
    const indexed = searchIndex.value.get(entry.id)!
    const score = indexed.title === term ? 3 : indexed.title.includes(term) ? 2 : indexed.id.includes(term) ? 1 : 0
    return { entry, score }
  }).sort((a, b) => b.score - a.score).map(({ entry }) => entry)
})
const paged = computed(() => filtered.value.slice(0, visibleCount.value))
const currentIdx = computed(() => filtered.value.findIndex(e => e.id === currentId.value))
const currentEntry = computed(() => filtered.value[currentIdx.value] ?? null)
const workspaceTarget = computed(() => currentEntry.value ? showcaseDestination(currentEntry.value, sceneStore.popularCharacters, sceneStore.sceneBlueprints) : null)

function openViewer(id: string) {
  const source = sourceImage(id), entry = filtered.value.find(item => item.id === id)
  viewerAspectRatio.value = source?.naturalWidth && source.naturalHeight ? source.naturalWidth / source.naturalHeight
    : entry?.width && entry.height ? entry.width / entry.height : 2 / 3
  viewerPreviewSrc.value = viewerHero.capture(source)
  if (dialogEl.value?.open) viewerHero.capture(null)
  // Normal reopen uses the same decoded resource. Only a failed image needs a retry key.
  if (viewerImageFailed.value) viewerVersion.value++
  viewerClosing.value = false
  viewerMounted.value = true
  currentId.value = id
  viewerImageFailed.value = false
  viewerImageReady.value = false
  // Opening after the computed entry has rendered avoids relying on a same-card
  // close/reopen value change, which is not guaranteed during dialog teardown.
  void nextTick(() => {
    if (currentId.value === id && dialogEl.value && !unmounted && viewActive && route.path === '/showcase') {
      viewerMotion.open()
    }
  })
}
function openLinkedScene() {
  if (!viewActive || route.path !== '/showcase') return
  const id = route.query.scene
  if (typeof id === 'string' && entries.value.some(entry => entry.id === id && entry.rating !== 'R18')) openViewer(id)
}
watch(() => route.query.scene, openLinkedScene)
function clearLinkedScene() {
  if (route.path !== '/showcase') return
  if (typeof route.query.scene !== 'string') return
  const query = { ...route.query }
  delete query.scene
  void router.replace({ query })
}
function closeViewer() {
  if (viewerClosing.value || !dialogEl.value?.open) return
  // Clear only the tooltip portal before native close (Reka's Teleport anchor
  // otherwise becomes stale). Keep the image/layout until the exit finishes:
  // removing them here exposes an empty modal backdrop during the whole fade.
  viewerClosing.value = true
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
  const next = (currentIdx.value + step + arr.length) % arr.length
  openViewer(arr[next].id)
}
function openRandom() {
  const safe = (ratingFilter.value === 'R18' ? filtered.value : filtered.value.filter(e => e.rating !== 'R18'))
  const src = safe.length ? safe : filtered.value
  if (!src.length) return
  openViewer(src[Math.floor(Math.random() * src.length)].id)
}
function resetFilters() { searchQuery.value = ''; scope.value = 'all'; typeFilter.value = 'all'; charFilter.value = 'all'; ratingFilter.value = 'all' }

function onKey(e: KeyboardEvent) {
  if (!dialogEl.value?.open || viewerClosing.value || !currentEntry.value || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable="true"]')) return
  if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1) }
  if (e.key === 'ArrowRight') { e.preventDefault(); move(1) }
  // Escape 交给 <dialog> 原生处理（@cancel），这里不再重复
}

async function loadManifest(refreshImages = false) {
  const revision = ++manifestRevision
  reloadError.value = ''
  unavailable.value = false
  manifestLoading.value = true
  try {
    // manifest 是样张目录（非 data/），仍单独取；curation 走共享 store
    const [manifest] = await Promise.all([
      runtimeFetch('/scene-showcase/manifest.json', { cache: 'no-cache', signal: manifestController.signal }).then(r => { if (!r.ok) throw new Error('showcase ' + r.status); return r.json() }),
      sceneStore.loadBlueprintCatalog().catch(() => {})
    ])
    if (unmounted || revision !== manifestRevision) return
    manifestLoading.value = false
    if (refreshImages) imgVersion.value = Date.now()
    const parsed = parseShowcaseManifest(manifest)
    const curation = sceneStore.curation
    entries.value = parsed.entries
    openLinkedScene()
    featured.value = new Set([...(curation.signatureSceneIds ?? []), ...(curation.curatedSceneIds ?? [])])
    stats.value = {
      total: String(parsed.entries.length),
      safe: String(parsed.counts.All),
      r15: String(parsed.counts.R15)
    }
  } catch (err) {
    if (manifestController.signal.aborted || revision !== manifestRevision) return
    console.warn('Showcase unavailable:', err)
    manifestLoading.value = false
    unavailable.value = entries.value.length === 0
    reloadError.value = '暂时无法读取样张目录，请确认媒体磁盘已连接后重试。'
  }
}

onActivated(() => { viewActive = true; document.addEventListener('keydown', onKey); if (entries.value.length) openLinkedScene(); if (loadSentinel.value) sentinelObserver?.observe(loadSentinel.value) })
onDeactivated(() => {
  viewActive = false
  document.removeEventListener('keydown', onKey)
  sentinelObserver?.disconnect()
  viewerMotion.dispose()
  viewerMounted.value = false
  currentId.value = ''
  if (dialogEl.value?.open) dialogEl.value.close()
})
onMounted(async () => {
  unmounted = false
  document.addEventListener('keydown', onKey)
  await loadManifest()
  // 无限滚动：哨兵进入视口（提前 600px 预载）即自动追加一页，直到全部加载完
  if ('IntersectionObserver' in window) {
    sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (!albumsOpen.value && entries.some(e => e.isIntersecting) && visibleCount.value < filtered.value.length) loadMore()
      },
      { rootMargin: '600px 0px' }
    )
    if (loadSentinel.value) sentinelObserver.observe(loadSentinel.value)
  }
})
onUnmounted(() => {
  unmounted = true
  viewerMotion.dispose()
  viewerMounted.value = false
  sentinelObserver?.disconnect()
  sentinelObserver = null
  manifestController.abort()
  document.removeEventListener('keydown', onKey)
  if (dialogEl.value?.open) dialogEl.value.close()
})
</script>

<style scoped src="@/assets/css/showcase-view.css"></style>
<style src="@/assets/css/showcase-viewer.css"></style>
