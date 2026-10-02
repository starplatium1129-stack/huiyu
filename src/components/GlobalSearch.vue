<template>
  <Teleport to="body">
    <!-- Frequent lookup and keyboard commands keep the focus handoff immediate. -->
    <div v-show="open" class="global-search" :inert="!open" :aria-hidden="!open" @pointerdown.self="close()">
      <div ref="panelEl" class="gs-panel" :data-trigger="triggerSource" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div class="gs-heading tw:flex tw:items-center tw:justify-between tw:gap-s-3 tw:text-primary tw:text-body-sm"><strong>快速查找</strong><span>页面、场景与作品</span></div>
        <div class="gs-input-row tw:flex tw:items-center tw:gap-s-3">
          <ArchiveIcon name="search" class="gs-search-icon" />
          <input
            ref="inputEl"
            v-model="query"
            type="search"
            class="gs-input"
            role="combobox"
            placeholder="搜索场景、作品、页面…"
            aria-label="搜索场景、作品或页面"
            aria-haspopup="listbox"
            :aria-expanded="open"
            :aria-controls="listboxId"
            aria-autocomplete="list"
            :aria-activedescendant="activeResultId"
            :aria-describedby="searchAnnouncementId"
            @keydown="onInputKeydown"
          />
          <StudioTooltip content="关闭搜索（Esc）">
            <button type="button" class="gs-esc tw:inline-grid tw:w-[40px] tw:h-[40px] tw:cursor-pointer tw:rounded-pill tw:text-muted" aria-label="关闭搜索" @click="close()"><ArchiveIcon name="close" /></button>
          </StudioTooltip>
        </div>

        <p v-if="worksError" class="gs-empty tw:text-muted tw:text-center tw:text-body-sm" role="alert">{{ worksError }}</p>
        <p v-else-if="worksLoading" class="gs-empty tw:text-muted tw:text-center tw:text-body-sm" role="status">正在读取作品…</p>
        <div :id="listboxId" ref="resultsEl" class="gs-results tw:overflow-y-auto tw:p-s-3" role="listbox" aria-label="搜索结果">
          <template v-if="!query.trim()">
            <section v-if="filteredActions.length" class="gs-group tw:mb-s-2">
              <h4 class="gs-group-title tw:text-muted tw:text-label-sm tw:font-semibold">快捷操作</h4>
              <button v-for="(item, i) in filteredActions" :key="'a' + item.id" type="button"
                class="gs-row tw:flex tw:items-center tw:gap-s-3 tw:w-full tw:min-h-[46px] tw:rounded-md tw:text-primary tw:text-left tw:cursor-pointer" :class="{ active: activeIndex === i }" role="option"
                :id="resultId('action', item.id)"
                :aria-selected="activeIndex === i"
                tabindex="-1"
                @pointermove="activeIndex = i" @click="run(i)">
                <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
                <small>{{ item.hint }}</small>
              </button>
            </section>
            <section v-if="filteredPages.length" class="gs-group tw:mb-s-2">
              <h4 class="gs-group-title tw:text-muted tw:text-label-sm tw:font-semibold">页面</h4>
              <button v-for="(item, i) in filteredPages" :key="'p' + item.id" type="button"
                class="gs-row tw:flex tw:items-center tw:gap-s-3 tw:w-full tw:min-h-[46px] tw:rounded-md tw:text-primary tw:text-left tw:cursor-pointer" :class="{ active: activeIndex === filteredActions.length + i }" role="option"
                :id="resultId('page', item.id)"
                :aria-selected="activeIndex === filteredActions.length + i"
                tabindex="-1"
                @pointermove="activeIndex = filteredActions.length + i" @click="run(filteredActions.length + i)">
                <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
                <small>{{ item.path }}</small>
              </button>
            </section>
          </template>

          <template v-else>
            <section v-if="filteredPages.length" class="gs-group tw:mb-s-2">
              <h4 class="gs-group-title tw:text-muted tw:text-label-sm tw:font-semibold">页面</h4>
              <button v-for="(item, i) in filteredPages" :key="'p' + item.id" type="button"
                class="gs-row tw:flex tw:items-center tw:gap-s-3 tw:w-full tw:min-h-[46px] tw:rounded-md tw:text-primary tw:text-left tw:cursor-pointer" :class="{ active: activeIndex === i }" role="option"
                :id="resultId('page', item.id)"
                :aria-selected="activeIndex === i"
                tabindex="-1"
                @pointermove="activeIndex = i" @click="run(i)">
                <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
                <small>{{ item.path }}</small>
              </button>
            </section>
            <section v-if="filteredScenes.length" class="gs-group tw:mb-s-2">
              <h4 class="gs-group-title tw:text-muted tw:text-label-sm tw:font-semibold">灵感场景 · {{ filteredScenes.length }}</h4>
              <button v-for="(item, i) in filteredScenes" :key="'s' + item.id" type="button"
                class="gs-row tw:flex tw:items-center tw:gap-s-3 tw:w-full tw:min-h-[46px] tw:rounded-md tw:text-primary tw:text-left tw:cursor-pointer" :class="{ active: activeIndex === filteredPages.length + i }" role="option"
                :id="resultId('scene', item.id)"
                :aria-selected="activeIndex === filteredPages.length + i"
                tabindex="-1"
                @pointermove="activeIndex = filteredPages.length + i" @click="run(filteredPages.length + i)">
                <ArchiveIcon name="scene" /><span>{{ item.title }}</span>
                <small>{{ item.meta }}</small>
              </button>
            </section>
            <section v-if="filteredWorks.length" class="gs-group tw:mb-s-2">
              <h4 class="gs-group-title tw:text-muted tw:text-label-sm tw:font-semibold">作品 · {{ filteredWorks.length }}</h4>
              <button v-for="(item, i) in filteredWorks" :key="'w' + item.id" type="button"
                class="gs-row tw:flex tw:items-center tw:gap-s-3 tw:w-full tw:min-h-[46px] tw:rounded-md tw:text-primary tw:text-left tw:cursor-pointer" :class="{ active: activeIndex === filteredPages.length + filteredScenes.length + i }" role="option"
                :id="resultId('work', item.id)"
                :aria-selected="activeIndex === filteredPages.length + filteredScenes.length + i"
                tabindex="-1"
                @pointermove="activeIndex = filteredPages.length + filteredScenes.length + i" @click="run(filteredPages.length + filteredScenes.length + i)">
                <ArchiveIcon name="gallery" /><span>{{ item.title }}</span>
                <small>{{ item.meta }}</small>
              </button>
            </section>
            <p v-if="!worksError && !worksLoading && !filteredPages.length && !filteredScenes.length && !filteredWorks.length" class="gs-empty tw:text-muted tw:text-center tw:text-body-sm">
              没有匹配的结果，试试场景标题、标签或作品名。
            </p>
          </template>
        </div>
        <p :id="searchAnnouncementId" class="gs-sr-status tw:absolute tw:w-[1px] tw:h-[1px] tw:p-0 tw:m-[-1px] tw:overflow-hidden tw:whitespace-nowrap" role="status" aria-live="polite" aria-atomic="true">{{ resultsAnnouncement }}</p>
        <div class="gs-footer tw:flex tw:justify-between tw:gap-s-3 tw:text-muted tw:text-label-sm" aria-hidden="true"><span>↑ ↓ 选择 · Enter 打开</span><span>Esc 关闭</span></div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted, nextTick, useId, watch } from 'vue'
import { useRouter } from 'vue-router'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useGlobalSearchRequest } from '@/composables/useGlobalSearch'
import { useSceneStore } from '@/stores/sceneStore'
import { artworkRepository } from '@/storage/artworkRepository'
import { indexArtworkSearch } from '@/utils/artworkSearch'

const props = defineProps<{
  initialSource?: 'keyboard' | 'pointer'
  initialTrigger?: HTMLElement | null
}>()

interface SearchItem {
  id: string
  label: string
  icon: ArchiveIconName
  path: string
  hint?: string
  meta?: string
  keywords: string
}

interface PageItem extends SearchItem { path: string }
interface SceneItem { path: string; id: string; title: string; meta: string; keywords: string }
type SearchResultKind = 'action' | 'page' | 'scene' | 'work'
interface FlatSearchResult {
  kind: SearchResultKind
  id: string | number
  path: string
  label: string
}


const router = useRouter()
const sceneStore = useSceneStore()
const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const resultsEl = ref<HTMLElement | null>(null)
const scenes = shallowRef<SceneItem[]>([])
const works = shallowRef<ReturnType<typeof indexArtworkSearch> | null>(null)
const worksController = shallowRef<AbortController | null>(null)
const worksError = ref('')
const worksLoading = computed(() => worksController.value !== null)
const triggerSource = ref<'keyboard' | 'pointer'>('keyboard')
let previousActiveElement: HTMLElement | null = null

const searchInstanceId = useId()
const listboxId = `global-search-listbox-${searchInstanceId}`
const searchAnnouncementId = `global-search-announcement-${searchInstanceId}`

const PAGES: PageItem[] = [
  { id: 'home', label: '首页', icon: 'spark', path: '/', keywords: '首页 home 绘遇' },
  { id: 'director', label: '开始绘制', icon: 'spark', path: '/prompt-builder', keywords: '绘制 导演台 prompt 出图' },
  { id: 'video', label: '故事短片', icon: 'play', path: '/video-studio', keywords: 'AI 视频创作 视频工作台 视频 动画 本地模型 wan comfyui' },
  { id: 'scene', label: '灵感场景', icon: 'scene', path: '/scene-explorer', keywords: '场景 灵感 库' },
  { id: 'popular-scenes', label: '角色场景', icon: 'scene', path: '/popular-scenes', keywords: '热门角色场景 热门 角色 蓝图 雷电将军 芙莉莲' },
  { id: 'chat', label: '角色房间', icon: 'chat', path: '/chat', keywords: '聊天 角色 宁宁 夏目' },
  { id: 'showcase', label: '参考画册', icon: 'image', path: '/showcase', keywords: '参考画册 CG 画册 样张 展示 定稿 gallery showcase' },
  { id: 'gallery', label: '我的作品', icon: 'gallery', path: '/gallery', keywords: '我的作品 作品册 作品 图库 收藏' },
  { id: 'character', label: '角色档案', icon: 'character', path: '/character', keywords: '角色 档案 人设' },
  { id: 'style', label: '画风', icon: 'palette', path: '/style', keywords: '画师风格 画风 色彩 色板' },
  { id: 'lora', label: '模型资料', icon: 'model', path: '/lora', keywords: '角色 LoRA 模型 lora 权重' },
  { id: 'scenario', label: '剧本模式', icon: 'book', path: '/scenario', keywords: '剧本 分幕 剧情' },
  // 显示名与页面 h1 统一为「色彩情绪」（2026-08-30 UX 审计 P1）。keywords 里
  // 保留全部旧叫法：改名之后，按老名字找它的用户不应该什么都搜不到。
  { id: 'color-script', label: '色彩情绪', icon: 'palette', path: '/color-script', keywords: '色彩 情绪 色调 脚本 剧本 配色 对照' },
  { id: 'manager', label: '场景管理', icon: 'manager', path: '/scene-manager', keywords: '管理 编辑 维护' },
  { id: 'control', label: '控制面板', icon: 'gear', path: '/control', keywords: '控制 服务 设置' },
]

const ACTIONS: SearchItem[] = [
  { id: 'draw', label: '开始一幅新的绘制', icon: 'spark', path: '/prompt-builder', keywords: '绘制 开始' },
  { id: 'video-create', label: '开始一段 AI 视频', icon: 'play', path: '/video-studio', keywords: '视频 动画 开始' },
  { id: 'browse', label: '逛一逛灵感场景', icon: 'scene', path: '/scene-explorer', keywords: '场景 逛' },
  { id: 'popular', label: '浏览热门角色蓝图', icon: 'scene', path: '/popular-scenes', keywords: '热门 角色 蓝图' },
  { id: 'works', label: '打开我的作品', icon: 'gallery', path: '/gallery', keywords: '作品' },
]

const queryTerms = computed(() => query.value.trim().toLowerCase().split(/\s+/).filter(Boolean))

function match(keywords: string): boolean {
  const text = keywords.toLowerCase()
  return queryTerms.value.every(part => text.includes(part))
}

function takeMatches<T extends { keywords: string }>(items: readonly T[], limit: number): T[] {
  const terms = queryTerms.value
  if (!open.value || !terms.length) return []
  const result: T[] = []
  for (const item of items) {
    if (!terms.every(part => item.keywords.includes(part))) continue
    result.push(item)
    if (result.length === limit) break
  }
  return result
}

const filteredPages = computed(() => PAGES.filter(p => match(p.label + ' ' + p.keywords)))
const filteredActions = computed(() => ACTIONS.filter(a => match(a.keywords)))
const filteredScenes = computed(() => takeMatches(scenes.value, 8))
const filteredWorks = computed(() => takeMatches(works.value ?? [], 5).map(item => ({
  ...item,
  meta: [item.timestamp ? new Date(item.timestamp).toLocaleDateString() : '', item.size].filter(Boolean).join(' · '),
})))

/** 展平结果行：空查询 = 操作 + 页面；有查询 = 页面 + 场景 + 作品 */
const flat = computed<FlatSearchResult[]>(() => {
  const actions: FlatSearchResult[] = filteredActions.value.map(item => ({
    kind: 'action', id: item.id, path: item.path, label: item.label,
  }))
  const pages: FlatSearchResult[] = filteredPages.value.map(item => ({
    kind: 'page', id: item.id, path: item.path, label: item.label,
  }))
  const scenes: FlatSearchResult[] = filteredScenes.value.map(item => ({
    kind: 'scene', id: item.id, path: item.path, label: item.title,
  }))
  const works: FlatSearchResult[] = filteredWorks.value.map(item => ({
    kind: 'work', id: item.id, path: item.path, label: item.title,
  }))
  if (!query.value.trim()) return [...actions, ...pages]
  return [...pages, ...scenes, ...works]
})

const activeResult = computed(() => flat.value[activeIndex.value])
const activeResultId = computed(() => {
  const result = activeResult.value
  return open.value && result ? resultId(result.kind, result.id) : undefined
})
const resultsAnnouncement = computed(() => {
  const total = flat.value.length
  if (!total) return query.value.trim() ? '没有匹配的结果' : '暂无可用结果'
  const result = activeResult.value
  return result
    ? `找到 ${total} 个结果，当前第 ${activeIndex.value + 1} 项：${result.label}`
    : `找到 ${total} 个结果`
})

function resultId(kind: SearchResultKind, id: string | number) {
  return `${listboxId}-${kind}-${encodeURIComponent(String(id))}`
}

function run(index: number) {
  const item = flat.value[index]
  if (!item) return
  close(false)
  void router.push(item.path)
}

function move(step: number) {
  const total = flat.value.length
  if (!total) return
  const current = activeIndex.value >= total || activeIndex.value < 0 ? -1 : activeIndex.value
  activeIndex.value = (current + step + total) % total
  void nextTick(() => {
    const activeRow = resultsEl.value?.querySelector('.gs-row.active') as HTMLElement | null
    activeRow?.scrollIntoView({ block: 'nearest' })
  })
}

function onInputKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    move(event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    run(activeIndex.value)
  }
}

function openPanel(source: 'keyboard' | 'pointer' = 'keyboard', trigger = document.activeElement as HTMLElement | null) {
  // Global navigation must not open an inert body portal underneath a modal editor.
  if (!open.value && (document.querySelector('dialog:modal') || document.activeElement?.closest('[aria-modal="true"]'))) return
  previousActiveElement = trigger
  triggerSource.value = source
  open.value = true
  query.value = ''
  activeIndex.value = 0
  void loadScenesOnce()
  void nextTick(() => { inputEl.value?.focus() })
}

function close(restoreFocus = true) {
  open.value = false
  resetWorks()
  const previous = previousActiveElement
  previousActiveElement = null
  if (restoreFocus && previous?.isConnected) void nextTick(() => previous.focus({ preventScroll: true }))
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
  const target = event.target as HTMLElement | null
  const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '') || target?.isContentEditable === true

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    if (open.value) { close() } else { openPanel('keyboard') }
    return
  }

  if (event.key === '/' && !isInput && !open.value) {
    event.preventDefault()
    openPanel('keyboard')
  }
}

function resetWorks() {
  worksController.value?.abort()
  worksController.value = null
  works.value = null
  worksError.value = ''
}

async function loadWorks() {
  if (works.value !== null || worksController.value || worksError.value) return
  const controller = new AbortController()
  worksController.value = controller
  try {
    const raw = await artworkRepository.readSearchIndex(AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]))
    if (controller.signal.aborted) return
    works.value = indexArtworkSearch(raw)
  } catch {
    if (!controller.signal.aborted) worksError.value = '作品读取失败，请关闭搜索后重开以重试。'
  } finally {
    if (worksController.value === controller) worksController.value = null
  }
}
async function loadScenes() {
  try {
    // 审计 2026-09-05 P2-02：搜索只需要场景分片与轻元数据，走 loadHome 轻载，
    // 不再借全量 load() 把 3.4MB 蓝图拖进每个页面的首屏
    await sceneStore.loadHome()
    scenes.value = sceneStore.scenes.map((scene) => {
      const s = scene as Record<string, unknown>
      return {
        id: String(s.id || ''),
        path: `/prompt-builder?scene=${encodeURIComponent(String(s.id || ''))}`,
        title: String(s.title || s.id || ''),
        meta: [String(s.category || ''), String(s.emotion || '')].filter(Boolean).join(' · '),
        keywords: [
          s.title, s.story, s.category, s.emotion, s.location, s.weather,
          Array.isArray(s.tags) ? (s.tags as string[]).join(' ') : '',
          s.char,
        ].filter(Boolean).join(' ').toLowerCase(),
      } satisfies SceneItem
    })
  } catch { scenesRequested = false /* 下一次打开允许重新读取 */ }
}

/** 场景索引只建一次：首次打开面板时才拉（此前是挂载即拉，把数据请求摊进每个页面首屏） */
let scenesRequested = false
function loadScenesOnce() {
  if (scenesRequested) return
  scenesRequested = true
  void loadScenes()
}

useFocusTrap(panelEl, () => open.value, {
  onEscape: close,
  initialFocus: inputEl,
})

watch(query, () => {
  activeIndex.value = 0
  if (!queryTerms.value.length) resetWorks()
  else if (open.value) void loadWorks()
})

// 可见入口的唤起通道（2026-08-30 UX 审计 P1）：本组件挂在路由之外，导航里的
// 触发按钮在路由之内，两者没有父子关系，只能经单例请求。watch 的是递增序号
// 而非布尔量，所以连点也能被感知。
const { openRequest, openSource } = useGlobalSearchRequest()
watch(openRequest, () => {
  if (openRequest.value === 0) return
  openPanel(openSource.value)
})

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  if (props.initialSource) openPanel(props.initialSource, props.initialTrigger)
  // 场景索引延迟到首次打开面板（loadScenesOnce）；挂载即拉会把全量数据请求
  // 摊进包括首页在内的每个页面首屏（审计 2026-09-05 P2-02）
})
onUnmounted(() => {
  resetWorks()
  document.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.global-search {
  --search-inset: clamp(var(--s-4), 10dvh, 96px);
  @apply tw:fixed; inset: 0; z-index: var(--z-overlay);
  @apply tw:flex tw:items-start tw:justify-center;
  padding: var(--search-inset) var(--s-4);
  background: color-mix(in srgb, var(--art-backdrop) 72%, transparent);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
}
.gs-panel {
  width: min(640px, 96vw);
  max-height: calc(100dvh - 2 * var(--search-inset));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--glass-edge);
  @apply tw:rounded-2xl;
  background: var(--bg-surface);
  box-shadow: var(--shadow-glass-elevated);
  @apply tw:overflow-hidden;
}
.gs-input-row {
  padding: var(--s-4) var(--s-5);
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-soft);
}
.gs-search-icon { @apply tw:text-muted; flex: 0 0 auto; }
.gs-input {
  flex: 1; @apply tw:min-w-0;
  background: transparent; border: 0; outline: 0;
  @apply tw:text-primary tw:text-body-lg tw:min-h-[32px];
}
.gs-input:focus-visible { outline: none; box-shadow: none; }
.gs-input-row:focus-within { box-shadow: inset 0 -2px var(--accent); }
.gs-input::placeholder { @apply tw:text-muted; }
.gs-heading { padding:var(--s-3) var(--s-5); }
.gs-heading span { @apply tw:text-secondary tw:text-label-xs; }
.gs-esc { place-items: center;
  background: var(--bg-surface);
  flex: 0 0 auto;
  padding: 2px var(--s-2);
  border: 1px solid var(--border-soft); font: 600 var(--fs-mono-xs) var(--font-mono);
}
.gs-heading, .gs-input-row, .gs-footer, .gs-panel > .gs-empty { flex-shrink:0; }
.gs-results { min-height:0; flex:1 1 auto; max-height: min(52vh, 480px); overscroll-behavior:contain; scroll-padding-block:var(--s-2); }
.gs-group-title {
  margin: var(--s-2) var(--s-2) var(--s-1);
}
.gs-row { padding: var(--s-2) var(--s-3);
  border: 0;
  background: transparent;
  font: inherit;
}
.gs-row small { @apply tw:ml-auto tw:text-muted tw:text-label-sm tw:whitespace-nowrap tw:overflow-hidden tw:text-ellipsis tw:max-w-[46%]; }
.gs-row.active { background: var(--accent-soft); @apply tw:text-primary; }
.gs-row.active small { @apply tw:text-secondary; }
.gs-footer { padding: var(--s-3) var(--s-5); border-top: 1px solid var(--border-soft); background: var(--bg-surface); }
.gs-sr-status { clip: rect(0 0 0 0); clip-path: inset(50%); border: 0; }
@media (max-width: 600px) { .global-search { @apply tw:pt-s-5; } .gs-input { @apply tw:text-body; } .gs-results { @apply tw:max-h-[60dvh]; } }
.gs-empty { padding: var(--s-6) var(--s-4); }
@media (prefers-reduced-motion: reduce) { .gs-panel { animation: none; } }
</style>
