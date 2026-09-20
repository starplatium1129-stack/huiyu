<template>
  <component :is="panel" v-if="panel" :initial-source="source" :initial-trigger="trigger" />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef, watch } from 'vue'
import type { Component, ShallowRef } from 'vue'
import { openGlobalSearch, useGlobalSearchRequest } from '@/composables/useGlobalSearch'
import { useToast } from '@/composables/useToast'

// Keep shortcuts available without loading the search UI, index and styles on every page.
const panel: ShallowRef<Component | null> = shallowRef(null)
const source = shallowRef<'keyboard' | 'pointer'>('pointer')
const trigger = shallowRef<HTMLElement | null>(null)
const { openRequest, openSource } = useGlobalSearchRequest()
const toast = useToast()
let loading = false, disposed = false
let pendingOpen = false
let loadedPanel: Component | null = null

async function loadPanel() {
  if (panel.value || disposed) return
  source.value = openSource.value
  trigger.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
  pendingOpen = true
  if (loadedPanel) { panel.value = loadedPanel; return }
  if (loading) return
  loading = true
  try {
    const loaded = await import('./GlobalSearch.vue')
    loadedPanel = loaded.default
    if (!disposed && pendingOpen) panel.value = loadedPanel
  } catch {
    if (!disposed && pendingOpen) toast.error('搜索暂时无法加载，请重试。')
    pendingOpen = false
  } finally { loading = false }
}

watch(openRequest, () => { void loadPanel() }, { flush: 'sync' })
function onKeydown(event: KeyboardEvent) {
  if (panel.value || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
  if (event.key === 'Escape' && pendingOpen) { event.preventDefault(); pendingOpen = false; return }
  const target = event.target as HTMLElement | null
  const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '') || target?.isContentEditable === true
  if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') || (event.key === '/' && !isInput)) {
    event.preventDefault()
    if (event.repeat) return
    if (pendingOpen && event.key.toLowerCase() === 'k') pendingOpen = false
    else openGlobalSearch('keyboard')
  }
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  disposed = true
  document.removeEventListener('keydown', onKeydown)
})
</script>
