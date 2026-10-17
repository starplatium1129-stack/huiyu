<template>
  <component :is="panel" v-if="panel" :initial-source="source" :initial-trigger="trigger" :initial-path="initialPath" :initial-close-request="initialCloseRequest" />
  <Teleport to="body">
    <section v-if="pending" ref="feedback" class="search-entry-status" role="region" aria-label="搜索准备">
      <ArchiveIcon :name="failed ? 'warning' : 'search'" />
      <div><strong>画室搜索</strong><p :role="failed ? 'alert' : 'status'">{{ failed ? (retried ? '搜索仍未加载，请检查连接后重新载入应用。' : '搜索暂时无法加载，请重新读取。') : '正在准备搜索…' }}</p></div>
      <button v-if="failed" class="btn btn-ghost btn-sm" type="button" @click="retry">{{ retried ? '重新载入应用' : '重新读取' }}</button>
      <button ref="cancelButton" class="btn btn-quiet btn-icon" type="button" aria-label="取消打开搜索" @click="cancelPending(true)"><ArchiveIcon name="close" /></button>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, shallowRef, watch } from 'vue'
import type { Component, ShallowRef } from 'vue'
import { useRoute } from 'vue-router'
import { openGlobalSearch, useGlobalSearchRequest } from '@/composables/useGlobalSearch'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'

// Keep shortcuts available without loading the search UI, index and styles on every page.
const panel: ShallowRef<Component | null> = shallowRef(null)
const source = shallowRef<'keyboard' | 'pointer'>('pointer')
const trigger = shallowRef<HTMLElement | null>(null)
const initialPath = shallowRef(''), feedback = shallowRef<HTMLElement | null>(null), cancelButton = shallowRef<HTMLButtonElement | null>(null)
const initialCloseRequest = shallowRef(0)
const { openRequest, openSource, closeRequest } = useGlobalSearchRequest()
const route = useRoute()
type Opening = { source: 'keyboard' | 'pointer'; trigger: HTMLElement | null; path: string }
const pending = shallowRef<Opening | null>(null), failed = shallowRef(false), retried = shallowRef(false)
let disposed = false, download: Promise<Component> | null = null
let loadedPanel: Component | null = null

function modalBlocked() { return !!document.querySelector('dialog:modal') || !!document.activeElement?.closest('[aria-modal="true"]') }
function cancelPending(restore = false) {
  const opening = pending.value, owned = feedback.value?.contains(document.activeElement)
  pending.value = null
  const origin = opening?.trigger
  if (restore && owned && opening?.path === route.fullPath && origin?.isConnected
    && !origin.closest('[inert], [hidden]') && origin.getClientRects().length) origin.focus({ preventScroll: true })
}
async function loadPanel(opening: Opening) {
  try {
    const loaded = loadedPanel ?? await (download ??= import('./GlobalSearch.vue').then(module => loadedPanel = module.default)
      .catch(error => { download = null; throw error }))
    if (disposed || pending.value !== opening || route.fullPath !== opening.path) return
    const active = document.activeElement
    if (modalBlocked() || active !== document.body && active !== opening.trigger && !feedback.value?.contains(active)) { cancelPending(); return }
    panel.value = loaded; pending.value = null
  } catch {
    if (!disposed && pending.value === opening && route.fullPath === opening.path) failed.value = true
  }
}
function startOpening(origin = document.activeElement instanceof HTMLElement ? document.activeElement : null) {
  if (panel.value || disposed || modalBlocked()) return
  if (pending.value && origin && feedback.value?.contains(origin)) origin = pending.value.trigger
  const opening: Opening = { source: openSource.value, trigger: origin, path: route.fullPath }
  source.value = opening.source; trigger.value = origin; initialPath.value = opening.path
  initialCloseRequest.value = closeRequest.value
  pending.value = opening
  if (!failed.value) void loadPanel(opening)
  if (opening.source === 'keyboard') void nextTick(() => {
    if (pending.value === opening && document.activeElement === origin) cancelButton.value?.focus({ preventScroll: true })
  })
}
function retry() {
  if (disposed || !pending.value || !failed.value) return
  if (retried.value) { window.location.reload(); return }
  cancelButton.value?.focus({ preventScroll: true })
  retried.value = true; failed.value = false
  void loadPanel(pending.value)
}

watch(openRequest, () => startOpening(), { flush: 'sync' })
watch(closeRequest, () => cancelPending(), { flush: 'sync' })
watch(() => route.fullPath, () => cancelPending(), { flush: 'sync' })
function onKeydown(event: KeyboardEvent) {
  if (panel.value || event.isComposing || event.keyCode === 229) return
  const toggle = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'
  if (pending.value && (event.key === 'Escape' || toggle) && !event.repeat) {
    const restore = !event.defaultPrevented && !modalBlocked()
    cancelPending(restore)
    if (restore) event.preventDefault()
    return
  }
  if (event.defaultPrevented) return
  const target = event.target as HTMLElement | null
  const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '') || target?.isContentEditable === true
  if (toggle || (event.key === '/' && !isInput)) {
    event.preventDefault()
    // Keep modal keyboard ownership and avoid downloading a search the user cannot reach.
    if (modalBlocked()) return
    if (event.repeat) return
    openGlobalSearch('keyboard')
  }
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  disposed = true
  cancelPending()
  document.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.search-entry-status { position:fixed; z-index:var(--z-overlay); top:calc(var(--desktop-chrome-height,0px) + var(--app-navigation-height,80px) + var(--s-3)); right:var(--s-4); display:flex; align-items:center; gap:var(--s-3); width:min(440px,calc(100vw - 2 * var(--s-4))); padding:var(--s-3); border:1px solid var(--border-strong); border-radius:var(--r-lg); background:var(--bg-surface); color:var(--text-primary); box-shadow:var(--shadow-lg); }
.search-entry-status > .archive-icon { width:24px; height:24px; flex:none; color:var(--accent); }
.search-entry-status > div { flex:1; min-width:0; }
.search-entry-status strong { font:600 var(--fs-label)/var(--lh-label) var(--font-sans); }
.search-entry-status p { margin:var(--s-1) 0 0; color:var(--text-secondary); font-size:var(--fs-label-xs); line-height:var(--lh-body); overflow-wrap:anywhere; }
.search-entry-status > button { flex:none; }
</style>
