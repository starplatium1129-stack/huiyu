import { createApp, defineAsyncComponent, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { TooltipProvider } from 'reka-ui'
import { initializePlatform } from './platform/initializePlatform'
import { setStartupProfile } from './platform/startupProfile'
import { getDesktopWindowRole } from './platform/desktop/runtime'
import { companionWindow } from './platform/desktop/capabilities'
import { initializeDesktopPreferences, installDesktopInteraction } from './composables/useDesktopInteraction'
import { initializeTheme } from './composables/useTheme'
import { resolveConfirm, useConfirmState } from './composables/useConfirm'
import { contentMotion, installContentMotion } from './directives/contentMotion'
import { startArtworkSession, stopArtworkSession } from './storage/artworkSession'
import AppearanceHost from './components/AppearanceHost.vue'
import './assets/css/design-system.css'
import './assets/css/tailwind.css'
import './assets/css/light-theme.css'
import './assets/css/native-controls.css'
import './assets/css/studio-fields.css'
import './assets/css/interaction-motion.css'

if (getDesktopWindowRole() !== 'companion') location.replace('/companion')
else void start().catch(error => {
  console.error('桌宠启动失败', error)
  const root = document.getElementById('app')
  if (!root || root.childElementCount) return
  const retry = document.createElement('button')
  retry.className = 'btn companion-startup-retry'
  retry.type = 'button'
  retry.textContent = '桌宠暂未加载，重试'
  retry.addEventListener('click', () => location.reload())
  root.replaceChildren(retry)
  const rect = retry.getBoundingClientRect()
  void companionWindow.setInteractiveRegions([{
    x: Math.max(0, Math.floor(rect.left * devicePixelRatio)),
    y: Math.max(0, Math.floor(rect.top * devicePixelRatio)),
    width: Math.ceil(rect.width * devicePixelRatio),
    height: Math.ceil(rect.height * devicePixelRatio),
  }], false).then(() => companionWindow.markReady('failed')).catch(() => {})
})

async function start() {
  const confirmation = useConfirmState()
  const ConfirmDialog = defineAsyncComponent(() => import('./components/ConfirmDialog.vue').catch(error => {
    resolveConfirm(confirmation.value.requestId, false)
    throw error
  }))
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/companion', component: () => import('./views/RoomRouteView.vue'), props: { page: 'companion', label: '桌面陪伴' } }],
  })
  const platform = initializePlatform()
  setStartupProfile(platform)
  initializeTheme()
  void initializeDesktopPreferences()

  await Promise.all([
    router.replace('/companion'),
    startArtworkSession().catch(error => console.warn('作品清理保护不可用', error)),
  ])
  const app = createApp({
    render: () => h(TooltipProvider, { delayDuration: 400 }, () => [
      h(RouterView),
      confirmation.value.visible ? h(ConfirmDialog) : null,
      h(AppearanceHost),
    ]),
  }).directive('content-motion', contentMotion).use(createPinia()).use(router)
  app.mount('#app')
  const stopInteraction = installDesktopInteraction(router)
  const stopMotion = installContentMotion()
  void platform.then(value => value.afterMount()).catch(error => console.warn('桌面辅助功能暂未就绪', error))
  import.meta.hot?.dispose(() => {
    app.unmount()
    stopInteraction()
    stopMotion()
    void stopArtworkSession().catch(() => {})
    void platform.then(value => value.stop()).catch(() => {})
  })
}
