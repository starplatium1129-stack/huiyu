<template>
  <DesktopTitleBar />
  <RouteRecoveryBanner />
  <DesktopUpdateBanner v-if="!isCompanion" />
  <div class="route-stage">
    <RouterView v-slot="{ Component }"><KeepAlive include="AppLayout"><component :is="Component" /></KeepAlive></RouterView>
  </div>
  <AppInteractionLayer v-if="!isCompanion" />
  <AppToast v-if="!isCompanion" />
  <ConfirmDialog />
  <AppearancePreferences hide-triggers />
  <TaskCenter v-if="!isCompanion" />
  <GlobalSearch v-if="!isCompanion" />
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { kvInit, kvGet, kvSet } from '@/composables/useKVStore'
import { imgGet } from '@/composables/useImageStore'
import { blobThumbDataUrl, thumbKey } from '@/utils/imageThumb'
import AppInteractionLayer from '@/components/AppInteractionLayer.vue'
import AppToast from '@/components/AppToast.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import AppearancePreferences from '@/components/AppearancePreferences.vue'
import TaskCenter from '@/components/tasks/TaskCenter.vue'
import GlobalSearch from '@/components/GlobalSearchHost.vue'
import DesktopTitleBar from '@/components/DesktopTitleBar.vue'
import RouteRecoveryBanner from '@/components/RouteRecoveryBanner.vue'
import DesktopUpdateBanner from '@/components/DesktopUpdateBanner.vue'
import { ARTWORK_HISTORY_KV_KEY } from '@/utils/storageKeys'
import { attachDesktopWorkspace } from '@/composables/useDesktopWorkspace'

// 键名统一出处：src/utils/storageKeys.ts
const HISTORY_KEY = ARTWORK_HISTORY_KV_KEY
const route = useRoute()
const router = useRouter()
let detachDesktopWorkspace: (() => void) | undefined
onMounted(() => {
  if (window.companionDesktop && !location.pathname.startsWith('/companion')) {
    detachDesktopWorkspace = attachDesktopWorkspace(router)
  }
})
onUnmounted(() => detachDesktopWorkspace?.())
const isCompanion = computed(() => route.path === '/companion' || route.path === '/companion-chat')

interface ThumbWarmEntry { image_id?: string }

let warmStopped = false
let warmHandle = 0

/** 后台按空闲时间给历史图库补缩略图，首次进作品册就有缓存 */
async function warmGalleryThumbs() {
  try { await kvInit() } catch { return }
  let list: ThumbWarmEntry[] = []
  try {
    const raw = await kvGet(HISTORY_KEY)
    list = (Array.isArray(raw) ? raw : []).filter(
      (r): r is ThumbWarmEntry => !!r && typeof r === 'object'
        && typeof (r as ThumbWarmEntry).image_id === 'string',
    )
  } catch { return }
  let index = 0
  const step = async () => {
    if (warmStopped || index >= list.length) return
    const imageId = (list[index++].image_id as string)
    try {
      const cached = await kvGet(thumbKey(imageId))
      if (!(typeof cached === 'string' && cached.startsWith('data:image/'))) {
        const blob = await imgGet(imageId)
        if (blob) {
          const dataUrl = await blobThumbDataUrl(blob)
          if (dataUrl) await kvSet(thumbKey(imageId), dataUrl)
        }
      }
    } catch { /* 单张失败跳过，缩略图只是缓存 */ }
    scheduleNext()
  }
  const scheduleNext = () => {
    if (warmStopped) return
    if (typeof window.requestIdleCallback === 'function') {
      warmHandle = window.requestIdleCallback(() => { void step() }, { timeout: 4000 }) as unknown as number
    } else {
      warmHandle = window.setTimeout(() => { void step() }, 120) as unknown as number
    }
  }
  scheduleNext()
}

onMounted(() => {
  if (!isCompanion.value) void warmGalleryThumbs()
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
onUnmounted(() => {
  warmStopped = true
  if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(warmHandle)
  else window.clearTimeout(warmHandle)
})
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
