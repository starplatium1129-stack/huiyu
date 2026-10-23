<template>
  <div class="page-root tw:relative tw:isolate tw:min-h-screen tw:flex tw:flex-col">
    <RouterLink class="skip-link" :to="{ query: currentRoute.query, hash: '#main' }" @click="focusMain">跳到主要内容</RouterLink>
    <AppNav />
    <RouteAtmosphere />
    <GuestGuide />
    <!-- 必须是真的 <main>：skip-link 指向这里，之前是 div，跳转链接落在一个普通容器上 -->
    <main id="main" class="page-main tw:relative tw:z-(--z-raised) tw:flex-1 tw:min-w-0 tw:grid" tabindex="-1" :aria-busy="!!pendingPath || undefined">
      <RouterView v-slot="{ Component, route }">
        <Transition appear :css="false" @before-enter="onBeforeEnter" @enter="onEnter" @leave="onLeave" @enter-cancelled="onEnterCancelled" @leave-cancelled="onLeaveCancelled">
          <!-- 缓存页面的筛选、滚动与编辑状态；作品册停用时释放有缩略图的原图，
               仅为返回范围内缺少缩略图的作品保留原图预览。 -->
          <KeepAlive :include="['GalleryView', 'ShowcaseView', 'PromptBuilderView', 'VideoStudioView']">
            <component :is="Component" :key="route.name === 'qwen' || route.name === 'moss' ? route.fullPath : route.path" class="route-view tw:min-w-0" :data-route-path="route.fullPath" />
          </KeepAlive>
        </Transition>
      </RouterView>
    </main>
    <footer class="site-footer tw:relative tw:z-(--z-raised) tw:text-center tw:text-body-sm tw:text-muted">
      <!-- 页脚保留独立文档入口。 -->
      <p>
        © {{ currentYear }} 绘遇 HUIYU
        <span class="site-footer-sep tw:text-disabled" aria-hidden="true">·</span>
        <RouterLink class="site-footer-link tw:text-secondary tw:underline-offset-[3px]" to="/guide">使用指南</RouterLink>
        <span class="site-footer-sep tw:text-disabled" aria-hidden="true">·</span>
        <a class="site-footer-link tw:text-secondary tw:underline-offset-[3px]" :href="documentationUrl || undefined" :aria-disabled="!documentationUrl || undefined" target="_blank" rel="noopener">文档索引</a>
      </p>
    </footer>
  </div>
</template>

<script setup lang="ts">
import '@/assets/css/workspace-layout.css'
import { useRouteTransition } from '@/composables/useRouteTransition'
import { useNavigationFeedback } from '@/composables/useNavigationFeedback'
import AppNav from './AppNav.vue'
import RouteAtmosphere from './visual/RouteAtmosphere.vue'
import GuestGuide from './GuestGuide.vue'
import { useRoute } from 'vue-router'
import { computed } from 'vue'
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'

const currentRoute = useRoute()
const documentationUrl = computed(() => resolveRuntimeUrl('/docs/index.html'))
function focusMain() { document.getElementById('main')?.focus({ preventScroll: true }) }
const { onBeforeEnter, onEnter, onLeave, onEnterCancelled, onLeaveCancelled } = useRouteTransition(() => currentRoute.path)
const { pendingPath } = useNavigationFeedback()
// 页脚年份跟随当前年份，避免手写年份过期
const currentYear = new Date().getFullYear()

</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.page-root { --app-navigation-visible-height:var(--app-navigation-height,80px); }
.page-root:has(> .nav[data-scroll-hidden='true']) { --app-navigation-visible-height:0px; }
.route-view {
  grid-area: 1 / 1;
  /* Anchor depth motion at the page top, not halfway down a long document. */
  transform-origin: 50% 0;
}
/* Leaving routes are inert until their fade completes. Keep them visible but
   out of grid sizing so two long pages do not repeatedly size the same row. */
.route-view[inert] { position: absolute; inset: 0 0 auto; }
/* 用 skip-link 跳进来时要有可见落点，但鼠标点击不该出现描边 */
.page-main:focus-visible {
  outline: none;
  box-shadow: none;
}
.page-main:focus-visible::before { content:""; position:absolute; inset:0 0 auto; height:2px; background:var(--focus-color); z-index:var(--z-raised); pointer-events:none; }
.site-footer {
  @apply tw:flex tw:items-center tw:justify-center tw:gap-s-3 tw:shrink-0;
  padding: var(--s-3) var(--workspace-gutter);
  border-top: 1px solid var(--border-soft);
  background: var(--bg-base);
}
.site-footer p { margin: 0; }
/* 指南在应用内阅读，详细文档保留独立入口。 */
.site-footer-sep { margin: 0 var(--s-2); }
.site-footer-link { text-decoration: underline; }
.site-footer-link:hover { @apply tw:text-primary; }
.site-footer-link[aria-disabled="true"] { color: var(--text-disabled); text-decoration: none; }
.site-footer-link:focus-visible { outline: none; box-shadow: var(--focus-shadow); @apply tw:rounded-sm; }
</style>
