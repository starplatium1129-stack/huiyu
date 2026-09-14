<template><div class="route-loader" :class="{ active: loading }" aria-hidden="true"><i></i></div></template>
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { prefetchRoute } from '@/router'
import { useSceneStore } from '@/stores/sceneStore'
import { playInterfaceTone } from '@/composables/useInterfaceFeedback'
import { prefersReducedMotion } from '@/utils/motionPreference'
const router = useRouter()
const store = useSceneStore()
const loading = ref(false)
const prefetched = new Set<string>()
let timer = 0
let media: MediaQueryList | null = null
let before: (() => void) | undefined
let after: (() => void) | undefined
let error: (() => void) | undefined
function finish() { clearTimeout(timer); loading.value = false }
function motionChanged() { if (prefersReducedMotion()) finish() }
function prefetch(event: Event) {
  const el = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
  if (!el || el.target === '_blank') return
  const url = new URL(el.href, location.href)
  if (url.origin !== location.origin || url.pathname === location.pathname || prefetched.has(url.pathname)) return
  prefetched.add(url.pathname)
  prefetchRoute(url.pathname + url.search)
  if (['/scene-explorer', '/prompt-builder', '/showcase', '/character'].includes(url.pathname) && !store.loaded) void store.load()
}
function click(event: MouseEvent) {
  const el = event.target instanceof Element ? event.target.closest('button,a[href],summary') : null
  if (!el || el.matches('[data-interface-sound-toggle],:disabled,[aria-disabled="true"]')) return
  playInterfaceTone(el.matches('.btn-danger,[data-tone="danger"]') ? 'warning' : el.matches('.btn-primary') ? 'confirm' : 'tap')
}
onMounted(() => {
  media = matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', motionChanged)
  window.addEventListener('atelier:motion-preference', motionChanged)
  document.addEventListener('pointerover', prefetch, { passive: true })
  document.addEventListener('focusin', prefetch)
  document.addEventListener('pointerdown', prefetch, { passive: true })
  document.addEventListener('click', click)
  before = router.beforeEach(() => { finish(); if (!prefersReducedMotion()) timer = window.setTimeout(() => { loading.value = !prefersReducedMotion() }, 180) })
  after = router.afterEach(finish)
  error = router.onError(finish)
})
onUnmounted(() => { finish(); before?.(); after?.(); error?.(); media?.removeEventListener('change', motionChanged); window.removeEventListener('atelier:motion-preference', motionChanged); document.removeEventListener('pointerover', prefetch); document.removeEventListener('focusin', prefetch); document.removeEventListener('pointerdown', prefetch); document.removeEventListener('click', click) })
</script>
<style scoped>
.route-loader { position: fixed; z-index: var(--z-toast); inset: 0 0 auto; height: 2px; pointer-events: none; overflow: hidden; opacity: 0; transition: opacity .2s ease; }
.route-loader.active { opacity: 1; }
.route-loader i { display: block; width: 35%; height: 100%; background: var(--accent); transform: translateX(-110%); }
.route-loader.active i { animation: route-progress 1.2s ease-in-out infinite; }
@keyframes route-progress { to { transform: translateX(390%); } }
</style>
