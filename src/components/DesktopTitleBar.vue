<template>
  <header v-if="visible" class="desktop-titlebar" aria-label="窗口标题栏" data-tauri-drag-region>
    <div class="titlebar-brand tw:flex tw:items-center tw:gap-[10px] tw:min-w-0 tw:overflow-hidden tw:whitespace-nowrap">
      <img class="titlebar-dot tw:w-[22px] tw:h-[22px]" src="/assets/favicon.svg" alt="" aria-hidden="true" />
      <span class="titlebar-name tw:font-semibold">绘遇 · HUIYU</span>
      <StudioTooltip v-if="pageTitle" :content="pageTitle">
        <span class="titlebar-page tw:pl-[10px] tw:overflow-hidden tw:text-ellipsis">{{ pageTitle }}</span>
      </StudioTooltip>
    </div>
    <div class="titlebar-controls" data-tauri-drag-region="false">
      <StudioTooltip content="最小化">
        <button class="tb-btn" type="button" aria-label="最小化" @click="bridge?.minimizeWindow()">
          <!-- 审计修复(2026-08-28)：原为 <rect fill="currentColor"> 实心块，违反
               「图标一律手绘线条、严禁实心填充」红线。改为描边横线，与相邻
               最大化/关闭两个控件同为 stroke 1.3 的线宽，视觉上一家。 -->
          <svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M1.5 6h9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
        </button>
      </StudioTooltip>
      <StudioTooltip :content="maximized ? '还原' : '最大化'">
        <button class="tb-btn" type="button" :aria-label="maximized ? '还原' : '最大化'" @click="bridge?.toggleMaximizeWindow()">
          <svg v-if="!maximized" viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
          <svg v-else viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5v-2h7v7h-2M1.5 4.5v6h6v-6z" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
        </button>
      </StudioTooltip>
      <StudioTooltip content="关闭">
        <button class="tb-btn tb-close" type="button" aria-label="关闭" @click="bridge?.closeWindow()">
          <svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
      </StudioTooltip>
    </div>
  </header>
</template>

<script setup lang="ts">
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { getDesktopWindowRole } from '@/platform/desktop/runtime'

import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import StudioTooltip from '@/components/ui/StudioTooltip.vue'

const bridge = getDesktopCapabilities()
const route = useRoute()
const maximized = ref(false)
const pageTitle = computed(() => {
  const metaTitle = route.meta?.title
  if (typeof metaTitle === 'string' && metaTitle.trim()) return metaTitle.trim()
  return ''
})
const visible = computed(() => Boolean(bridge) && route.path !== '/companion' && route.path !== '/companion-chat')
let maximizedSub: number | null = null
let disposed = false
let receivedWindowEvent = false

onMounted(async () => {
  // 挂载早期 route.path 可能尚未就绪，用 location.pathname 硬守卫桌宠表面
  if (!bridge || getDesktopWindowRole() === 'companion' || getDesktopWindowRole() === 'companion-chat') return
  document.documentElement.classList.add('aics-desktop-shell')
  maximizedSub = bridge.onMaximizedChanged(value => {
    receivedWindowEvent = true
    maximized.value = value
  })
  try {
    const state = await bridge.getWindowState()
    if (!disposed && !receivedWindowEvent) maximized.value = state.maximized
  } catch { /* 窗口状态查询失败时保持默认 */ }
})
onUnmounted(() => {
  disposed = true
  if (bridge && maximizedSub !== null) bridge.offMaximizedChanged(maximizedSub)
  document.documentElement.classList.remove('aics-desktop-shell')
})
</script>

<style scoped>
@reference "../assets/css/tailwind.css";
.desktop-titlebar {
  --desktop-titlebar-text: var(--text-secondary);
  --desktop-titlebar-name: var(--text-primary);
  --desktop-titlebar-page: var(--text-secondary);
  --desktop-titlebar-hover: var(--text-primary);
  --desktop-titlebar-hover-bg: var(--bg-elevated);
  --desktop-titlebar-press-bg: var(--accent-soft);
  @apply tw:relative;
  flex: none;
  @apply tw:flex tw:items-center tw:justify-between;
  height: var(--desktop-chrome-height, 38px);
  padding: 0 0 0 14px;
  background: var(--nav-bg);
  box-shadow: inset 0 -1px 0 var(--border-soft);
  -webkit-app-region: drag;
  @apply tw:select-none;
  color: var(--desktop-titlebar-text);
  font-size: 12.5px;
  letter-spacing: 0.02em;
}
/* 底部渐变发丝线：与整站「克制光效」一致，取代平直白边 */
.desktop-titlebar::after {
  content: "";
  @apply tw:absolute tw:left-0 tw:right-0 tw:bottom-0 tw:h-[1px];
  background: linear-gradient(90deg, var(--accent) 0, var(--accent-soft) 18%, transparent 60%);
  @apply tw:pointer-events-none;
}
.titlebar-dot {
  flex: none;
}
.titlebar-name {
  color: var(--desktop-titlebar-name);
  letter-spacing: 0.03em;
}
.titlebar-page {
  border-left: 1px solid var(--border-soft);
  color: var(--desktop-titlebar-page);
}
.titlebar-controls {
  @apply tw:flex tw:items-center tw:h-full;
  -webkit-app-region: no-drag;
}
.tb-btn {
  @apply tw:inline-flex tw:items-center tw:justify-center tw:w-[46px] tw:h-full;
  border: 0;
  @apply tw:m-0 tw:p-0;
  background: transparent;
  color: var(--desktop-titlebar-text);
  @apply tw:cursor-default;
}
.tb-btn:hover {
  background: var(--desktop-titlebar-hover-bg);
  color: var(--desktop-titlebar-hover);
}
.tb-btn:active {
  background: var(--desktop-titlebar-press-bg);
}
.tb-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.tb-close:hover {
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-surface));
  @apply tw:text-danger-text;
}
.tb-close:active {
  background: color-mix(in srgb, var(--danger) 18%, var(--bg-surface));
}
@media (max-width: 600px) {
  .titlebar-page { @apply tw:hidden; }
}
</style>

<style>
@reference "../assets/css/tailwind.css";
html.aics-desktop-shell {
  --desktop-chrome-height: 38px;
  @apply tw:h-full;
}
html.aics-desktop-shell .page-root { min-height: calc(100dvh - var(--desktop-chrome-height)); }
html.aics-desktop-shell body {
  @apply tw:h-full;
  /* Keep the document as the scroll owner. When a modal locks html, auto would
     turn this 100%-high body into a new scroller and clamp window.scrollY to 0. */
  @apply tw:overflow-y-visible;
}
html.aics-desktop-shell #app {
  @apply tw:h-full tw:flex tw:flex-col;
}
html.aics-desktop-shell #app > .route-stage {
  flex: 1 1 auto;
  @apply tw:min-h-0;
}
/* 桌面壳下 skip-link 的包含块在标题栏下方，translateY(-140%) 只上移 59px，
   底部仍会露出标题栏上方（实测 0-33px 可见）。隐藏态改 clip-path 完全裁剪
   （保持可聚焦，visibility:hidden 会移出 Tab 序）；聚焦态显示在标题栏正下方。 */
html.aics-desktop-shell .skip-link {
  top: calc(var(--s-3) + var(--desktop-chrome-height));
  clip-path: inset(0 0 100% 0);
  transform: none;
}
html.aics-desktop-shell .skip-link:focus,
html.aics-desktop-shell .skip-link:focus-visible {
  clip-path: none;
  transform: none;
}
</style>
