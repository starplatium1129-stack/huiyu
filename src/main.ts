import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { installRouteRecovery } from './composables/useRouteRecovery'
import { installNavigationFeedback } from './composables/useNavigationFeedback'
import { initializeTheme } from './composables/useTheme'
import { initializeDesktopPreferences, installDesktopInteraction } from './composables/useDesktopInteraction'
import { installFluidGlass } from './utils/fluidGlass'
import { installDesktopZoom } from './composables/useDesktopZoom'
// 字体声明移入独立异步 chunk（2026-08-28 审计 P1-7）：315 条 @font-face
// 不再打进入口 CSS（453KB → ~85KB），首帧用 fallback 渲染、swap 无闪换。
// 不 await —— 首帧即发起加载，不阻塞入口解析。
import('./assets/fonts')
// 全局样式只留真正跨路由共用的三份。
// director.css(91.6KB)与 chat.css(18.6KB)已移到各自视图内 import ——
// 它们占了 139KB 全局包的 79%，却只服务 /prompt-builder 与 /chat。
// Vite 的 cssCodeSplit 会把它们切成路由块，随懒加载组件一起取。
import './assets/css/design-system.css'
import './assets/css/scene-card.css'
import './assets/css/viewer.css'
import './assets/css/mood.css'
import './assets/css/light-theme.css'
import './assets/css/fluid-surfaces.css'
import './assets/css/fluid-workspaces.css'
import './assets/css/fluid-glass.css'

initializeTheme()
initializeDesktopPreferences()
installRouteRecovery(router)
const stopNavigationFeedback = installNavigationFeedback(router)

createApp(App).use(createPinia()).use(router).mount('#app')
const stopDesktopInteraction = installDesktopInteraction(router)
const stopFluidGlass = installFluidGlass()
const stopDesktopZoom = installDesktopZoom()
if (import.meta.hot) import.meta.hot.dispose(() => { stopDesktopInteraction(); stopFluidGlass(); stopDesktopZoom(); stopNavigationFeedback() })
