<template>
  <Teleport to="body">
    <Transition :css="false" @enter="surface.enter" @leave="surface.leave" @after-leave="surface.dispose">
    <div v-show="open" class="global-search" :inert="!open" :aria-hidden="!open" @pointerdown.self="close()">
      <div ref="panelEl" class="gs-panel" :data-trigger="triggerSource" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div class="gs-input-row">
          <ArchiveIcon name="search" class="gs-search-icon" />
          <input
            ref="inputEl"
            v-model="query"
            type="search"
            class="gs-input"
            placeholder="搜索场景、作品、页面…"
            aria-label="搜索场景、作品或页面"
            @keydown="onInputKeydown"
          />
          <button type="button" class="gs-esc" aria-label="关闭搜索" title="关闭搜索（Esc）" @click="close()"><ArchiveIcon name="close" /></button>
        </div>

        <p v-if="worksError" class="gs-empty" role="alert">{{ worksError }}</p>
        <div ref="resultsEl" class="gs-results" role="listbox" aria-label="搜索结果">
          <template v-if="!query.trim()">
            <section v-if="filteredActions.length" class="gs-group">
              <h4 class="gs-group-title">快捷操作</h4>
              <button v-for="(item, i) in filteredActions" :key="'a' + item.id" type="button"
                class="gs-row" :class="{ active: activeIndex === i }" role="option"
                :aria-selected="activeIndex === i"
                @pointermove="activeIndex = i" @click="run(i)">
                <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
                <small>{{ item.hint }}</small>
              </button>
            </section>
            <section v-if="filteredPages.length" class="gs-group">
              <h4 class="gs-group-title">页面</h4>
              <button v-for="(item, i) in filteredPages" :key="'p' + item.id" type="button"
                class="gs-row" :class="{ active: activeIndex === filteredActions.length + i }" role="option"
                :aria-selected="activeIndex === filteredActions.length + i"
                @pointermove="activeIndex = filteredActions.length + i" @click="run(filteredActions.length + i)">
                <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
                <small>{{ item.path }}</small>
              </button>
            </section>
          </template>

          <template v-else>
            <section v-if="filteredPages.length" class="gs-group">
              <h4 class="gs-group-title">页面</h4>
              <button v-for="(item, i) in filteredPages" :key="'p' + item.id" type="button"
                class="gs-row" :class="{ active: activeIndex === i }" role="option"
                :aria-selected="activeIndex === i"
                @pointermove="activeIndex = i" @click="run(i)">
                <ArchiveIcon :name="item.icon" /><span>{{ item.label }}</span>
                <small>{{ item.path }}</small>
              </button>
            </section>
            <section v-if="filteredScenes.length" class="gs-group">
              <h4 class="gs-group-title">灵感场景 · {{ filteredScenes.length }}</h4>
              <button v-for="(item, i) in filteredScenes" :key="'s' + item.id" type="button"
                class="gs-row" :class="{ active: activeIndex === filteredPages.length + i }" role="option"
                :aria-selected="activeIndex === filteredPages.length + i"
                @pointermove="activeIndex = filteredPages.length + i" @click="run(filteredPages.length + i)">
                <ArchiveIcon name="scene" /><span>{{ item.title }}</span>
                <small>{{ item.meta }}</small>
              </button>
            </section>
            <section v-if="filteredWorks.length" class="gs-group">
              <h4 class="gs-group-title">作品 · {{ filteredWorks.length }}</h4>
              <button v-for="(item, i) in filteredWorks" :key="'w' + item.id" type="button"
                class="gs-row" :class="{ active: activeIndex === filteredPages.length + filteredScenes.length + i }" role="option"
                :aria-selected="activeIndex === filteredPages.length + filteredScenes.length + i"
                @pointermove="activeIndex = filteredPages.length + filteredScenes.length + i" @click="run(filteredPages.length + filteredScenes.length + i)">
                <ArchiveIcon name="gallery" /><span>{{ item.title }}</span>
                <small>{{ item.meta }}</small>
              </button>
            </section>
            <p v-if="!filteredPages.length && !filteredScenes.length && !filteredWorks.length" class="gs-empty">
              没有匹配的结果，试试场景标题、标签或作品名。
            </p>
          </template>
        </div>
        <div class="gs-footer" aria-hidden="true"><span>↑ ↓ 选择 · Enter 打开</span><span>Esc 关闭</span></div>
      </div>
    </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import ArchiveIcon, { type ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useGlobalSearchRequest } from '@/composables/useGlobalSearch'
import { useSceneStore } from '@/stores/sceneStore'
import { kvInit, kvGet } from '@/composables/useKVStore'
import { ARTWORK_HISTORY_KV_KEY } from '@/utils/storageKeys'
import { indexArtworkSearch } from '@/utils/artworkSearch'
import { useFluidSurface } from '@/composables/useFluidSurface'

const props = defineProps<{
  initialSource?: 'keyboard' | 'pointer'
  initialTrigger?: HTMLElement | null
}>()
const surface = useFluidSurface('.gs-panel')

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
interface WorkItem { path: string; id: string | number; title: string; meta: string; keywords: string }

const HISTORY_KEY = ARTWORK_HISTORY_KV_KEY

const router = useRouter()
const sceneStore = useSceneStore()
const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const resultsEl = ref<HTMLElement | null>(null)
const scenes = ref<SceneItem[]>([])
const works = ref<WorkItem[]>([])
let worksRequest = 0
const worksError = ref('')
const triggerSource = ref<'keyboard' | 'pointer'>('keyboard')
let previousActiveElement: HTMLElement | null = null

const PAGES: PageItem[] = [
  { id: 'home', label: '首页', icon: 'spark', path: '/', keywords: '首页 home 绘遇' },
  { id: 'director', label: '开始绘制', icon: 'spark', path: '/prompt-builder', keywords: '绘制 导演台 prompt 出图' },
  { id: 'video', label: 'AI 视频创作', icon: 'play', path: '/video-studio', keywords: '视频 动画 本地模型 wan comfyui' },
  { id: 'scene', label: '灵感场景', icon: 'scene', path: '/scene-explorer', keywords: '场景 灵感 库' },
  { id: 'popular-scenes', label: '热门角色场景', icon: 'scene', path: '/popular-scenes', keywords: '热门 角色 蓝图 雷电将军 芙莉莲' },
  { id: 'chat', label: '角色房间', icon: 'chat', path: '/chat', keywords: '聊天 角色 宁宁 夏目' },
  { id: 'showcase', label: '参考画册', icon: 'image', path: '/showcase', keywords: '参考画册 CG 画册 样张 展示 定稿 gallery showcase' },
  { id: 'gallery', label: '我的作品', icon: 'gallery', path: '/gallery', keywords: '我的作品 作品册 作品 图库 收藏' },
  { id: 'character', label: '角色档案', icon: 'character', path: '/character', keywords: '角色 档案 人设' },
  { id: 'style', label: '画风', icon: 'palette', path: '/style', keywords: '画风 色彩 色板' },
  { id: 'lora', label: '模型', icon: 'model', path: '/lora', keywords: '模型 lora 权重' },
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

function match(keywords: string): boolean {
  const q = query.value.trim().toLowerCase()
  if (!q) return true
  return q.split(/\s+/).every(part => keywords.toLowerCase().includes(part))
}

const filteredPages = computed(() => PAGES.filter(p => match(p.label + ' ' + p.keywords)))
const filteredActions = computed(() => ACTIONS.filter(a => match(a.keywords)))
const filteredScenes = computed(() => scenes.value.filter(s => match(s.keywords)).slice(0, 8))
const filteredWorks = computed(() => works.value.filter(w => match(w.keywords)).slice(0, 5))

/** 展平结果行：空查询 = 操作 + 页面；有查询 = 页面 + 场景 + 作品 */
const flat = computed<(SearchItem | SceneItem | WorkItem)[]>(() => {
  if (!query.value.trim()) return [...filteredActions.value, ...filteredPages.value]
  return [...filteredPages.value, ...filteredScenes.value, ...filteredWorks.value]
})

function run(index: number) {
  const item = flat.value[index]
  if (!item) return
  close(false)
  void router.push(item.path)
}

function move(step: number) {
  const total = flat.value.length
  if (!total) return
  activeIndex.value = (activeIndex.value + step + total) % total
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
  previousActiveElement = trigger
  triggerSource.value = source
  open.value = true
  query.value = ''
  activeIndex.value = 0
  void loadWorks()
  void loadScenesOnce()
  void nextTick(() => { inputEl.value?.focus() })
}

function close(restoreFocus = true) {
  worksRequest++
  open.value = false
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

async function loadWorks() {
  const request = ++worksRequest
  worksError.value = ''
  works.value = []
  try {
    await kvInit()
    const raw = await kvGet<unknown[]>(HISTORY_KEY)
    if (request !== worksRequest || !open.value) return
    works.value = indexArtworkSearch(raw)
  } catch {
    if (request === worksRequest) worksError.value = '作品读取失败，请关闭搜索后重开以重试。'
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
        ].filter(Boolean).join(' '),
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

watch(query, () => { activeIndex.value = 0 })

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
  document.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.global-search {
  position: fixed; inset: 0; z-index: var(--z-overlay);
  display: flex; align-items: flex-start; justify-content: center;
  padding: clamp(8vh, 14vh, 20vh) var(--s-4) 0;
  background: color-mix(in srgb, var(--art-backdrop) 72%, transparent);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
}
.gs-panel {
  width: min(640px, 96vw);
  border: 1px solid var(--glass-edge);
  border-radius: var(--r-2xl);
  background: var(--bg-surface);
  box-shadow: var(--shadow-glass-elevated);
  overflow: hidden;
}
.gs-input-row {
  display: flex; align-items: center; gap: var(--s-3);
  padding: var(--s-4) var(--s-5);
  background: linear-gradient(120deg, var(--glass-highlight), transparent), var(--bg-surface);
  border-bottom: 1px solid var(--border-soft);
}
.gs-search-icon { color: var(--text-muted); flex: 0 0 auto; }
.gs-input {
  flex: 1; min-width: 0;
  background: transparent; border: 0; outline: 0;
  color: var(--text-primary); font-size: var(--fs-body-lg);
  min-height: 32px;
}
.gs-input:focus-visible { outline: none; box-shadow: none; }
.gs-input-row:focus-within { box-shadow: inset 0 -2px var(--accent); }
.gs-input::placeholder { color: var(--text-muted); }
.gs-esc {
  display: inline-grid; place-items: center; width: 36px; height: 36px;
  background: var(--bg-surface); cursor: pointer;
  flex: 0 0 auto;
  padding: 2px var(--s-2);
  border: 1px solid var(--border-soft); border-radius: var(--r-sm);
  color: var(--text-muted); font: 600 var(--fs-mono-xs) var(--font-mono);
}
.gs-results { max-height: min(52vh, 480px); overflow-y: auto; padding: var(--s-3); }
.gs-group { margin-bottom: var(--s-2); }
.gs-group-title {
  margin: var(--s-2) var(--s-2) var(--s-1);
  color: var(--text-muted);
  font-size: var(--fs-label-sm); font-weight: 600;
}
.gs-row {
  display: flex; align-items: center; gap: var(--s-3);
  width: 100%; min-height: 46px; padding: var(--s-2) var(--s-3);
  border: 0; border-radius: var(--r-md);
  background: transparent; color: var(--text-primary);
  font: inherit; text-align: left; cursor: pointer;
}
.gs-row small { margin-left: auto; color: var(--text-muted); font-size: var(--fs-label-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46%; }
.gs-row.active { background: var(--accent-soft); color: var(--text-primary); }
.gs-row.active small { color: var(--text-secondary); }
.gs-footer { display: flex; justify-content: space-between; gap: var(--s-3); padding: var(--s-3) var(--s-5); border-top: 1px solid var(--border-soft); color: var(--text-muted); background: var(--bg-surface); font-size: var(--fs-label-sm); }
@media (max-width: 600px) { .global-search { padding-top: var(--s-5); } .gs-input { font-size: var(--fs-body); } .gs-results { max-height: 60dvh; } }
.gs-empty { padding: var(--s-6) var(--s-4); color: var(--text-muted); text-align: center; font-size: var(--fs-body-sm); }
@media (prefers-reduced-motion: reduce) { .gs-panel { animation: none; } }
</style>
