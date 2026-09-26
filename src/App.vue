<template>
  <DesktopTitleBar />
  <RuntimeConnectionNotice />
  <RouteRecoveryBanner />
  <DesktopUpdateBanner v-if="!isCompanion" />
  <div class="route-stage">
    <RouterView v-slot="{ Component }">
      <Transition appear :css="false" @enter="enterLayout" @leave="leaveLayout" @enter-cancelled="layoutMotion.onEnterCancelled">
        <KeepAlive include="AppLayout"><component :is="Component" :data-route-path="route.fullPath" /></KeepAlive>
      </Transition>
    </RouterView>
  </div>
  <AppInteractionLayer v-if="!isCompanion" />
  <AppToast v-if="!isCompanion" />
  <ConfirmDialog />
  <AppearancePreferences hide-triggers />
  <TaskCenter v-if="!isCompanion" />
  <GlobalSearch v-if="!isCompanion" />
</template>

<script setup lang="ts">
import { getDesktopCapabilities, onDesktopNavigate } from '@/platform/desktop/capabilities'
import { getDesktopWindowRole } from '@/platform/desktop/runtime'

import { computed, defineAsyncComponent, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { startGalleryThumbnailWarmup } from '@/utils/galleryThumbnailWarmup'
import AppInteractionLayer from '@/components/AppInteractionLayer.vue'
import AppToast from '@/components/AppToast.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
const AppearancePreferences = defineAsyncComponent(() => import('@/components/AppearancePreferences.vue'))
import TaskCenter from '@/components/tasks/TaskCenter.vue'
import GlobalSearch from '@/components/GlobalSearchHost.vue'
import DesktopTitleBar from '@/components/DesktopTitleBar.vue'
import RuntimeConnectionNotice from '@/components/RuntimeConnectionNotice.vue'
import RouteRecoveryBanner from '@/components/RouteRecoveryBanner.vue'
import DesktopUpdateBanner from '@/components/DesktopUpdateBanner.vue'
import { attachDesktopWorkspace } from '@/composables/useDesktopWorkspace'
import { useRouteTransition } from '@/composables/useRouteTransition'

const route = useRoute()
const router = useRouter()
const layoutMotion = useRouteTransition(undefined, { initialFade: true })
function enterLayout(element: Element, done: () => void) {
  // AppLayout already animates its inner route. Standalone windows fade only;
  // translating their root would move native-overlay anchors and fixed controls.
  if (element.classList.contains('page-root')) done()
  else layoutMotion.onEnter(element, done)
}
function leaveLayout(element: Element, done: () => void) { layoutMotion.onEnterCancelled(element); done() }
let detachDesktopWorkspace: (() => void) | undefined
let detachDesktopNavigation: (() => void) | undefined
onMounted(() => {
  if (getDesktopCapabilities()) detachDesktopNavigation = onDesktopNavigate(path => { void router.push(path) })
  if (getDesktopCapabilities() && getDesktopWindowRole() === 'atelier') {
    detachDesktopWorkspace = attachDesktopWorkspace(router)
  }
})
onUnmounted(() => { detachDesktopWorkspace?.(); detachDesktopNavigation?.() })
const isCompanion = computed(() => route.path === '/companion' || route.path === '/companion-chat')

let stopThumbnailWarmup: (() => void) | undefined

onMounted(() => {
  if (!isCompanion.value) stopThumbnailWarmup = startGalleryThumbnailWarmup()
  // bfcache（Chromium 后退/前进缓存）恢复时，Vue Router 内部路由可能与地址栏
  // 不同步：组件不重挂载、onMounted 深链不执行，导致「点击场景/卡片后页面
  // 还是上一个场景的提示词」。恢复时用地址栏重建路由，触发正确的组件挂载。
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return
    const address = window.location.pathname + window.location.search + window.location.hash
    if (router.currentRoute.value.fullPath !== address) {
      void router.replace(address)
    }
  }
  window.addEventListener('pageshow', onPageShow)
  onUnmounted(() => {
    window.removeEventListener('pageshow', onPageShow)
  })
})
onUnmounted(() => stopThumbnailWarmup?.())
</script>

<style>
.route-stage {
  display: grid;
  align-items: start;
  min-width: 0;
}
.route-stage > * {
  grid-area: 1 / 1;
  min-width: 0;
}
</style>
