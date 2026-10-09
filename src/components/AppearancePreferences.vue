<template>
  <button v-if="!hideTriggers" class="appearance-entry" type="button" @click="launch('appearance')"><ArchiveIcon name="palette" />外观与动态效果</button>
  <button v-if="!hideTriggers" class="appearance-entry" type="button" @click="launch('keyboard')"><ArchiveIcon name="gear" />键盘快捷键 <kbd>F1</kbd></button>
  <AppearancePreferencesPanel v-if="request && !launcherOnly" :request="request" @ready="onPanelReady" />
</template>

<script lang="ts">
export interface AppearanceRequest {
  section: 'appearance' | 'keyboard'
  keyboard: boolean
  trigger: HTMLElement | null
}
</script>

<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, shallowRef } from 'vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import { desktopShortcutAllowed, usableFocus } from '@/composables/useDesktopInteraction'
const AppearancePreferencesPanel = defineAsyncComponent(() => import('./AppearancePreferencesPanel.vue'))
const props = withDefaults(defineProps<{ launcherOnly?: boolean; hideTriggers?: boolean }>(), { launcherOnly: false, hideTriggers: false })
const emit = defineEmits<{ open: [] }>()
const request = shallowRef<AppearanceRequest>()
let keyboardInput = false
let panelReady = false
function onPanelReady() { panelReady = true }
function launch(section: AppearanceRequest['section']) {
  window.dispatchEvent(new CustomEvent('atelier:appearance-open', { detail: { section } }))
  emit('open')
}
function open(section: AppearanceRequest['section']) {
  // Capture intent and its focus origin before the lazy panel or closing menu settles.
  request.value = { section, keyboard: keyboardInput, trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null }
}
function keyboardHelp() { keyboardInput = true; open('keyboard') }
function appearanceOpen(event: Event) { open((event as CustomEvent).detail?.section === 'keyboard' ? 'keyboard' : 'appearance') }
function keyboard(event: KeyboardEvent) {
  keyboardInput = true
  if (event.key !== 'Escape' || !desktopShortcutAllowed(event) || panelReady || !request.value) return
  const trigger = request.value.trigger
  request.value = undefined
  event.preventDefault()
  const fallback = document.querySelector<HTMLElement>('.nav-more-trigger')
  ;(usableFocus(trigger) ? trigger : usableFocus(fallback) ? fallback : document.querySelector<HTMLElement>('.nav-menu-toggle'))?.focus({ preventScroll: true })
}
function pointer() { keyboardInput = false }
onMounted(() => {
  if (props.launcherOnly) return
  window.addEventListener('atelier:keyboard-help', keyboardHelp)
  window.addEventListener('atelier:appearance-open', appearanceOpen)
  window.addEventListener('keydown', keyboard, true)
  window.addEventListener('pointerdown', pointer, true)
})
onUnmounted(() => {
  if (props.launcherOnly) return
  window.removeEventListener('atelier:keyboard-help', keyboardHelp)
  window.removeEventListener('atelier:appearance-open', appearanceOpen)
  window.removeEventListener('keydown', keyboard, true)
  window.removeEventListener('pointerdown', pointer, true)
})
</script>

<style>
@reference "../assets/css/tailwind.css";
.appearance-entry { @apply tw:flex tw:items-center tw:gap-s-2; grid-column: 1 / -1; @apply tw:p-s-3; border: 0; @apply tw:rounded-md; background: transparent; @apply tw:text-secondary; font: inherit; @apply tw:text-left tw:cursor-pointer; }
.appearance-entry:hover { background: var(--accent-soft); @apply tw:text-accent; }
.appearance-entry kbd { margin-inline-start: auto; }
</style>
