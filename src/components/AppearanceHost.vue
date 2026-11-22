<template>
  <component :is="panel" v-if="panel" ref="preferences" hide-triggers />
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, shallowRef, type Component } from 'vue'
import { useRoute } from 'vue-router'
import { useToast } from '@/composables/useToast'

type Section = 'appearance' | 'keyboard'
const panel = shallowRef<Component>()
const preferences = ref<{ open: (section: Section, trigger: HTMLElement | null) => void }>()
const route = useRoute()
const toast = useToast()
let download: Promise<{ default: Component }> | undefined
let revision = 0
let disposed = false

async function open(section: Section) {
  const path = route.fullPath
  const current = ++revision
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  try {
    download ??= import('./AppearancePreferences.vue').catch(error => { download = undefined; throw error })
    const component = await download
    if (disposed || current !== revision || route.fullPath !== path) return
    panel.value = component.default
    await nextTick()
    if (!disposed && current === revision && route.fullPath === path) preferences.value?.open(section, trigger)
  } catch {
    if (!disposed && current === revision) toast.warning('外观设置暂时无法打开，请重试。')
  }
}
function appearance(event: Event) { void open((event as CustomEvent).detail?.section === 'keyboard' ? 'keyboard' : 'appearance') }
function keyboardHelp() { void open('keyboard') }
function cancel(event: KeyboardEvent) { if (!panel.value && event.key === 'Escape') revision++ }
onMounted(() => {
  window.addEventListener('atelier:appearance-open', appearance)
  window.addEventListener('atelier:keyboard-help', keyboardHelp)
  window.addEventListener('keydown', cancel)
})
onUnmounted(() => {
  disposed = true
  window.removeEventListener('atelier:appearance-open', appearance)
  window.removeEventListener('atelier:keyboard-help', keyboardHelp)
  window.removeEventListener('keydown', cancel)
})
</script>
