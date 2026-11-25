import { readShowcaseDetails, readShowcaseStories, useShowcaseAssets } from '@/composables/scene/useShowcaseAssets'
import { useCharacterBlueprints } from '@/composables/scene/useCharacterBlueprints'
import { useFluidDialog } from '@/composables/useFluidDialog'
import { useArtworkInfoDrawer } from '@/composables/useArtworkInfoDrawer'
import { useArtworkViewerSurface } from '@/composables/useArtworkViewerSurface'
import { ref, shallowRef, computed, watch, nextTick, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import { useSceneStore } from '@/stores/sceneStore'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { useRoute, useRouter } from 'vue-router'
import { orderShowcaseEntries } from '@/utils/showcaseBrowseOrder'
import { showcaseDestination } from '@/utils/showcaseDestination'
import { characterParticleTheme } from '@/utils/characterParticleTheme'
import type StudioSearch from '@/components/ui/StudioSearch.vue'
import { useShowcaseAlbums } from '@/composables/showcase/useShowcaseAlbums'
import { useAlbumNavigation } from '@/composables/gallery/useAlbumNavigation'
import { useScrollReveal } from '@/composables/useScrollReveal'
import { useListTransition } from '@/composables/useListTransition'
import { useBrowseSearch } from '@/composables/useBrowseSearch'
import { canFeatureArtist, useFeaturedArtists } from '@/composables/useFeaturedArtists'
import { useToast } from '@/composables/useToast'
import {
  type ShowcaseEntry,
  type ShowcaseEntryType,
  type ShowcaseRating,
} from '@/utils/showcaseManifest'

const PAGE_SIZE = 24
export const SCOPE_OPTS = [{ v: 'all', l: '全部' }, { v: 'featured', l: '精选' }] as const
const TYPE_OPTS = [{ v: 'all', l: '全部类型' }, { v: 'scene', l: '场景' }, { v: 'popular', l: '热门角色' }, { v: 'artist', l: '画师' }, { v: 'lora', l: 'LoRA' }] as const
const CHAR_OPTS = [{ v: 'all', l: '全部角色' }, { v: 'nene', l: '宁宁' }, { v: 'natsume', l: '夏目' }, { v: 'triad', l: '双人' }] as const
export const RATING_OPTS = [{ v: 'all', l: '全部分级' }, { v: 'All', l: '全年龄' }, { v: 'R15', l: 'R15' }, { v: 'R18', l: 'R18' }] as const
const LABELS: Record<string, string> = { nene: '绫地宁宁', natsume: '四季夏目', triad: '宁宁×夏目', All: '全年龄', R15: 'R15', R18: 'R18' }
const TYPE_LABELS: Record<string, string> = { scene: '场景样张', artist: '画师风格', popular: '热门角色', lora: 'LoRA 样张' }

export function useShowcaseView() {
  const sceneStore = useSceneStore()
  const route = useRoute()
  const router = useRouter()
  const toast = useToast()
  useScrollReveal()

  const assets = useShowcaseAssets(() => '暂时无法读取样张目录，请确认媒体磁盘已连接后重试。')
  const { entries, loading: manifestLoading, error: reloadError } = assets
  const orderedEntries = computed(() => orderShowcaseEntries(entries.value, charLabel))
  const albums = useShowcaseAlbums(orderedEntries, () => sceneStore.directoryCharacters)
  const albumSelection = ref('all')
  const selectedAlbum = computed(() => albumSelection.value === 'all' ? undefined : albums.value.find(album => album.id === albumSelection.value))
  const albumEntryIds = computed(() => selectedAlbum.value ? new Set(selectedAlbum.value.entryIds) : null)
  const featured = computed(() => new Set([...(sceneStore.curation.signatureSceneIds ?? []), ...(sceneStore.curation.curatedSceneIds ?? [])]))
  const { featuredArtistIds, toggleFeaturedArtist } = useFeaturedArtists()
  const unavailable = computed(() => !!reloadError.value && !entries.value.length)
  const { query: searchQuery, settledQuery, restoreQuery } = useBrowseSearch()
  const searchInput = ref<InstanceType<typeof StudioSearch> | null>(null)
  const scope = ref<'all' | 'featured'>('all')
  const typeFilter = ref<'all' | ShowcaseEntryType>('all')
  const { albumsOpen, albumRoot, imageHeading, showAlbums, showImages, openAlbum: navigateAlbum } = useAlbumNavigation(albumSelection)

  function artistFeatureState(entry: ShowcaseEntry) {
    if (entry.type !== 'artist' || !canFeatureArtist(entry.artistId)) return undefined
    return featuredArtistIds.value.has(entry.artistId)
  }
  function changeArtistFeature(id: string) {
    const focused = document.activeElement
    try { toggleFeaturedArtist(id) }
    catch (error) {
      toast.error(error instanceof Error ? error.message : '暂时无法保存精选画师。')
      return
    }
    if (scope.value === 'featured' && focused) void nextTick(() => {
      if (!focused.isConnected && document.activeElement === document.body) imageHeading.value?.focus({ preventScroll: true })
    })
  }

  const charFilter = ref<string>('all')
  const ratingFilter = ref<'all' | ShowcaseRating>('all')
  const activeStudioCharacter = computed(() => charFilter.value === 'nene' || charFilter.value === 'natsume' ? charFilter.value : '')
  const viewerCharacterStyle = computed(() => {
    const charId = currentEntry.value?.char || ''
    if (!charId) return undefined
    const color = charId === 'nene'
      ? 'var(--nene-violet)'
      : charId === 'natsume'
        ? 'var(--natsume-amber)'
        : charId === 'triad'
          ? 'var(--accent-violet)'
          : characterParticleTheme(charId).accent
    return { '--viewer-char-accent': color }
  })
  function openAlbum(id: string) { resetFilters(); void navigateAlbum(id) }
  const visibleCount = ref(PAGE_SIZE)
  /** 无限滚动哨兵：划到底自动加载下一页，按钮保留作键盘/兜底入口 */
  const loadSentinel = ref<HTMLElement | null>(null)
  let sentinelObserver: IntersectionObserver | null = null
  function loadMore() { visibleCount.value += PAGE_SIZE }
  const currentId = ref('')
  let linkedSceneId = ''
  const viewerMounted = ref(false)
  const viewerClosing = ref(false)
  const originalViewer = ref(false)
  const viewerInfoOpen = ref(false)
  const viewerInfoEl = ref<HTMLElement | null>(null)
  const viewerInfoClose = ref<HTMLButtonElement | null>(null)
  const viewerInfoToggle = ref<HTMLButtonElement | null>(null)
  const viewerClose = ref<HTMLElement | null>(null)
  const dialogEl = ref<HTMLDialogElement | null>(null)
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

  function norm(s: string) { return String(s || '').trim().toLocaleLowerCase('zh-CN') }
  function ratingLabel(v: string) { return LABELS[v] || v || '未分级' }
  function typeLabel(v: string) { return TYPE_LABELS[v] || '场景' }
  const characterLabels = computed(() => {
    const labels = new Map(sceneStore.directoryCharacters.map(character => [character.id, character.displayName]))
    for (const entry of entries.value) if (entry.displayName && !labels.has(entry.char)) labels.set(entry.char, entry.displayName)
    return labels
  })
  function charLabel(value: string) { return LABELS[value] || characterLabels.value.get(value) || value || '角色' }
  const filterSummary = computed(() => [
    typeFilter.value === 'all' ? '' : typeLabel(typeFilter.value),
    charFilter.value === 'all' ? '' : charLabel(charFilter.value),
    ratingFilter.value === 'all' ? '' : ratingLabel(ratingFilter.value),
  ].filter(Boolean).join(' · ') || '类型、角色与分级')
  const searchTerm = computed(() => norm(settledQuery.value))
  const searching = computed(() => !!searchTerm.value)
  const storyIndex = shallowRef<ReadonlyMap<string, string> | null>(null)
  watch([searching, runtimeResourceIdentity], ([active, identity], previous, cleanup) => {
    if (previous?.[1] !== identity) storyIndex.value = null
    if (!active || storyIndex.value) return
    const controller = new AbortController()
    cleanup(() => controller.abort())
    void readShowcaseStories(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
      .then(rows => { if (!controller.signal.aborted) storyIndex.value = rows })
      .catch(() => {})
  }, { immediate: true })
  const searchIndex = computed(() => searching.value ? new Map(entries.value.map(entry => [entry.id, {
    title: norm(entry.title), id: norm(entry.id),
    text: norm([entry.id, entry.title, storyIndex.value?.get(entry.id) ?? entry.story, entry.category, entry.displayName || '', charLabel(entry.char), ratingLabel(entry.rating), typeLabel(entry.type)].join(' ')),
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
    const matches = orderedEntries.value.filter(e => {
      if (albumEntryIds.value && !albumEntryIds.value.has(e.id)) return false
      if (scope.value === 'featured' && !featured.value.has(e.id) && !artistFeatureState(e)) return false
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
  const currentIdx = computed(() => currentId.value ? filtered.value.findIndex(e => e.id === currentId.value) : -1)
  const currentEntry = computed(() => filtered.value[currentIdx.value] ?? null)
  const viewerDetails = shallowRef<ShowcaseEntry | undefined>()
  const viewerDetailsFailed = ref(false)
  const viewerDetailsAttempt = ref(0)
  const viewerStory = computed(() => viewerDetails.value?.story ?? storyIndex.value?.get(currentId.value) ?? currentEntry.value?.story)
  const viewerMeta = computed(() => viewerDetails.value?.meta ?? currentEntry.value?.meta)
  const showDetails = computed(() => viewerMounted.value && (!narrowViewer.value || viewerInfoOpen.value))
  watch([currentId, showDetails, runtimeResourceIdentity, viewerDetailsAttempt], ([id, open], _previous, cleanup) => {
    viewerDetails.value = undefined
    viewerDetailsFailed.value = false
    if (!id || !open || currentEntry.value?.meta) return
    const controller = new AbortController()
    cleanup(() => controller.abort())
    void readShowcaseDetails([id], AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
      .then(rows => { if (!controller.signal.aborted) viewerDetails.value = rows.get(id) })
      .catch(() => { if (!controller.signal.aborted) viewerDetailsFailed.value = true })
  })
  // Let catalogue replacement and linked-scene filter resets settle before closing.
  watch(currentEntry, entry => {
    if (!entry && viewerMounted.value && viewActive && !unmounted) closeViewer()
  }, { flush: 'post' })
  watch(currentId, () => { viewerInfoEl.value?.querySelector('.viewer-info-body')?.scrollTo(0, 0) }, { flush: 'post' })
  const directoryReady = ref(false)
  const directoryError = ref('')
  async function readDirectory() {
    const version = sceneStore.version
    directoryError.value = ''
    directoryReady.value = false
    try {
      await sceneStore.loadCharacterDirectory()
      if (version === sceneStore.version) directoryReady.value = true
    } catch { if (version === sceneStore.version) directoryError.value = '角色目录读取失败' }
  }
  const selectedCharacter = computed(() => {
    const entry = currentEntry.value
    return viewerMounted.value && !viewerClosing.value && entry?.type === 'popular' && directoryReady.value
      && sceneStore.directoryCharacters.some(character => character.id === entry.char) ? entry.char : ''
  })
  const blueprints = useCharacterBlueprints(() => selectedCharacter.value)
  const destinationError = computed(() => currentEntry.value?.type === 'popular' && (directoryError.value || blueprints.error.value))
  function retryDestination() { if (directoryError.value) void readDirectory(); else blueprints.retry() }
  const workspaceTarget = computed(() => {
    const entry = currentEntry.value
    if (!entry || entry.type === 'popular' && (!directoryReady.value || selectedCharacter.value && !blueprints.ready.value)) return null
    return showcaseDestination(entry, sceneStore.directoryCharacters, blueprints.items.value)
  })

  function openViewer(id: string) {
    if (!filtered.value.some(entry => entry.id === id)) return
    if (!dialogEl.value?.open) {
      originalViewer.value = false
      viewerInfoOpen.value = false
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
        readDirectory(), sceneStore.loadCuration().catch(() => {}),
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
    openLinkedScene()
    // 无限滚动：哨兵进入视口（提前 600px 预载）即自动追加一页，直到全部加载完
    if ('IntersectionObserver' in window) {
      sentinelObserver = new IntersectionObserver(
        (entries) => {
          if (viewActive && !albumsOpen.value && entries.some(e => e.isIntersecting) && visibleCount.value < filtered.value.length) loadMore()
        },
        { rootMargin: '600px 0px' },
      )
      if (viewActive && loadSentinel.value) sentinelObserver.observe(loadSentinel.value)
    }
  })
  watch(() => sceneStore.version, () => {
    void readDirectory()
    void sceneStore.loadCuration().catch(() => {})
  }, { immediate: true })
  onUnmounted(() => {
    unmounted = true
    viewerMotion.dispose()
    viewerMounted.value = false
    sentinelObserver?.disconnect()
    sentinelObserver = null
    document.removeEventListener('keydown', onKey)
    if (dialogEl.value?.open) dialogEl.value.close()
  })

  return {
    SCOPE_OPTS, RATING_OPTS, assets, entries, manifestLoading, reloadError,
    albums, albumSelection, selectedAlbum, featured, unavailable,
    searchQuery, searchInput, scope, typeFilter, charFilter, ratingFilter,
    albumsOpen, albumRoot, imageHeading, showAlbums, showImages, openAlbum,
    artistFeatureState, changeArtistFeature, activeStudioCharacter, viewerCharacterStyle,
    loadSentinel, loadMore,
    dialogEl, viewerMounted, viewerClosing, originalViewer, viewerInfoOpen,
    viewerInfoEl, viewerInfoClose, viewerInfoToggle, viewerClose,
    narrowViewer, openViewerInfo, closeViewerInfo, viewerSurface, viewerImageFailed,
    ratingLabel, typeLabel, charLabel, filterSummary, hasFilters, thumbSrc, imgSrc,
    typeOptions, characterOptions, filtered, paged, listRoot,
    currentIdx, currentEntry, viewerStory, viewerMeta, viewerDetailsFailed, viewerDetailsAttempt,
    destinationError, retryDestination, workspaceTarget,
    openViewer, toggleOriginalViewer, closeViewer, openRandom, resetFromControl, loadManifest,
  }
}
