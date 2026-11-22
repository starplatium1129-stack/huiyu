<template>
  <div class="route-loader" :class="{ active: loading }" aria-hidden="true"><i></i></div>
  <span class="sr-only" role="status" aria-label="页面加载状态" aria-live="polite" aria-atomic="true">{{ loading ? '正在打开页面…' : '' }}</span>
</template>
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { announceNavigationIntent, useNavigationFeedback } from '@/composables/useNavigationFeedback'
import { playInterfaceTone } from '@/composables/useInterfaceFeedback'

const { loading } = useNavigationFeedback()

function announceLink(event: Event) {
  const el = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
  if (!el || (el.target && el.target.toLowerCase() !== '_self') || el.hasAttribute('download')) return
  const url = new URL(el.href, location.href)
  if (url.origin !== location.origin || url.href === location.href) return
  announceNavigationIntent(import.meta.env.MODE === 'desktop' ? url.hash.slice(1) || '/' : `${url.pathname}${url.search}${url.hash}`)
}
// Show press feedback immediately. Let the selected route load its own code
// and catalogs, so moving across links or focusing a newly opened menu is cheap.
function pointerActivate(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return
  announceLink(event)
}
function keyboardActivate(event: KeyboardEvent) {
  // Space scrolls a native link; modified Enter belongs to another browsing context.
  if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return
  announceLink(event)
}
function click(event: MouseEvent) {
  const el = event.target instanceof Element ? event.target.closest('button,a[href],summary') : null
  if (!el || el.matches('[data-interface-sound-toggle],:disabled,[aria-disabled="true"]')) return
  playInterfaceTone(el.matches('.btn-danger,[data-tone="danger"]') ? 'warning' : el.matches('.btn-primary') ? 'confirm' : 'tap')
}
onMounted(() => {
  document.addEventListener('pointerdown', pointerActivate, { passive: true })
  document.addEventListener('keydown', keyboardActivate)
  document.addEventListener('click', click)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', pointerActivate)
  document.removeEventListener('keydown', keyboardActivate)
  document.removeEventListener('click', click)
})
</script>
<style scoped>
@reference "../assets/css/tailwind.css";
.route-loader { @apply tw:fixed; z-index: var(--z-toast); inset: 0 0 auto; @apply tw:h-[2px] tw:pointer-events-none tw:overflow-hidden; opacity: 0; transition: opacity var(--motion-hover) ease; }
.route-loader.active { opacity: 1; }
.route-loader i { @apply tw:block tw:w-[35%] tw:h-full; background: var(--accent); transform: translateX(-110%); }
.route-loader.active i { animation: route-progress 1.2s ease-in-out infinite; }
@keyframes route-progress { to { transform: translateX(390%); } }
/* Keep the pending-route signal visible when motion is reduced. */
:root:is([data-motion='reduce'],[data-motion='reduced'],[data-reduced-motion='true']) .route-loader i { animation:none; width:100%; transform:none; }
@media (prefers-reduced-motion: reduce) { :root:not([data-motion='full']) .route-loader i { animation:none; width:100%; transform:none; } }
</style>
