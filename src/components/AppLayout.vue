<template>
  <div class="page-root tw:relative tw:isolate tw:min-h-screen tw:flex tw:flex-col">
    <a class="skip-link" href="#main">跳到主要内容</a>
    <AppNav />
    <RouteAtmosphere />
    <GuestGuide />
    <!-- 必须是真的 <main>：skip-link 指向这里，之前是 div，跳转链接落在一个普通容器上 -->
    <main id="main" class="page-main tw:relative tw:z-(--z-raised) tw:flex-1 tw:min-w-0 tw:grid" tabindex="-1" :aria-busy="!!pendingPath || undefined">
      <RouterView v-slot="{ Component, route }">
        <Transition appear :css="false" @before-enter="onBeforeEnter" @enter="onEnter" @leave="onLeave" @enter-cancelled="onEnterCancelled" @leave-cancelled="onLeaveCancelled">
          <!-- 缓存页面的筛选、滚动与编辑状态；作品册停用时释放原图，
               回来后按可见范围重读，避免后台常驻整页高清资源。 -->
          <KeepAlive :include="['GalleryView', 'ShowcaseView', 'PromptBuilderView', 'VideoStudioView']">
            <component :is="Component" :key="route.path" class="route-view tw:min-w-0" :data-route-path="route.fullPath" />
          </KeepAlive>
        </Transition>
      </RouterView>
    </main>
    <footer class="site-footer tw:relative tw:z-(--z-raised) tw:text-center tw:text-body-sm tw:text-muted">
      <!--
        docs/ 由网关静态托管（server.js 的 /docs 路由）。此前 42 份文档在应用内
        一个入口都没有，等于写了没人看（2026-08-30 UX 审计 P1）。
        印章 ::after 是行内元素，所以链接并入同一行，印章仍收在行尾。
      -->
      <p>
        © {{ currentYear }} 绘遇 HUIYU · 让想象成形，让故事相遇
        <span class="site-footer-sep tw:text-disabled" aria-hidden="true">·</span>
        <a class="site-footer-link tw:text-secondary tw:underline-offset-[3px]" href="/docs/getting-started.html" target="_blank" rel="noopener">使用指南</a>
        <span class="site-footer-sep tw:text-disabled" aria-hidden="true">·</span>
        <a class="site-footer-link tw:text-secondary tw:underline-offset-[3px]" href="/docs/index.html" target="_blank" rel="noopener">文档索引</a>
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

const currentRoute = useRoute()
const { onBeforeEnter, onEnter, onLeave, onEnterCancelled, onLeaveCancelled } = useRouteTransition(() => currentRoute.path, { initialFade: true })
const { pendingPath } = useNavigationFeedback()
// 页脚年份跟随当前年份，避免手写年份过期
const currentYear = new Date().getFullYear()

</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.route-view {
  grid-area: 1 / 1;
  /* Anchor depth motion at the page top, not halfway down a long document. */
  transform-origin: 50% 0;
}
/* 用 skip-link 跳进来时要有可见落点，但鼠标点击不该出现描边 */
.page-main:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.site-footer {
  padding: var(--s-4) var(--s-6);
  border-top: 1px solid var(--border-soft);
  background: color-mix(in srgb, var(--bg-deep) 55%, transparent);
}
/* 页脚文档入口：docs/ 静态托管目录的应用内唯一入口 */
.site-footer-sep { margin: 0 var(--s-2); }
.site-footer-link { text-decoration: underline; }
.site-footer-link:hover { @apply tw:text-accent; }
.site-footer-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; @apply tw:rounded-sm; }
/* 朱印印章：页脚签名（色值由 --danger 派生，无硬编码） */
.site-footer::after {
  content: "綾季";
  @apply tw:inline-grid;
  place-items: center;
  @apply tw:w-[2.4rem] tw:h-[2.4rem] tw:ml-s-3;
  border: 2px solid color-mix(in srgb, var(--danger) 42%, transparent);
  @apply tw:rounded-sm;
  /* 审计修复：朱印字原为 55% 透明的 danger（2.09:1 不可读），改用文字专用令牌 */
  @apply tw:text-danger-text;
  font: 700 var(--fs-body-sm) var(--font-serif);
  letter-spacing: 0.06em;
  transform: rotate(-8deg);
  vertical-align: middle;
}
</style>
