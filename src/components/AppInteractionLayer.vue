<template>
  <div class="route-loader" :class="{ active: loading }" aria-hidden="true"><i></i></div>
  <span class="sr-only" role="status" aria-label="页面加载状态" aria-live="polite" aria-atomic="true">{{ loading ? '正在打开页面…' : '' }}</span>
</template>
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { prefetchRoute, prefetchRouteResources } from '@/router'
import { announceNavigationIntent, useNavigationFeedback } from '@/composables/useNavigationFeedback'
import { playInterfaceTone } from '@/composables/useInterfaceFeedback'

const { loading } = useNavigationFeedback()
let hoverTimer = 0
type Connection = { saveData?: boolean; effectiveType?: string }

function intentLink(event: Event): HTMLAnchorElement | null {
  const el = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
  if (!el || el.target === '_blank' || el.hasAttribute('download')) return null
  const url = new URL(el.href, location.href)
  const destination = `${url.pathname}${url.search}${url.hash}`
  const current = `${location.pathname}${location.search}${location.hash}`
  if (url.origin !== location.origin || destination === current) return null
  return el
}
function cancelHover() { clearTimeout(hoverTimer) }
function routeDestination(el: HTMLAnchorElement): string {
  const url = new URL(el.href, location.href)
  return `${url.pathname}${url.search}${url.hash}`
}
function canSpeculate() {
  const connection = (navigator as Navigator & { connection?: Connection }).connection
  return !connection?.saveData && !/^(slow-)?2g$/.test(connection?.effectiveType ?? '')
}
function prefetch(event: Event) {
  const el = intentLink(event)
  if (!el) return
  if (event.type === 'pointerdown') {
    const destination = routeDestination(el)
    announceNavigationIntent(destination)
    if (canSpeculate()) prefetchRouteResources(destination)
  }
  const connection = (navigator as Navigator & { connection?: Connection }).connection
  if (connection?.saveData || /^(slow-)?2g$/.test(connection?.effectiveType ?? '')) return
  if (event instanceof PointerEvent && event.type === 'pointerdown' && event.button !== 0) return
  if (event instanceof PointerEvent && event.type === 'pointerover' && event.relatedTarget instanceof Node && el.contains(event.relatedTarget)) return
  cancelHover()
  const warm = () => {
    const url = new URL(el.href, location.href)
    void prefetchRoute(url.pathname + url.search)
  }
  // Crossing the navigation is not intent; focus and pointer-down are.
  if (event.type === 'pointerover') hoverTimer = window.setTimeout(warm, 90)
  else warm()
}
function pointerOut(event: PointerEvent) {
  const el = intentLink(event)
  if (el && (!(event.relatedTarget instanceof Node) || !el.contains(event.relatedTarget))) cancelHover()
}
function keyboardActivate(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const el = intentLink(event)
  if (!el) return
  const destination = routeDestination(el)
  announceNavigationIntent(destination)
  if (canSpeculate()) prefetchRouteResources(destination)
}
function click(event: MouseEvent) {
  const el = event.target instanceof Element ? event.target.closest('button,a[href],summary') : null
  if (!el || el.matches('[data-interface-sound-toggle],:disabled,[aria-disabled="true"]')) return
  playInterfaceTone(el.matches('.btn-danger,[data-tone="danger"]') ? 'warning' : el.matches('.btn-primary') ? 'confirm' : 'tap')
}
onMounted(() => {
  document.addEventListener('pointerover', prefetch, { passive: true })
  document.addEventListener('pointerout', pointerOut, { passive: true })
  document.addEventListener('focusin', prefetch)
  document.addEventListener('pointerdown', prefetch, { passive: true })
  document.addEventListener('keydown', keyboardActivate)
  document.addEventListener('click', click)
})
onUnmounted(() => {
  cancelHover()
  document.removeEventListener('pointerover', prefetch)
  document.removeEventListener('pointerout', pointerOut)
  document.removeEventListener('focusin', prefetch)
  document.removeEventListener('pointerdown', prefetch)
  document.removeEventListener('keydown', keyboardActivate)
  document.removeEventListener('click', click)
})
</script>
<style scoped>
.route-loader { position: fixed; z-index: var(--z-toast); inset: 0 0 auto; height: 2px; pointer-events: none; overflow: hidden; opacity: 0; transition: opacity var(--motion-hover) ease; }
.route-loader.active { opacity: 1; }
.route-loader i { display: block; width: 35%; height: 100%; background: var(--accent); transform: translateX(-110%); }
.route-loader.active i { animation: route-progress 1.2s ease-in-out infinite; }
@keyframes route-progress { to { transform: translateX(390%); } }
@media (prefers-reduced-motion: reduce) { .route-loader { display: none; } }
</style>
