import { startArtworkSession, stopArtworkSession } from './storage/artworkSession'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { initializePlatform, isDesktopHost } from './platform/initializePlatform'
import { setStartupProfile } from './platform/startupProfile'
import { installRouteRecovery } from './composables/useRouteRecovery'
import { installNavigationFeedback } from './composables/useNavigationFeedback'
import { initializeTheme } from './composables/useTheme'
import { initializeDesktopPreferences, installDesktopInteraction } from './composables/useDesktopInteraction'
import { installFluidGlass } from './utils/fluidGlass'
import { installDesktopZoom } from './composables/useDesktopZoom'
import { contentMotion, installContentMotion } from './directives/contentMotion'
// Keep the existing fonts/weights, but let the workspace paint before their
// declarations and glyph requests compete with initial modules and artwork.
// 入口只加载主题、utilities 和跨页面材质。场景卡片、色彩卡和查看器
// 样式由实际使用它们的组件/页面导入，与 director/chat 一起按路由加载。
import './assets/css/design-system.css'
import './assets/css/tailwind.css'
import './assets/css/light-theme.css'
import './assets/css/fluid-surfaces.css'
import './assets/css/fluid-glass.css'
import './assets/css/glass-material-base.css'
import './assets/css/native-controls.css'
import './assets/css/studio-scrollbars.css'
import './utils/scrollbarVisibility'
import './assets/css/studio-fields.css'
import './assets/css/desktop-layout.css'
import './assets/css/interaction-motion.css'

// Join before mounting: a new document must not start writing while another
// document holds exclusive cleanup access. Browsing still works without locks;
// mutations/cleanup keep their own fail-closed checks in that environment.
let disposed = false
let stopUi = () => {}
let stopNavigationFeedback = () => {}
let stopPlatform = () => {}
let stopFontLoad = () => {}
void (async () => {
  const appPromise = import('./App.vue')
  const routerPromise = import('./router')
  const platformReady = initializePlatform().then(platform => {
    if (disposed) platform.stop()
    else stopPlatform = platform.stop
    return platform
  })
  if (isDesktopHost()) setStartupProfile(platformReady)
  else void platformReady.catch(error => console.warn('资料初始化暂不可用', error))
  initializeTheme()
  // Resolve the actual landing route while the document lease and theme are
  // being acquired. All three must still complete before mounting a writable UI.
  const [shell] = await Promise.all([
    Promise.all([appPromise, routerPromise]).then(async ([{ default: App }, { default: router }]) => {
      if (disposed) return
      installRouteRecovery(router)
      stopNavigationFeedback = installNavigationFeedback(router)
      const app = createApp(App).directive('content-motion', contentMotion).use(createPinia()).use(router)
      // A failed initial import still mounts the recovery banner.
      await router.isReady().catch(() => {})
      return { app, router }
    }),
    initializeDesktopPreferences(),
    startArtworkSession().catch(error => console.warn('作品清理保护不可用', error)),
  ])
  if (!shell || disposed) return
  const { app, router } = shell
  app.mount('#app')
  let fontFrame = requestAnimationFrame(() => {
    fontFrame = requestAnimationFrame(() => {
      void platformReady.then(platform => { if (!disposed) return platform.afterMount() }).catch(error => console.warn('桌面辅助功能暂未就绪', error))
      const load = () => { if (!disposed) void import('./assets/fonts').catch(error => console.warn('本地字体暂未加载', error)) }
      if ('requestIdleCallback' in window) {
        const idle = window.requestIdleCallback(load, { timeout: 1000 })
        stopFontLoad = () => window.cancelIdleCallback(idle)
      } else {
        const timer = setTimeout(load, 0)
        stopFontLoad = () => clearTimeout(timer)
      }
    })
  })
  stopFontLoad = () => cancelAnimationFrame(fontFrame)
  const stopDesktopInteraction = installDesktopInteraction(router)
  const stopFluidGlass = installFluidGlass()
  const stopDesktopZoom = installDesktopZoom()
  const stopContentMotion = installContentMotion()
  stopUi = () => { stopDesktopInteraction(); stopFluidGlass(); stopDesktopZoom(); stopContentMotion() }
})().catch(error => {
  console.error('绘遇启动失败', error)
  const root = document.getElementById('app')
  // A late HMR rejection or a post-mount installer error must not replace the app.
  if (disposed || !root || root.childElementCount) return
  const recovery = document.createElement('section')
  recovery.className = 'startup-recovery'
  recovery.setAttribute('role', 'alert')
  const card = document.createElement('div')
  card.className = 'startup-recovery-card'
  const title = document.createElement('h1')
  title.textContent = '画室暂时没能打开'
  const message = document.createElement('p')
  message.textContent = '请检查连接后重新载入。'
  const reload = document.createElement('button')
  reload.type = 'button'
  reload.textContent = '重新载入'
  reload.addEventListener('click', () => window.location.reload())
  card.append(title, message, reload)
  recovery.append(card)
  root.replaceChildren(recovery)
})
if (import.meta.hot) import.meta.hot.dispose(() => {
  disposed = true
  stopUi()
  stopPlatform()
  stopNavigationFeedback()
  stopFontLoad()
  void stopArtworkSession().catch(() => {})
})
