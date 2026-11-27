<template>
  <div class="page-root tw:relative tw:isolate tw:min-h-screen tw:flex tw:flex-col">
    <RouterLink class="skip-link" :to="{ query: currentRoute.query, hash: '#main' }" @click="focusMain">跳到主要内容</RouterLink>
    <AppNav />
    <RouteAtmosphere />
    <GuestGuide v-if="!startupProfilePending" />
    <!-- 必须是真的 <main>：skip-link 指向这里，之前是 div，跳转链接落在一个普通容器上 -->
    <main id="main" class="page-main tw:relative tw:z-(--z-raised) tw:flex-1 tw:min-w-0 tw:grid" tabindex="-1" :aria-busy="startupProfilePending || !!pendingPath || undefined">
      <p v-if="startupProfilePending" class="startup-profile-status" role="status">正在连接本机资料…</p>
      <RouterView v-else v-slot="{ Component, route }">
        <Transition appear :css="false" @before-enter="onBeforeEnter" @enter="onEnter" @leave="onLeave" @enter-cancelled="onEnterCancelled">
          <!-- 缓存页面的筛选、滚动与编辑状态；作品册停用时释放有缩略图的原图，
               仅为返回范围内缺少缩略图的作品保留原图预览。 -->
          <KeepAlive :include="['SceneExplorerView', 'PopularSceneExplorerView', 'GalleryView', 'ShowcaseView', 'PromptBuilderView', 'VideoStudioView']" :max="3">
            <component :is="Component" :key="route.path" class="route-view tw:min-w-0" :data-route-path="route.fullPath" />
          </KeepAlive>
        </Transition>
      </RouterView>
    </main>
    <footer class="site-footer tw:relative tw:z-(--z-raised) tw:text-center tw:text-body-sm tw:text-muted">
      <!-- 全站唯一一枚画册奥付朱印（DESIGN.md:664-665） -->
      <span class="site-footer-seal" aria-hidden="true">
        <svg class="site-footer-seal-svg" viewBox="0 0 28 28" width="24" height="24" fill="none" focusable="false">
          <path
            d="M4.4 3.2 Q14 2.5 23.6 3.3 Q25.1 3.5 25 5 Q25.5 14 24.9 23.1 Q24.8 24.8 23.2 24.9 Q14 25.5 4.8 24.9 Q3.1 24.8 3.2 23.1 Q2.6 14 3.3 4.8 Q3.4 3.3 4.4 3.2 Z"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <rect x="5.2" y="5.2" width="17.6" height="17.6" rx="2" stroke="currentColor" stroke-width="0.7" opacity="0.48" />
          <text x="14" y="13.2" text-anchor="middle" fill="currentColor" font-size="8.6" font-weight="700" class="seal-kanji">綾</text>
          <text x="14" y="21.7" text-anchor="middle" fill="currentColor" font-size="8.6" font-weight="700" class="seal-kanji">季</text>
        </svg>
      </span>
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
import '@/assets/css/fluid-workspaces.css'
import { useRouteTransition } from '@/composables/useRouteTransition'
import { useNavigationFeedback } from '@/composables/useNavigationFeedback'
import AppNav from './AppNav.vue'
import RouteAtmosphere from './visual/RouteAtmosphere.vue'
import GuestGuide from './GuestGuide.vue'
import { useRoute } from 'vue-router'
import { computed } from 'vue'
import { resolveRuntimeUrl } from '@/platform/runtimeUrl'
import { startupProfilePending } from '@/platform/startupProfile'

const currentRoute = useRoute()
const documentationUrl = computed(() => resolveRuntimeUrl('/docs/index.html'))
function focusMain() { document.getElementById('main')?.focus({ preventScroll: true }) }
const { onBeforeEnter, onEnter, onLeave, onEnterCancelled } = useRouteTransition()
const { pendingPath } = useNavigationFeedback()
// 页脚年份跟随当前年份，避免手写年份过期
const currentYear = new Date().getFullYear()

</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.page-root { --app-navigation-visible-height:var(--app-navigation-height,80px); }
.page-root:has(> .nav[data-scroll-hidden='true']) { --app-navigation-visible-height:0px; }
.startup-profile-status { align-self:start; margin:var(--s-6) var(--workspace-gutter); color:var(--text-secondary); }
.route-view {
  grid-area: 1 / 1;
}
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
.site-footer-seal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  color: color-mix(in srgb, var(--danger-text) 86%, var(--editorial-gold));
  transform: rotate(-4deg);
  user-select: none;
}
.site-footer-seal-svg {
  display: block;
  width: 24px;
  height: 24px;
}
.seal-kanji {
  font-family: var(--font-serif-jp);
}
:root[data-theme-style="terraria"] .site-footer-seal {
  display: none;
}
@media (forced-colors: active) {
  .site-footer-seal { color: CanvasText; }
}
/* 指南在应用内阅读，详细文档保留独立入口。 */
.site-footer-sep { margin: 0 var(--s-2); }
.site-footer-link { text-decoration: underline; }
.site-footer-link:hover { @apply tw:text-primary; }
.site-footer-link[aria-disabled="true"] { color: var(--text-disabled); text-decoration: none; }
.site-footer-link:focus-visible { outline: none; box-shadow: var(--focus-shadow); @apply tw:rounded-sm; }
</style>
