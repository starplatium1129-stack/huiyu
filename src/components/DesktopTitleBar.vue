<template>
  <header v-if="visible" class="desktop-titlebar" aria-label="窗口标题栏" data-tauri-drag-region>
    <div class="titlebar-brand">
      <img class="titlebar-dot" src="/assets/favicon.svg" alt="" aria-hidden="true" />
      <span class="titlebar-name">绘遇 · HUIYU</span>
      <StudioTooltip v-if="pageTitle" :content="pageTitle">
        <span class="titlebar-page">{{ pageTitle }}</span>
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
.desktop-titlebar {
  --desktop-titlebar-text: var(--text-secondary);
  --desktop-titlebar-name: var(--text-primary);
  --desktop-titlebar-page: var(--text-secondary);
  --desktop-titlebar-hover: var(--text-primary);
  --desktop-titlebar-hover-bg: var(--bg-elevated);
  --desktop-titlebar-press-bg: var(--accent-soft);
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--desktop-chrome-height, 38px);
  padding: 0 0 0 14px;
  background: var(--bg-surface);
  box-shadow: inset 0 -1px 0 var(--border-soft);
  -webkit-app-region: drag;
  user-select: none;
  color: var(--desktop-titlebar-text);
  font-size: 12.5px;
  letter-spacing: 0.02em;
}
/* 底部渐变发丝线：与整站「克制光效」一致，取代平直白边 */
.desktop-titlebar::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent 2%, var(--accent-soft) 18%, transparent 98%);
  pointer-events: none;
}
.titlebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.titlebar-dot {
  flex: none;
  width: 22px;
  height: 22px;
}
.titlebar-name {
  color: var(--desktop-titlebar-name);
  font-weight: 600;
  letter-spacing: 0.03em;
}
.titlebar-page {
  padding-left: 10px;
  border-left: 1px solid var(--border-soft);
  color: var(--desktop-titlebar-page);
  overflow: hidden;
  text-overflow: ellipsis;
}
.titlebar-controls {
  display: flex;
  align-items: center;
  height: 100%;
  -webkit-app-region: no-drag;
}
.tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 100%;
  border: 0;
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--desktop-titlebar-text);
  cursor: default;
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
  color: var(--danger-text);
}
.tb-close:active {
  background: color-mix(in srgb, var(--danger) 18%, var(--bg-surface));
}
@media (max-width: 600px) {
  .titlebar-page { display: none; }
}
</style>

<style>
html.aics-desktop-shell {
  --desktop-chrome-height: 38px;
  height: 100%;
}
html.aics-desktop-shell .page-root { min-height: calc(100dvh - var(--desktop-chrome-height)); }
html.aics-desktop-shell body {
  height: 100%;
  overflow-y: auto;
}
html.aics-desktop-shell #app {
  height: 100%;
  display: flex;
  flex-direction: column;
}
html.aics-desktop-shell #app > .route-stage {
  flex: 1 1 auto;
  min-height: 0;
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
