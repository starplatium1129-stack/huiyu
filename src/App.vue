<template>
  <TooltipProvider :delay-duration="400">
    <DesktopTitleBar v-if="atelierWindow && !isCompanion" />
    <RuntimeConnectionNotice />
    <RouteRecoveryBanner />
    <DesktopUpdateBanner v-if="desktop && !isCompanion" />
    <div class="route-stage tw:relative tw:grid tw:[align-items:start] tw:min-w-0">
      <p v-if="atelierWindow && !route.matched.length && !routeRecovery" class="startup-route-status" role="status">正在打开画室…</p>
      <RouterView v-slot="{ Component }">
        <Transition appear :css="false" @before-enter="layoutMotion.onBeforeEnter" @enter="layoutMotion.onEnter" @leave="layoutMotion.onLeave" @enter-cancelled="layoutMotion.onEnterCancelled">
          <KeepAlive include="AppLayout"><component :is="Component" v-if="!startupProfilePending || route.matched[0]?.path === '/'" :key="route.matched[0]?.path" :data-route-path="route.fullPath" /></KeepAlive>
        </Transition>
      </RouterView>
    </div>
    <AppInteractionLayer v-if="!isCompanion" />
    <AppToast v-if="!isCompanion" :placement="route.path === '/prompt-builder' ? 'bottom-left' : 'bottom-right'" />
    <ConfirmDialog v-if="confirmation.visible" />
    <MediaPacksOnboardingModal v-if="!isCompanion && mediaOnboardingMounted" />
    <AppearanceHost />
    <TaskCenter v-if="!isCompanion" />
    <GlobalSearch v-if="!isCompanion" />
  </TooltipProvider>
</template>

<script setup lang="ts">
import '@/assets/css/control-feedback.css'
import { getDesktopCapabilities, onDesktopNavigate } from '@/platform/desktop/capabilities'
import { getDesktopWindowRole, onDesktopRuntime } from '@/platform/desktop/runtime'

import { computed, defineAsyncComponent, onErrorCaptured, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TooltipProvider } from 'reka-ui'
import AppInteractionLayer from '@/components/AppInteractionLayer.vue'
import AppToast from '@/components/AppToast.vue'
import { resolveConfirm, useConfirmState } from '@/composables/useConfirm'
import { startupProfilePending } from '@/platform/startupProfile'
import AppearanceHost from '@/components/AppearanceHost.vue'
import TaskCenter from '@/components/tasks/TaskCenter.vue'
import GlobalSearch from '@/components/GlobalSearchHost.vue'
import DesktopTitleBar from '@/components/DesktopTitleBar.vue'
import RuntimeConnectionNotice from '@/components/RuntimeConnectionNotice.vue'
import RouteRecoveryBanner from '@/components/RouteRecoveryBanner.vue'
import { useRouteTransition } from '@/composables/useRouteTransition'
import { useCharacterArtRefresh } from '@/composables/useCharacterArtRefresh'
import { routeRecovery } from '@/composables/useRouteRecovery'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

const route = useRoute()
const desktop = Boolean(getDesktopCapabilities())
const desktopWindowRole = desktop ? getDesktopWindowRole() : undefined
const localStudioHost = isLocalStudioHost()
const mediaOnboardingMounted = ref(false)
const atelierWindow = desktopWindowRole === 'atelier'
const confirmation = useConfirmState()
const ConfirmDialog = defineAsyncComponent(() => import('@/components/ConfirmDialog.vue').catch(error => {
  resolveConfirm(confirmation.value.requestId, false)
  throw error
}))
const DesktopUpdateBanner = defineAsyncComponent(() => import('@/components/DesktopUpdateBanner.vue'))
const MediaPacksOnboardingModal = defineAsyncComponent(() => import('@/components/MediaPacksOnboardingModal.vue'))
useCharacterArtRefresh()
const router = useRouter()
onErrorCaptured((error, instance, info) => {
  if (info !== 'async component loader' && info !== 'https://vuejs.org/error-reference/#runtime-13') return
  console.error('异步组件加载失败', error)
  // A cached page can finish a rejected import after another route is active.
  // Keep its failure from replacing recovery for the page the user now sees.
  for (let source = instance?.$ ?? null; source; source = source.parent) {
    if (source.isDeactivated) return false
  }
  if (routeRecovery.value?.kind !== 'route') routeRecovery.value = { kind: 'panel', target: route.fullPath }
  return false
})
const layoutMotion = useRouteTransition()
let detachDesktopNavigation: (() => void) | undefined
let detachMediaBootstrap: (() => void) | undefined
const onOpenMediaOnboarding = () => {
  if (localStudioHost && !isCompanion.value) mediaOnboardingMounted.value = true
}
onMounted(() => {
  if (getDesktopCapabilities()) detachDesktopNavigation = onDesktopNavigate(path => { void router.push(path) })
  if (localStudioHost && !isCompanion.value) {
    window.addEventListener('huiyu:media-packs-onboarding', onOpenMediaOnboarding)
    const check = async () => {
      const mod = await import('@/composables/useMediaPacks')
      if (isCompanion.value) return
      await mod.checkMediaPacksOnboarding()
      if (mod.onboardingVisibleState.value) onOpenMediaOnboarding()
    }
    if (desktop) {
      detachMediaBootstrap = onDesktopRuntime(state => {
        if (state.connection === 'ready') void check()
      })
    } else void check()
  }
})
onUnmounted(() => {
  detachDesktopNavigation?.()
  detachMediaBootstrap?.()
  window.removeEventListener('huiyu:media-packs-onboarding', onOpenMediaOnboarding)
})
const isCompanion = computed(() => desktopWindowRole === 'companion' || desktopWindowRole === 'companion-chat'
  || ['/companion', '/companion-chat', '/companion.html'].includes(route.path.replace(/\/+$/, '')))

let stopThumbnailWarmup: (() => void) | undefined

onMounted(() => {
  // Archive preparation belongs to an active gallery, not a cold home visit.
  watch(() => route.path, async path => {
    if (path !== '/gallery') { stopThumbnailWarmup?.(); stopThumbnailWarmup = undefined; return }
    const { startGalleryThumbnailWarmup } = await import('@/utils/galleryThumbnailWarmup')
    if (route.path === '/gallery' && !stopThumbnailWarmup) stopThumbnailWarmup = startGalleryThumbnailWarmup()
  }, { immediate:true })
  // bfcache（Chromium 后退/前进缓存）恢复时，Vue Router 内部路由可能与地址栏
  // 不同步：组件不重挂载、onMounted 深链不执行，导致「点击场景/卡片后页面
  // 还是上一个场景的提示词」。恢复时用地址栏重建路由，触发正确的组件挂载。
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return
    const address = import.meta.env.MODE === 'desktop' ? window.location.hash.slice(1) || '/'
      : window.location.pathname + window.location.search + window.location.hash
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
.startup-route-status { margin:var(--s-6) var(--workspace-gutter); color:var(--text-secondary); }
.route-stage > * {
  grid-area: 1 / 1;
  min-width: 0;
}
</style>
