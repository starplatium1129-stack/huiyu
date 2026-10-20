import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import type { ArchiveIconName } from '@/components/visual/ArchiveIcon.vue'
import { useSceneStore } from '@/stores/sceneStore'
import { useGlobalSearchWorks } from '@/composables/useGlobalSearchWorks'

interface SearchItem {
  id: string
  label: string
  icon: ArchiveIconName
  path: string
  hint?: string
  keywords: string
}
interface SceneItem { path: string; id: string; title: string; meta: string; keywords: string }
export type GlobalSearchResult = {
  key: string
  icon: ArchiveIconName
  meta?: string
  label: string
} & ({ path: string } | { artworkId: string })

const PAGES: SearchItem[] = [
  { id: 'home', label: '首页', icon: 'spark', path: '/', keywords: '首页 home 绘遇' },
  { id: 'director', label: '开始绘制', icon: 'spark', path: '/prompt-builder', keywords: '绘制 导演台 prompt 出图' },
  { id: 'video', label: '故事短片', icon: 'play', path: '/video-studio', keywords: 'AI 视频创作 视频工作台 视频 动画 本地模型 wan comfyui' },
  { id: 'scene', label: '灵感场景', icon: 'scene', path: '/scene-explorer', keywords: '场景 灵感 库' },
  { id: 'popular-scenes', label: '角色场景', icon: 'scene', path: '/popular-scenes', keywords: '热门角色场景 热门 角色 蓝图 雷电将军 芙莉莲' },
  { id: 'chat', label: '角色房间', icon: 'chat', path: '/chat', keywords: '聊天 角色 宁宁 夏目' },
  { id: 'showcase', label: '参考画册', icon: 'image', path: '/showcase', keywords: '参考画册 CG 画册 样张 展示 定稿 gallery showcase' },
  { id: 'gallery', label: '我的作品', icon: 'gallery', path: '/gallery', keywords: '我的作品 作品册 作品 图库 收藏' },
  { id: 'backup', label: '数据与备份 · 备份、恢复和导出作品', icon: 'download', path: '/gallery?panel=backup', keywords: '备份 恢复 导出 数据 工作区 原图 backup restore export' },
  { id: 'character', label: '角色档案', icon: 'character', path: '/character', keywords: '角色 档案 人设' },
  { id: 'style', label: '画风', icon: 'palette', path: '/style', keywords: '画师风格 画风 色彩 色板' },
  { id: 'lora', label: '模型资料', icon: 'model', path: '/lora', keywords: '角色 LoRA 模型 lora 权重' },
  { id: 'scenario', label: '剧本模式', icon: 'book', path: '/scenario', keywords: '剧本 分幕 剧情' },
  // 显示名与页面 h1 统一为「色彩情绪」（2026-08-30 UX 审计 P1）。keywords 里
  // 保留全部旧叫法：改名之后，按老名字找它的用户不应该什么都搜不到。
  { id: 'color-script', label: '色彩情绪', icon: 'palette', path: '/color-script', keywords: '色彩 情绪 色调 脚本 剧本 配色 对照' },
  { id: 'manager', label: '内容维护', icon: 'manager', path: '/scene-manager', keywords: '管理 编辑 维护' },
  { id: 'control', label: '控制面板', icon: 'gear', path: '/control', keywords: '控制 服务 设置' },
  { id: 'guide', label: '使用指南', icon: 'book', path: '/guide', keywords: '入门 帮助 使用说明 guide help' },
]

const ACTIONS: SearchItem[] = [
  { id: 'draw', label: '开始一幅新的绘制', icon: 'spark', path: '/prompt-builder', keywords: '绘制 开始' },
  { id: 'video-create', label: '开始一段 AI 视频', icon: 'play', path: '/video-studio', keywords: '视频 动画 开始' },
  { id: 'browse', label: '逛一逛灵感场景', icon: 'scene', path: '/scene-explorer', keywords: '场景 逛' },
  { id: 'popular', label: '浏览热门角色蓝图', icon: 'scene', path: '/popular-scenes', keywords: '热门 角色 蓝图' },
  { id: 'works', label: '打开我的作品', icon: 'gallery', path: '/gallery', keywords: '作品' },
]

for (const page of PAGES) page.keywords = (page.label + ' ' + page.keywords).toLowerCase()
for (const action of ACTIONS) action.keywords = action.keywords.toLowerCase()

/** Search data and request ownership are independent of listbox focus and navigation. */
export function useGlobalSearchResults(open: Readonly<Ref<boolean>>, query: Readonly<Ref<string>>) {
  const sceneStore = useSceneStore()
  const scenes = shallowRef<SceneItem[]>([])
  const scenesLoading = ref(false), scenesError = ref('')
  let scenesReady = false, scenesRequest = 0
  const { works, worksError, worksLoading, loadWorks, resetWorks } = useGlobalSearchWorks(query)

  const queryTerms = computed(() => query.value.trim().toLowerCase().split(/\s+/).filter(Boolean))

  function match(keywords: string): boolean {
    return queryTerms.value.every(part => keywords.includes(part))
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

  const filteredPages = computed(() => PAGES.filter(p => match(p.keywords)))
  const filteredActions = computed(() => ACTIONS.filter(a => match(a.keywords)))
  const filteredScenes = computed(() => takeMatches(scenes.value, 8))
  const filteredWorks = computed(() => (works.value ?? []).map(item => ({
    ...item,
    meta: [item.timestamp ? new Date(item.timestamp).toLocaleDateString() : '', item.size].filter(Boolean).join(' · '),
  })))

  const resultGroups = computed<{ id: string; label: string; items: GlobalSearchResult[] }[]>(() => {
    const pages = { id: 'pages', label: '页面', items: filteredPages.value.map(item => ({
      key: `page:${item.id}`, path: item.path, label: item.label, icon: item.icon,
    })) }
    if (!query.value.trim()) return [
      { id: 'actions', label: '快捷操作', items: filteredActions.value.map(item => ({
        key: `action:${item.id}`, path: item.path, label: item.label, icon: item.icon, meta: item.hint,
      })) }, pages,
    ].filter(group => group.items.length)
    return [pages,
      { id: 'scenes', label: `灵感场景 · ${filteredScenes.value.length}`, items: filteredScenes.value.map(item => ({
        key: `scene:${item.id}`, path: item.path, label: item.title, icon: 'scene' as const, meta: item.meta,
      })) },
      { id: 'works', label: `作品 · ${filteredWorks.value.length}`, items: filteredWorks.value.map(item => ({
        key: `work:${item.id}`, artworkId: item.id, label: item.title, icon: 'gallery' as const, meta: item.meta,
      })) },
    ].filter(group => group.items.length)
  })
  const flat = computed(() => resultGroups.value.flatMap(group => group.items))

  function resetSceneRead() {
    scenesRequest++; scenesLoading.value = false; scenesError.value = ''
  }
  async function loadScenes() {
    if (scenesReady || scenesLoading.value || scenesError.value || !open.value || !queryTerms.value.length) return
    const request = ++scenesRequest
    scenesLoading.value = true; scenesError.value = ''
    try {
      // Reuse shard caches without taking ownership of another page's scene list/error.
      const catalogue = await sceneStore.loadBrowserScenes('all')
      if (request !== scenesRequest || !open.value) return
      scenes.value = catalogue.scenes.map((scene) => {
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
      scenesReady = true
    } catch {
      if (request === scenesRequest && open.value) scenesError.value = '场景目录暂未读取，页面与作品仍可搜索。'
    } finally { if (request === scenesRequest) scenesLoading.value = false }
  }

  function retryScenes() { scenesError.value = ''; void loadScenes() }
  function reset() { resetSceneRead(); resetWorks() }
  watch(open, visible => { if (!visible) reset() }, { flush: 'sync' })
  watch([query, open], () => {
    if (!open.value) return
    if (!queryTerms.value.length) reset()
    else { void loadScenes(); loadWorks() }
  })
  onScopeDispose(resetSceneRead)
  return { queryTerms, resultGroups, flat, scenesLoading, scenesError, worksLoading, worksError, retryScenes }
}
