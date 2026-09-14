<template>
  <div class="page-root">
    <a class="skip-link" href="#main">跳到主要内容</a>
    <AppNav />
    <RouteAtmosphere />
    <GuestGuide />
    <!-- 必须是真的 <main>：skip-link 指向这里，之前是 div，跳转链接落在一个普通容器上 -->
    <main id="main" class="page-main" tabindex="-1">
      <RouterView v-slot="{ Component, route }">
        <Transition :css="false" @enter="onEnter" @leave="onLeave">
          <!-- 作品册缓存：数百张大图的 blob URL 与解码结果常驻内存，
               切到其他页再回来不重新从 IndexedDB 读图，秒开。
               其余页面按需重建（各自 onMounted 拉最新数据）。 -->
          <KeepAlive :include="['GalleryView', 'ShowcaseView', 'PromptBuilderView', 'VideoStudioView']">
            <component :is="Component" :key="route.path" class="route-view" />
          </KeepAlive>
        </Transition>
      </RouterView>
    </main>
    <footer class="site-footer">
      <!--
        docs/ 由网关静态托管（server.js 的 /docs 路由）。此前 42 份文档在应用内
        一个入口都没有，等于写了没人看（2026-08-30 UX 审计 P1）。
        印章 ::after 是行内元素，所以链接并入同一行，印章仍收在行尾。
      -->
      <p>
        © {{ currentYear }} 绘遇 HUIYU · 让想象成形，让故事相遇
        <span class="site-footer-sep" aria-hidden="true">·</span>
        <a class="site-footer-link" href="/docs/getting-started.html" target="_blank" rel="noopener">使用指南</a>
        <span class="site-footer-sep" aria-hidden="true">·</span>
        <a class="site-footer-link" href="/docs/index.html" target="_blank" rel="noopener">文档索引</a>
      </p>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { animateMini } from 'motion'
import { onMounted, onUnmounted, onDeactivated } from 'vue'
import { prefersReducedMotion } from '@/utils/motionPreference'
import AppNav from './AppNav.vue'
import RouteAtmosphere from './visual/RouteAtmosphere.vue'
import GuestGuide from './GuestGuide.vue'

// 每个路由节点独立持有动画。进入与离开可能同时发生，若共用单个句柄，
// leave 会把新页面的 enter 停在 opacity:0，快速切页时就会出现空白舞台。
const activeAnimations = new Map<Element, {
  controls: ReturnType<typeof animateMini>
  done: () => void
  opacity: number
}>()

// done 可能在"动画自然完成"和"stop 强制完成"两条路径被触发，只执行一次
function onceDone(done: () => void) {
  let called = false
  return () => {
    if (called) return
    called = true
    done()
  }
}

// 页脚年份跟随当前年份，避免手写年份过期
const currentYear = new Date().getFullYear()

function stopActive(el: Element) {
  const active = activeAnimations.get(el)
  if (!active) return
  active.controls.stop()
  ;(el as HTMLElement).style.opacity = String(active.opacity)
  ;(el as HTMLElement).style.transform = ''
  active.done()
  activeAnimations.delete(el)
}

function trackAnimation(el: Element, controls: ReturnType<typeof animateMini>, done: () => void, opacity: number) {
  activeAnimations.set(el, { controls, done, opacity })
  controls.then(() => {
    done()
    if (activeAnimations.get(el)?.controls === controls) activeAnimations.delete(el)
  })
}

function onEnter(el: Element, done: () => void) {
  stopActive(el)
  const doneOnce = onceDone(done)
  const reduced = prefersReducedMotion()
  const controls = reduced
    ? animateMini(el as HTMLElement, { opacity: [0, 1] }, { duration: 0 })
    : animateMini(
        el as HTMLElement,
        { opacity: [0, 1], transform: ['translateY(10px) scale(.994)', 'translateY(0) scale(1)'] },
        { type: 'spring', bounce: 0, duration: 0.44 },
      )
  trackAnimation(el, controls, doneOnce, 1)
}

function onLeave(el: Element, done: () => void) {
  stopActive(el)
  const doneOnce = onceDone(done)
  const reduced = prefersReducedMotion()
  const controls = animateMini(el as HTMLElement, { opacity: 0 }, { duration: reduced ? 0 : 0.12, ease: 'easeOut' })
  trackAnimation(el, controls, doneOnce, 0)
}
const motionMedia = matchMedia('(prefers-reduced-motion: reduce)')
function settleAll() { for (const el of [...activeAnimations.keys()]) stopActive(el) }
function motionChanged() { if (prefersReducedMotion()) settleAll() }
onMounted(() => { motionMedia.addEventListener('change', motionChanged); window.addEventListener('atelier:motion-preference', motionChanged) })
onDeactivated(settleAll)
onUnmounted(() => { settleAll(); motionMedia.removeEventListener('change', motionChanged); window.removeEventListener('atelier:motion-preference', motionChanged) })
</script>

<style scoped>
.page-root {
  position: relative;
  isolation: isolate;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.page-main {
  position: relative;
  z-index: var(--z-raised);
  flex: 1;
  min-width: 0;
  display: grid;
}
.route-view {
  grid-area: 1 / 1;
  min-width: 0;
}
/* 用 skip-link 跳进来时要有可见落点，但鼠标点击不该出现描边 */
.page-main:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.site-footer {
  position: relative;
  z-index: var(--z-raised);
  padding: var(--s-4) var(--s-6);
  text-align: center;
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  border-top: 1px solid var(--border-soft);
  background: color-mix(in srgb, var(--bg-deep) 55%, transparent);
}
/* 页脚文档入口：docs/ 静态托管目录的应用内唯一入口 */
.site-footer-sep { margin: 0 var(--s-2); color: var(--text-disabled); }
.site-footer-link {
  color: var(--text-secondary);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.site-footer-link:hover { color: var(--accent); }
.site-footer-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r-sm); }
/* 朱印印章：页脚签名（色值由 --danger 派生，无硬编码） */
.site-footer::after {
  content: "綾季";
  display: inline-grid;
  place-items: center;
  width: 2.4rem;
  height: 2.4rem;
  margin-left: var(--s-3);
  border: 2px solid color-mix(in srgb, var(--danger) 42%, transparent);
  border-radius: var(--r-sm);
  /* 审计修复：朱印字原为 55% 透明的 danger（2.09:1 不可读），改用文字专用令牌 */
  color: var(--danger-text);
  font: 700 var(--fs-body-sm) var(--font-serif);
  letter-spacing: 0.06em;
  transform: rotate(-8deg);
  vertical-align: middle;
}
</style>
