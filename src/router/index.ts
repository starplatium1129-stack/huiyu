import { useTaskCenter, approveTaskReload } from '@/composables/useTaskCenter'
import { confirmAction } from '@/composables/useConfirm'
import { createRouter, createWebHistory } from 'vue-router'
import { prefersReducedMotion } from '@/utils/motionPreference'
import { needsDocumentReload } from './documentPolicy'
import { createRoutePrefetcher } from './prefetch'
import { captureScrollAnchor, restoreScrollAnchor } from '@/utils/scrollAnchor'
export { needsDocumentReload } from './documentPolicy'
export { prefetchRouteResources } from './prefetch'

/** Keep a bounded window-scroll snapshot for explicit SPA returns to cached pages. */
const SCROLL_MEMORY_ROUTES = new Set(['/scene-explorer', '/showcase', '/gallery', '/prompt-builder', '/video-studio'])
const SCROLL_MEMORY_LIMIT = 16
const routeScrollMemory = new Map<string, { left: number; top: number }>()
let cancelRouteScrollRestore: (() => void) | null = null

function cancelPendingScrollRestore() {
  cancelRouteScrollRestore?.()
  cancelRouteScrollRestore = null
}

function currentLocation(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function rememberRouteScroll(path: string) {
  if (typeof window === 'undefined' || !SCROLL_MEMORY_ROUTES.has(path.split(/[?#]/, 1)[0] || '')) return
  const anchor = captureScrollAnchor()
  if (!anchor) return
  routeScrollMemory.delete(path)
  routeScrollMemory.set(path, anchor)
  while (routeScrollMemory.size > SCROLL_MEMORY_LIMIT) routeScrollMemory.delete(routeScrollMemory.keys().next().value!)
}

/** Retry after async page data expands the document, avoiding a clamped return position. */
function scheduleScrollRestore(path: string, position: { left: number; top: number }) {
  // 锚点恢复原语与场景库筛选共用（src/utils/scrollAnchor.ts）；离开目标地址就放弃。
  // 取消句柄是本模块自己的，不再影响场景库那一路的待恢复锚点。
  cancelPendingScrollRestore()
  cancelRouteScrollRestore = restoreScrollAnchor(position, {
    shouldContinue: () => currentLocation() === path,
    onRestored: () => { cancelRouteScrollRestore = null },
    onAbandoned: () => { cancelRouteScrollRestore = null },
  })
}

/**
 * Live2D（PixiJS）编译着色器要用 new Function，需要 CSP 的 'unsafe-eval'。
 * 服务端只给 Live2D 页面文档放行（server/security.js），可是 SPA 只在首次
 * 请求时拿一次 CSP：从首页点进 Live2D 路由属于前端跳转，不发新文档请求，
 * 沿用的还是首页那份不含 unsafe-eval 的策略，于是 Live2D 必然初始化失败。
 * 这也解释了"直接打开 Live2D 页面正常、从站内点进去就挂"。
 *
 * 处理办法是进出 Live2D 页面时强制整页跳转，让浏览器重新取对应 CSP。
 * 代价是两次刷新，换来的是其余路由继续维持不含 unsafe-eval 的严格策略。
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: () => import('@/components/AppLayout.vue'),
      children: [
        { path: '',                name: 'home',          component: () => import('@/views/HomeView.vue') },
        { path: 'scene-explorer', name: 'scene',         component: () => import('@/views/SceneExplorerView.vue') },
        { path: 'popular-scenes', name: 'popular-scenes', component: () => import('@/views/PopularSceneExplorerView.vue') },
        { path: 'prompt-builder', name: 'director',      component: () => import('@/views/PromptBuilderView.vue') },
        { path: 'video-studio',  name: 'video',         component: () => import('@/views/VideoStudioView.vue') },
        { path: 'chat',           name: 'chat',          component: () => import('@/views/ChatView.vue') },
        { path: 'showcase',       name: 'showcase',      component: () => import('@/views/ShowcaseView.vue') },
        { path: 'gallery',        name: 'gallery',       component: () => import('@/views/GalleryView.vue') },
        { path: 'character',      name: 'character',     component: () => import('@/views/CharacterView.vue') },
        { path: 'style',          name: 'style',         component: () => import('@/views/StyleView.vue') },
        { path: 'lora',           name: 'lora',          component: () => import('@/views/LoraView.vue') },
        { path: 'scene-manager',  name: 'manager',       component: () => import('@/views/SceneManagerView.vue') },
        { path: 'color-script',   name: 'color-script',  component: () => import('@/views/ColorScriptView.vue') },
        { path: 'scenario',       name: 'scenario',      component: () => import('@/views/ScenarioView.vue') },
        // 兜底路由：没有它，任何拼错的地址都只渲染一个空白外壳
        { path: ':pathMatch(.*)*', name: 'not-found',    component: () => import('@/views/NotFoundView.vue') },
      ]
    },
    // 桌宠与控制面板都有独立完整布局，不套 AppLayout。
    { path: '/companion', name: 'companion', component: () => import('@/views/CompanionView.vue') },
    // 真双窗口：独立聊天窗（无 Live2D，严格 CSP，不进 LIVE2D_PATHS）
    { path: '/companion-chat', name: 'companion-chat', component: () => import('@/views/CompanionChatView.vue') },
    { path: '/control', name: 'control', component: () => import('@/views/ControlView.vue') }
  ],
  // 路由切换回到顶部；带 hash 时定位到锚点，浏览器前进/后退时还原原位置
  scrollBehavior(to, from, savedPosition) {
    cancelPendingScrollRestore()
    if (savedPosition) {
      routeScrollMemory.delete(to.fullPath)
      return savedPosition
    }
    if (to.path === from.path && !to.hash && !from.hash) return false
    if (to.hash) return { el: to.hash, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }
    const remembered = routeScrollMemory.get(to.fullPath)
    if (remembered) {
      routeScrollMemory.delete(to.fullPath)
      scheduleScrollRestore(to.fullPath, remembered)
      return { ...remembered, behavior: 'auto' }
    }
    return { top: 0 }
  }
})

// Capture before Vue Router performs the destination scrollBehavior. This is
// intentionally separate from scrollBehavior, which runs after the old page
// may already have been moved to the top.
router.beforeEach((to, from) => {
  cancelPendingScrollRestore()
  if (from.path !== to.path) rememberRouteScroll(from.fullPath)
})

/**
 * Warm a lazy route without changing location. Used on internal-link intent.
 *
 * Live2D 路径同样预热（2026-08-30 UX 审计 P1）：进出它们确实要整页刷新
 * （CSP 需要 unsafe-eval），但刷新之后浏览器仍要重新取一遍 chunk——预热过的
 * 会命中 HTTP 缓存，整页刷新因此快一截，这正是「/chat 是全程最慢一步」的
 * 主要来源。
 *
 * 安全性：ChatView 的静态依赖链里没有 PixiJS / wl-live2d（它们是运行时按需
 * 加载的），所以模块求值不需要 eval，在严格 CSP 的文档里预热也不会抛错；
 * 真抛了也被下面的 catch 吞掉，而整页刷新后会用新文档重新加载，不受影响。
 */
export const prefetchRoute = createRoutePrefetcher(router)

router.beforeEach(async (to, from) => {
  if (['/chat', '/companion', '/companion-chat'].includes(to.path)) {
    await (await import('@/utils/localCompanions')).loadLocalCompanions()
  }
  // 初次进入（无 from）由浏览器自己请求文档，CSP 已经对路径生效
  if (!from.matched.length) return true
  if (!needsDocumentReload(from.path, to.path)) return true

  // 进 Live2D 页面换到带 unsafe-eval 的文档；离开时换回严格文档，
  // 顺带彻底释放 WebGL 上下文与 Pixi ticker
  if (useTaskCenter().activeCount.value && !(await confirmAction({ title: '这个页面需要重新载入应用', message: '为保持页面安全隔离，打开房间会重载应用。页面内批量与反推将中断，已保存的图片不受影响。可取消并等任务完成。', confirmLabel: '仍要打开' }))) return false
  approveTaskReload()
  window.location.assign(to.fullPath)
  return false
})

export default router
