<template>
  <article class="page showcase-page">
    <header class="showcase-heading">
      <div class="heading-copy"><div class="page-kicker">CG COLLECTION / 参考画册</div>
        <div class="heading-title"><h1>把心动，一页页收藏。</h1><span class="collection-count"><strong>{{ stats.total }}</strong> 幅样张</span></div>
        <p>翻阅场景样张，找到想画的下一幕。自己的创作收在「我的作品」。</p>
      </div>
      <div class="hero-actions"><button class="btn btn-ghost" type="button" :disabled="manifestLoading || !filtered.length" @click="openRandom"><ArchiveIcon name="refresh" /> 随机邂逅一张</button><RouterLink to="/scene-explorer" class="btn btn-ghost">按场景寻找灵感</RouterLink><button class="btn btn-ghost" type="button" :disabled="manifestLoading" @click="loadManifest"><ArchiveIcon name="refresh" /> {{ manifestLoading ? '正在读取…' : '刷新画册' }}</button></div>
    </header>

    <div class="toolbar-shell" aria-label="样张筛选" data-reveal>
      <div class="search-row">
        <div class="search-field">
          <input ref="searchInput" v-model="searchQuery" type="search" class="scene-search" id="showcaseSearch" aria-label="搜索画册" @keydown.esc.prevent="searchQuery = ''" placeholder="搜索场景、情绪、角色或关键词…" />
          <button v-if="searchQuery" class="scene-search-clear" type="button" aria-label="清空搜索" @click="searchQuery=''; searchInput?.focus()">×</button>
        </div>
        <div class="filter-group">
          <button v-for="opt in SCOPE_OPTS" :key="opt.v" class="filter-pill" :class="{active:scope===opt.v}" type="button" :aria-pressed="scope===opt.v" @click="scope=opt.v">{{ opt.l }}</button>
        </div>
        <div class="filter-group filter-dropdowns">
          <label class="sr-only" for="showcaseTypeSelect">作品类型</label>
          <StudioSelect :key="`type-${typeFilter}`" id="showcaseTypeSelect" v-model="typeFilter" label="筛选作品类型"
            :options="TYPE_OPTS.map(opt => ({ value: opt.v, label: opt.l }))" />

          <label class="sr-only" for="showcaseCharSelect">角色筛选</label>
          <StudioSelect id="showcaseCharSelect" v-model="charFilter" label="筛选角色"
            :options="allCharOptions.map(opt => ({ value: opt.v, label: opt.l }))" />
        </div>
        <div class="filter-group">
          <button v-for="opt in RATING_OPTS" :key="opt.v" class="filter-pill" :class="{active:ratingFilter===opt.v}" type="button" :aria-pressed="ratingFilter===opt.v" @click="ratingFilter=opt.v">{{ opt.l }}</button>
        </div>
        <button v-if="hasFilters" class="filter-pill" type="button" @click="resetFilters">清除筛选</button>
        <span class="result-meta" id="resultMeta" role="status">
          显示 <strong>{{ paged.length }}</strong> / {{ filtered.length }} 个匹配样张 · R18 默认模糊
        </span>
      </div>
    </div>

    <p v-if="reloadError && !unavailable" role="status">{{ reloadError }}</p>
    <ArchiveStatePanel
      v-if="unavailable"
      class="empty empty-block"
      kind="error"
      title="展示素材暂未连接"
      message="重新启动控制面板后会自动连接 AI/SceneShowcase 中最新的审核展示集。"
    >
      <button class="btn btn-primary" type="button" @click="loadManifest">重新读取样张</button>
      <RouterLink class="btn btn-ghost" to="/scene-explorer">先逛灵感场景</RouterLink>
    </ArchiveStatePanel>

    <ArchiveStatePanel
      v-else-if="manifestLoading"
      class="empty empty-block"
      kind="loading"
      title="正在读取样张目录…"
      message="连接 AI/SceneShowcase 审核展示集。"
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

    <div v-else class="showcase-grid stagger-container" data-reveal data-reveal-delay="1">
      <article
        v-for="entry in paged" :key="entry.id"
        class="sample" :class="{ 'sample-r18': entry.rating === 'R18' }"
        :data-rating="entry.rating"
      >
        <button class="sample-visual" :class="{ 'sample-visual-measured': hasRatio(entry) }" type="button" :style="{ '--sample-ratio': sampleRatio(entry) }" :aria-label="'查看 ' + entry.title + ' 大图'" @click="openViewer(entry.id)">
          <img v-if="!brokenThumbs.has(entry.id)" class="sample-image" :class="{ 'sample-image-ready': loadedThumbs.has(entry.id) }" :src="thumbSrc(entry)" :alt="entry.title"
            :width="entry.width" :height="entry.height" loading="lazy" decoding="async" @load="markThumbLoaded(entry)" @error="markThumbError(entry)" />
          <span v-else class="sample-image-fallback" aria-hidden="true"><ArchiveIcon name="image" /></span>
          <span class="sample-shade"></span>
          <span class="sample-badges">
            <span v-if="featured.has(entry.id)" class="sample-badge">精选</span>
            <span v-else-if="entry.type !== 'scene'" class="sample-badge sample-badge-type">{{ typeLabel(entry.type) }}</span>
            <span v-else></span>
            <span class="sample-badge" :class="'rating-' + entry.rating">{{ ratingLabel(entry.rating) }}</span>
          </span>
          <span v-if="entry.rating === 'R18'" class="sample-sensitive">
            <strong>R18</strong><span>悬停或聚焦预览</span>
          </span>
          <span class="sample-caption">
            <span class="sample-kicker">
              <span>{{ charLabel(entry.char) }}</span>

            </span>
            <strong class="sample-title">{{ entry.title }}</strong>
          </span>
        </button>
      </article>
    </div>

    <div ref="loadSentinel" v-show="paged.length < filtered.length" class="load-wrap">
      <button class="btn btn-ghost load-more" type="button" @click="loadMore">加载更多（剩余 {{ filtered.length - paged.length }}）</button>
    </div>

    <!-- 查看器 dialog -->
    <Teleport to="body">
      <!-- 必须用 showModal() 打开（见 openViewer）：设 open 属性只是非模态 dialog，
           没有 top layer、没有 ::backdrop，背景不 inert，Tab 能直接跑到下面的网格里 -->
      <dialog ref="dialogEl" class="showcase-viewer" aria-label="样张查看器" @click.self="closeViewer" @cancel.prevent="closeViewer">
        <button class="viewer-close viewer-close-on-art" type="button" id="viewerClose" aria-label="关闭大图" @click="closeViewer"><ArchiveIcon name="close" /></button>
        <div v-if="viewerMounted && currentEntry" class="viewer-layout">
          <div class="viewer-art">
            <ZoomableImageViewer
              :src="imgSrc(currentEntry)"
              :alt="currentEntry.title"
              @load="viewerImageReady = true"
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
              <StudioTooltip v-if="workspaceTarget" :content="workspaceTarget.hint">
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
import { useFluidDialog } from '@/composables/useFluidDialog'
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import { useSceneStore } from '@/stores/sceneStore'
import { useRoute, useRouter } from 'vue-router'
import { showcaseDestination } from '@/utils/showcaseDestination'
import ArchiveStatePanel from '@/components/visual/ArchiveStatePanel.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import ZoomableImageViewer from '@/components/visual/ZoomableImageViewer.vue'
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
const featured  = ref(new Set<string>())
const stats     = ref({ total: '—', safe: '—', r15: '—' })
const unavailable = ref(false)
/** manifest 未返回前显示加载面板，避免闪现错误的"没有匹配样张"空状态 */
const manifestLoading = ref(true)
const searchQuery = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const scope       = ref<'all' | 'featured'>('all')
const typeFilter  = ref<'all' | ShowcaseEntryType>('all')
const charFilter  = ref<string>('all')
const ratingFilter= ref<'all' | ShowcaseRating>('all')
const visibleCount= ref(PAGE_SIZE)
/** 无限滚动哨兵：划到底自动加载下一页，按钮保留作键盘/兜底入口 */
const loadSentinel = ref<HTMLElement | null>(null)
let sentinelObserver: IntersectionObserver | null = null
function loadMore() { visibleCount.value += PAGE_SIZE }
const currentId   = ref('')
const viewerMounted = ref(false)
const dialogEl    = ref<HTMLDialogElement | null>(null)
const viewerMotion = useFluidDialog(dialogEl)
const brokenThumbs = ref(new Set<string>())
const loadedThumbs = ref(new Set<string>())
const viewerImageFailed = ref(false)
const viewerImageReady = ref(false)

function markThumbLoaded(entry: ShowcaseEntry) {
  if (!loadedThumbs.value.has(entry.id)) {
    loadedThumbs.value = new Set([...loadedThumbs.value, entry.id])
  }
}
const viewerVersion = ref(0)
const imgVersion = ref(Date.now())
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
const searchIndex = computed(() => new Map(entries.value.map(entry => [entry.id, norm([entry.id, entry.title, entry.story, entry.category, entry.displayName || '', charLabel(entry.char), ratingLabel(entry.rating), typeLabel(entry.type)].join(' '))])))
const hasFilters = computed(() => Boolean(searchQuery.value.trim() || scope.value !== 'all' || typeFilter.value !== 'all' || charFilter.value !== 'all' || ratingFilter.value !== 'all'))
function thumbSrc(entry: ShowcaseEntry) {
  return entry.thumb ? `/scene-showcase/${entry.thumb}?cv=${imgVersion.value}` : `/scene-showcase/thumbs/${encodeURIComponent(entry.id)}.jpg?cv=${imgVersion.value}`
}
function imgSrc(entry: ShowcaseEntry) {
  return entry.image ? `/scene-showcase/${entry.image}?cv=${imgVersion.value}&v=${viewerVersion.value}` : `/scene-showcase/images/${encodeURIComponent(entry.id)}.jpg?cv=${imgVersion.value}&v=${viewerVersion.value}`
}
/** 只有 manifest 明确给出尺寸时才锁比例框；缺失时保持原图的自然高度，避免留白边 */
function hasRatio(entry: ShowcaseEntry): boolean {
  return Boolean(entry.width && entry.height)
}
function sampleRatio(entry: ShowcaseEntry): string {
  return entry.width && entry.height ? `${entry.width} / ${entry.height}` : '3 / 4'
}
function markThumbError(entry: ShowcaseEntry) {
  brokenThumbs.value = new Set([...brokenThumbs.value, entry.id])
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
    return !term || searchIndex.value.get(e.id)?.includes(term)
  })
  if (!term) return matches
  const relevance = (entry: ShowcaseEntry) => norm(entry.title) === term ? 3 : norm(entry.title).includes(term) ? 2 : norm(entry.id).includes(term) ? 1 : 0
  return matches.sort((a, b) => relevance(b) - relevance(a))
})
const paged = computed(() => filtered.value.slice(0, visibleCount.value))
const currentIdx = computed(() => filtered.value.findIndex(e => e.id === currentId.value))
const currentEntry = computed(() => filtered.value[currentIdx.value] ?? null)
const workspaceTarget = computed(() => currentEntry.value ? showcaseDestination(currentEntry.value, sceneStore.popularCharacters, sceneStore.sceneBlueprints) : null)

function openViewer(id: string) {
  viewerMounted.value = true
  currentId.value = id
  viewerImageFailed.value = false
  viewerImageReady.value = false
  viewerVersion.value = Date.now()
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
  // Unmount Reka tooltip portals while the native dialog is still connected;
  // tearing them down after dialog.close() leaves a stale Teleport anchor.
  viewerMounted.value = false
  viewerMotion.close(() => { clearLinkedScene() })
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
  if (!currentEntry.value || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable="true"]')) return
  if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1) }
  if (e.key === 'ArrowRight') { e.preventDefault(); move(1) }
  // Escape 交给 <dialog> 原生处理（@cancel），这里不再重复
}

async function loadManifest() {
  const revision = ++manifestRevision
  reloadError.value = ''
  unavailable.value = false
  manifestLoading.value = true
  try {
    // manifest 是样张目录（非 data/），仍单独取；curation 走共享 store
    const [manifest] = await Promise.all([
      fetch('/scene-showcase/manifest.json', { cache: 'no-cache', signal: manifestController.signal }).then(r => { if (!r.ok) throw new Error('showcase ' + r.status); return r.json() }),
      sceneStore.load().catch(() => {})
    ])
    if (unmounted || revision !== manifestRevision) return
    manifestLoading.value = false
    imgVersion.value = Date.now()
    loadedThumbs.value = new Set()
    brokenThumbs.value = new Set()
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
        if (entries.some(e => e.isIntersecting) && visibleCount.value < filtered.value.length) loadMore()
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

<style scoped>
.showcase-heading { display: flex; justify-content: space-between; align-items: center; flex-wrap:wrap; gap: var(--s-3) var(--s-5); padding-block: var(--s-3) var(--s-5); }
.heading-copy { min-width:0; }
.heading-title { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--s-2) var(--s-4); margin-block:var(--s-2); }
.showcase-heading h1 { font: 500 clamp(1.5rem, 2.5vw, 2rem)/1.35 var(--font-serif); margin:0; }
.showcase-heading p { margin:0; color: var(--text-muted); font-size:var(--fs-body-sm); }
.collection-count { white-space:nowrap; font-size:var(--fs-label); color:var(--text-muted); }
.collection-count strong { color:var(--text-primary); font-weight:600; font-variant-numeric:tabular-nums; }
.viewer-position { font-size: var(--fs-label-xs); color: var(--text-muted); text-align: center; }
.viewer-paging { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-2); }
.viewer-production { padding-block: var(--s-3); border-block: 1px solid var(--border-soft); margin-block: var(--s-4); color: var(--text-muted); font-size: var(--fs-label); }
.viewer-production summary { cursor: pointer; min-height: 32px; }

/* 空状态:替代原先的内联 padding/text-align/font-size */
.empty-block { padding:var(--s-8) 0; text-align:center; }
.empty-glyph { font-size:var(--fs-glyph); }
.hero-actions { display:flex; gap:var(--s-2); flex-wrap:wrap; }

/* Surface and focus treatment are shared with the other browsing pages. */
.toolbar-shell {
  position:sticky; top:70px; z-index:var(--z-sticky);
  margin-bottom:var(--s-4);
}
.search-row { display:flex; align-items:center; gap:var(--s-2); flex-wrap:wrap; }
.search-field { position:relative; flex:1 1 240px; min-width:0; }
.scene-search { width:100%; padding:var(--s-2) 36px var(--s-2) var(--s-3); background:var(--bg-deep); border:1px solid var(--border-soft); border-radius:var(--r-md); color:var(--text-primary); font-size:var(--fs-body-sm); outline:none; }
.scene-search:focus { border-color:var(--accent); }
.scene-search-clear { position:absolute; top:50%; right:8px; transform:translateY(-50%); width:24px; height:24px; border:0; background:transparent; color:var(--text-muted); cursor:pointer; font-size:var(--fs-body-lg); }
.filter-group { display:flex; gap:var(--s-1); flex-wrap:wrap; align-items:center; }
.filter-dropdowns { display:grid; grid-template-columns:minmax(100px,.6fr) minmax(0,1fr); flex:1 1 300px; min-width:0; gap:var(--s-2); align-items:center; }
.filter-pill { padding:5px 12px; border:1px solid transparent; border-radius:var(--r-terminal); background:transparent; color:var(--text-secondary); cursor:pointer; font:500 var(--fs-label-sm) var(--font-sans); transition:border-color var(--motion-hover),color var(--motion-hover),background var(--motion-hover),transform var(--motion-hover) var(--ease-out); }
.filter-pill.active,.filter-pill:hover { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }
.filter-select { width:100%; min-width:0; max-width:100%; height:32px; padding:0 var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-terminal); background:var(--bg-deep); color:var(--text-secondary); font:500 var(--fs-label-sm) var(--font-sans); outline:none; transition:border-color var(--motion-hover),color var(--motion-hover); }
.filter-select:hover { border-color:color-mix(in srgb,var(--accent) 45%,var(--border-soft)); }
.filter-select:focus { border-color:var(--accent); color:var(--text-primary); }
.result-meta { margin-left:auto; color:var(--text-muted); font-size:var(--fs-label-sm); white-space:nowrap; }
:deep(.result-meta strong) { color:var(--accent); }

/* 2026-08-15：多列（columns）改为 Grid —— columns 先填满一列再换列（从上到下），
   Grid 按行填充，样张按 1-2-3-4 从左到右排列，符合阅读直觉。 */
.showcase-grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:var(--s-4); align-items:start; }
.sample { overflow:hidden; position:relative; border:1px solid var(--border-soft); border-radius:var(--r-dossier); background:var(--bg-surface); box-shadow:var(--shadow-sm); transition:transform var(--motion-hover),border-color var(--motion-hover),box-shadow var(--motion-hover); animation:showcaseSampleIn .48s var(--ease-out) both; }
.sample::before { content:""; position:absolute; z-index:var(--z-raised); top:-1px; left:var(--s-3); width:28px; height:1px; background:var(--archive-blue); opacity:.86; pointer-events:none; }
.sample:nth-child(2) { animation-delay:.04s; }
.sample:nth-child(3) { animation-delay:.08s; }
.sample:nth-child(4) { animation-delay:.12s; }
.sample:nth-child(5) { animation-delay:.16s; }
.sample:nth-child(6) { animation-delay:.2s; }
@keyframes showcaseSampleIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
.sample:hover { border-color:color-mix(in srgb,var(--accent) 42%,var(--border-soft)); box-shadow:var(--shadow-md); }
.sample-visual { display:block; width:100%; padding:0; border:0; background:var(--art-mat); color:var(--on-art-primary); text-align:left; cursor:zoom-in; position:relative; overflow:hidden; }
/* 已知尺寸时才预留比例框；未知尺寸退回原图自然高度，保持每张图原始比例 */
.sample-visual-measured { aspect-ratio:var(--sample-ratio, 3 / 4); }
.sample-visual:focus-visible { outline:3px solid var(--accent); outline-offset:-3px; }
.sample-image { width:100%; height:auto; display:block; background:var(--art-mat); opacity:0; filter:blur(7px); transition:opacity var(--motion-route) var(--ease-out),filter var(--motion-atmosphere) var(--ease-out),transform var(--motion-route) var(--ease-out); }
.sample-visual-measured .sample-image { height:100%; object-fit:contain; }
.sample-image-ready { opacity:1; filter:blur(0); }
.sample-image-fallback { display:grid; min-height:260px; place-items:center; color:var(--text-muted); font-size:var(--fs-glyph); }
.sample-visual-measured .sample-image-fallback { height:100%; min-height:0; }
/* R18 遮罩优先于渐进模糊：未悬停时始终是深模糊 */
.sample-r18 .sample-image,
.sample-r18 .sample-image,
.sample-r18 .sample-image.sample-image-ready { filter:blur(18px) saturate(.78); transform:scale(1.08); }
.sample-shade { position:absolute; inset:38% 0 0; background:linear-gradient(to bottom,transparent,var(--art-scrim)); pointer-events:none; }
.sample-badges { position:absolute; inset:var(--s-3) var(--s-3) auto; display:flex; justify-content:space-between; gap:var(--s-2); pointer-events:none; }
.sample-badge { padding:var(--s-1) var(--s-2); border:1px solid var(--on-art-line); border-radius:var(--r-pill); background:var(--art-scrim); color:var(--on-art-primary); backdrop-filter:blur(12px); font-size:var(--fs-mono-sm); font-weight:700; }
.sample-badge.rating-R18 { background:color-mix(in srgb,var(--danger) 52%,var(--art-scrim)); }
.sample-badge.sample-badge-type { background:color-mix(in srgb,var(--accent) 46%,var(--art-scrim)); border-color:color-mix(in srgb,var(--accent) 60%,var(--on-art-line)); }
.sample-caption { position:absolute; z-index:var(--z-base); inset:auto 0 0; display:block; padding:48px var(--s-3) var(--s-3); pointer-events:none; }
.sample-kicker { display:flex; justify-content:space-between; gap:var(--s-2); margin-bottom:var(--s-1); color:var(--on-art-secondary); font-size:var(--fs-mono-xs); }
.sample-title { display:block; color:var(--on-art-primary); font-size:var(--fs-body); line-height:var(--lh-label); text-shadow:0 2px 14px var(--art-backdrop); }
.sample-sensitive { position:absolute; z-index:var(--z-raised); inset:50% auto auto 50%; display:grid; justify-items:center; gap:2px; min-width:112px; padding:var(--s-3) var(--s-4); transform:translate(-50%,-50%); border:1px solid var(--on-art-line); border-radius:var(--r-pill); background:var(--art-scrim); color:var(--on-art-primary); box-shadow:var(--shadow-md); backdrop-filter:blur(12px); pointer-events:none; transition:opacity var(--motion-surface),transform var(--motion-surface); }
.sample-sensitive strong { font-size:var(--fs-label-sm); letter-spacing:.12em; }
.sample-sensitive span { color:var(--on-art-secondary); font-size:var(--fs-mono-xs); }
.sample-r18 .sample-image { filter:blur(18px) saturate(.78); transform:scale(1.08); }
.sample-r18 .sample-image.sample-image-ready { filter:blur(18px) saturate(.78); transform:scale(1.08); }
@media (hover: hover) and (pointer: fine) {
  .sample:hover { transform:translateY(-3px); }
  .sample:not(.sample-r18):hover .sample-image { transform:scale(1.018); }
  .sample-r18:hover .sample-image,
  .sample-r18:hover .sample-image.sample-image-ready { filter:blur(0) saturate(1); transform:scale(1.018); }
  .sample-r18:hover .sample-sensitive { opacity:0; transform:translate(-50%,-45%); }
}
.sample-r18:focus-within .sample-image,
.sample-r18:focus-within .sample-image.sample-image-ready { filter:blur(0) saturate(1); transform:scale(1.08); }
.sample-r18:focus-within .sample-sensitive { opacity:0; transform:translate(-50%,-50%); }
.load-wrap { display:flex; justify-content:center; margin:var(--s-6) 0; }
.load-more { min-width:190px; }

@media(max-width:1000px) { .showcase-grid { grid-template-columns:repeat(3, minmax(0,1fr)); } }
@media(max-width: 768px) {
  .search-row { flex-direction:column; align-items:stretch; min-width:0; }
  .search-field, .filter-dropdowns { flex:none; width:100%; }
  .filter-group { min-width:0; }
  .result-meta { margin-left:0; }
  .showcase-page .toolbar-shell { position:relative; top:auto; }
  .result-meta { white-space:normal; }
  .showcase-grid { grid-template-columns:repeat(2, minmax(0,1fr)); gap:var(--s-3); }
  .sample { border-radius:var(--r-dossier); }
}
@media(prefers-reduced-motion:reduce) { .sample,.sample-image,.sample-sensitive { transition:none; animation:none; } }
@media(prefers-contrast:more) { .showcase-page .toolbar-shell { border-color:var(--text-muted); } }
@media(forced-colors:active) { .showcase-page .toolbar-shell { background:Canvas; border-color:CanvasText; } }
</style>

<style>
/* 非 scoped：查看器 Teleport 到 body，scoped 属性选择器命不中，
   之前就是因此丢样式导致文字压在图上。与作品册同一处理方式。 */
.showcase-viewer {
  position: fixed; inset: 0; z-index: var(--z-overlay);
  width: 100vw; height: 100vh; max-width: none; max-height: none;
  margin: 0; padding: clamp(12px, 2vw, 28px); border: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--art-backdrop);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
}
.showcase-viewer:not([open]) { display: none; }
.showcase-viewer > .viewer-close { position:absolute; top:var(--s-4); right:var(--s-4); z-index:var(--z-raised); }
.showcase-viewer .viewer-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, .65fr);
  width: min(1160px, 96vw);
  height: min(92dvh, 900px);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--on-art-line) 42%, transparent);
  border-radius: var(--r-stage);
  /* 查看器永远处于暗色画布，不随浅色主题变亮 */
  background: color-mix(in srgb, var(--art-backdrop) 84%, var(--bg-deep));
  color: var(--on-art-primary);
  box-shadow: var(--shadow-lg);
}
.showcase-viewer .viewer-art {
  min-width: 0; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  padding: clamp(16px, 3vw, 40px);
  background: radial-gradient(120% 90% at 50% 12%, color-mix(in srgb, var(--accent-glow) 20%, transparent), transparent 60%), var(--art-backdrop);
}
.showcase-viewer .viewer-art :deep(.zoomable-img) { max-height: 100%; }
.showcase-viewer .viewer-art :deep(.zoom-transform-layer) { height: 100%; width: 100%; }
.showcase-viewer .viewer-art img {
  display: block; max-width: 100%; max-height: min(88vh, 860px);
  width: auto; height: auto; object-fit: contain; border-radius: var(--r-lg);
  opacity: 0; transition: opacity var(--motion-route) var(--ease-out);
}
.showcase-viewer .viewer-art img.viewer-image-ready { opacity: 1; }
.showcase-viewer .viewer-image-fallback { color:var(--on-art-secondary); font-size:var(--fs-body-sm); }
.showcase-viewer .viewer-copy {
  min-width: 0; overflow-y: auto;
  padding: clamp(20px, 3vw, 36px);
  border-left: 1px solid color-mix(in srgb, var(--on-art-line) 30%, transparent);
  background: transparent;
  color: var(--on-art-primary);
}
.showcase-viewer .viewer-copy .viewer-close { float: right; margin: -6px -6px var(--s-3) var(--s-3); border-color: color-mix(in srgb, var(--on-art-line) 55%, transparent); background: color-mix(in srgb, var(--art-scrim) 65%, transparent); color: var(--on-art-primary); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
.showcase-viewer .viewer-copy .viewer-close:hover { border-color: var(--on-art-line); color: var(--on-art-primary); background: color-mix(in srgb, var(--on-art-line) 14%, transparent); }
.showcase-viewer .viewer-copy .viewer-kicker { color: var(--on-art-secondary); }
.showcase-viewer .viewer-copy h2 {
  margin: var(--s-3) 0 var(--s-2);
  font-size: clamp(1.25rem, 2.4vw, 1.9rem); line-height: var(--lh-tight);
}
.showcase-viewer .viewer-meta { display: flex; gap: var(--s-2); flex-wrap: wrap; margin-bottom: var(--s-4); }
.showcase-viewer .viewer-meta span {
  max-width: 100%; overflow-wrap:anywhere;
  padding: var(--s-1) var(--s-2); border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--on-art-line) 16%, transparent);
  color: var(--on-art-primary);
  font: 700 var(--fs-mono-sm) var(--font-mono);
}
.showcase-viewer .viewer-meta-gen { margin-top: calc(var(--s-4) * -0.4); }
.showcase-viewer .viewer-popular-note { margin: 0; color: var(--on-art-secondary); font-size: var(--fs-body-sm); line-height: var(--lh-loose); }
.showcase-viewer .viewer-story {
  color: var(--on-art-secondary); font-size: var(--fs-body-sm);
  line-height: var(--lh-loose); margin-bottom: var(--s-5);
}
.showcase-viewer .viewer-actions { display: grid; gap: var(--s-2); }
.showcase-viewer .viewer-actions .btn { justify-content: center; }
/* 查看器永远处于暗色画布：按钮用 on-art 色系，避免浅色主题下对比不足 */
.showcase-viewer .btn-ghost {
  color: var(--on-art-secondary);
  border-color: color-mix(in srgb, var(--on-art-line) 62%, transparent);
}
.showcase-viewer .btn-ghost:hover {
  color: var(--on-art-primary);
  border-color: var(--on-art-line);
  background: color-mix(in srgb, var(--on-art-line) 12%, transparent);
}

@media (max-width: 1000px) {
  .showcase-viewer .viewer-layout { grid-template-columns: minmax(0, 1fr) 320px; }
}
@media (max-width: 768px) {
  .showcase-viewer { padding: 0; }
  .showcase-viewer .viewer-layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
    width: 100vw; max-height: 100vh; border-radius: 0; border: 0;
  }
  .showcase-viewer .viewer-art { padding: var(--s-3); }
  .showcase-viewer .viewer-art img { max-height: 46vh; }
  .showcase-viewer .viewer-copy { border-left: 0; border-top: 1px solid var(--border-soft); }
}
</style>
